// server.js — ESM ("type": "module")
// deps: express, @line/bot-sdk, openai, @upstash/redis

import express from "express";
import { Client, middleware as lineMW } from "@line/bot-sdk";
import OpenAI from "openai";
import { Redis } from "@upstash/redis";

const PORT = Number(process.env.PORT || 10000);

// ====== 起動ログ（最低限の自己診断） ======
console.log("🟢 Booting server...");
console.log("ENV:", {
  PORT,
  LINE_TOKEN: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
  LINE_SECRET: !!process.env.LINE_CHANNEL_SECRET,
  OPENAI_KEY: !!process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  UPSTASH_URL: !!process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ====== グローバル例外ロガー ======
process.on("uncaughtException", (e) => console.error("🔥 uncaughtException:", e));
process.on("unhandledRejection", (r, p) => console.error("🔥 unhandledRejection:", r, p));

// ====== Clients ======
const app = express(); // ← グローバルの express.json() は付けない（LINE署名検証保護）

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "",
};
const lineClient = new Client(lineConfig);

const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
  baseURL: process.env.OPENAI_BASE_URL, // 例: https://api.deepinfra.com/v1/openai
});

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ====== Health ======
app.get("/", (_req, res) => res.status(200).send("alive"));
app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/webhook/line", (_req, res) =>
  res.status(200).send("LINE webhook endpoint is alive (POST required).")
);

// ====== 画像取得（LINEメディア） ======
async function fetchLineImageBuffer(messageId) {
  const stream = await lineClient.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ====== 購入番号登録API（必要時のみ：このルートだけJSONパーサを付与） ======
app.post("/register", express.json(), async (req, res) => {
  try {
    const { userId, orderNumber, days = 30 } = req.body || {};
    if (!userId || !orderNumber) {
      return res.status(400).json({ ok: false, msg: "userId と orderNumber は必須です。" });
    }
    const expireAt = Date.now() + days * 86400 * 1000;
    const key = `sub:${userId}`;
    await redis.set(key, { orderNumber, expireAt }, { ex: days * 86400 }); // TTL（秒）
    return res.json({ ok: true, expireAt, msg: "登録しました。" });
  } catch (e) {
    console.error("/register error:", e);
    return res.status(500).json({ ok: false, msg: e.message });
  }
});

// ====== サブスク有効判定 ======
async function isActive(userId) {
  const data = await redis.get(`sub:${userId}`);
  if (!data) return false;
  const expireAt = data?.expireAt ?? 0;
  return expireAt > Date.now();
}

// ====== LINE Webhook (POST) ======
app.post("/webhook/line", lineMW(lineConfig), async (req, res) => {
  try {
    const events = req.body?.events || [];
    await Promise.all(
      events.map(async (event) => {
        if (event.type !== "message") return;

        const userId = event.source?.userId;

        // ---- 注文番号の即時登録（9〜10桁の数字を想定）----
        if (event.message.type === "text") {
          const text = (event.message.text || "").trim();
          const orderMatch = text.match(/^\d{9,10}$/);
          if (orderMatch) {
            const orderNumber = orderMatch[0];
            const expireAt = Date.now() + 30 * 86400 * 1000;
            await redis.set(`sub:${userId}`, { orderNumber, expireAt }, { ex: 30 * 86400 });
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: `🔑 注文番号 ${orderNumber} を登録しました。\nご利用期限: ${new Date(
                expireAt
              ).toLocaleDateString("ja-JP")}`,
            });
            return;
          }
        }

        // ---- 有効期限のチェック ----
        const active = await isActive(userId);
        if (!active) {
          await lineClient.replyMessage(event.replyToken, {
            type: "text",
            text:
              "🕒 ご利用期限が切れています。\nSTORESでご購入のうえ、9〜10桁の注文番号を送ってください。",
          });
          return;
        }

        // ---------- 画像：骨格診断 ----------
        if (event.message.type === "image") {
          try {
            const buf = await fetchLineImageBuffer(event.message.id);
            const b64 = "data:image/jpeg;base64," + buf.toString("base64");

            const result = await ai.chat.completions.create({
              model: "meta-llama/Meta-Llama-3.2-90B-Vision-Instruct",
              messages: [
                {
                  role: "system",
                  content:
                    "あなたは日本語で答える骨格診断アシスタントです。"
                    + "写真からストレート/ウェーブ/ナチュラルの傾向(%)を推定し、"
                    + "特徴・似合うシルエット/素材・避けたい例を3〜6行で。",
                },
                {
                  role: "user",
                  content: [
                    { type: "text", text: "この人の骨格タイプを診断してください。" },
                    { type: "image_url", image_url: b64 },
                  ],
                },
              ],
              temperature: 0.2,
              max_tokens: 500,
            });

            const reply =
              result?.choices?.[0]?.message?.content?.trim() ||
              "画像を解析できませんでした。もう一度明るい場所で撮影して送ってください📸";
            await lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
          } catch (e) {
            console.error("Vision error:", e);
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: "画像の取得/解析でエラーが起きました。もう一度お願いします🙏",
            });
          }
          return;
        }

        // ---------- テキスト：食事診断 or 通常応答 ----------
        if (event.message.type === "text") {
          const userText = (event.message.text || "").trim();

          // 食事レポートっぽいかどうかを簡易判定
          const isMeal =
            /ごはん|食べた|朝食|昼食|夕食|晩ごはん|メニュー|食事|ランチ|ディナー/i.test(userText);

          if (isMeal) {
            const result = await ai.chat.completions.create({
              model: "meta-llama/Meta-Llama-3.1-70B-Instruct",
              messages: [
                {
                  role: "system",
                  content:
                    "あなたは日本語の栄養士AIです。食事内容から、"
                    + "①PFCや栄養バランスの所感 ②ざっくりカロリー ③次の食事への改善提案 ④励ましの一言 "
                    + "を4〜6行で具体的に伝えてください。",
                },
                { role: "user", content: userText },
              ],
              temperature: 0.5,
              max_tokens: 600,
            });

            const reply =
              result?.choices?.[0]?.message?.content?.trim() ||
              "食事内容をうまく解析できませんでした。もう一度お送りください🍎";
            await lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
            return;
          }

          // 通常のサポート
          const result = await ai.chat.completions.create({
            model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
            messages: [
              { role: "system", content: "You are a supportive Japanese fitness & styling assistant." },
              { role: "user", content: userText },
            ],
            temperature: 0.4,
            max_tokens: 500,
          });

          const reply =
            result?.choices?.[0]?.message?.content?.trim() ||
            "うまく生成できませんでした。もう一度お願いします。";
          await lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
        }
      })
    );

    res.status(200).end(); // 再送防止
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).end();
  }
});

// ====== Listen ======
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
