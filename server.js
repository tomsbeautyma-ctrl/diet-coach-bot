// server.js — ESM ("type": "module")
// deps: express, @line/bot-sdk, openai, ioredis

import express from "express";
import { Client, middleware as lineMW } from "@line/bot-sdk";
import OpenAI from "openai";
import Redis from "ioredis";

const PORT = Number(process.env.PORT || 10000);

// ====== Redis接続 ======
const redis = new Redis(process.env.UPSTASH_REDIS_REST_URL, {
  password: process.env.UPSTASH_REDIS_REST_TOKEN,
});

redis.on("connect", () => console.log("✅ Redis connected"));
redis.on("error", (err) => console.error("❌ Redis error:", err));

// ====== LINE設定 ======
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "",
};
const lineClient = new Client(lineConfig);

// ====== DeepInfra (OpenAI互換API) ======
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
  baseURL: process.env.OPENAI_BASE_URL, // 例: https://api.deepinfra.com/v1/openai
});

// ====== Express設定 ======
const app = express();
app.use(express.json());
app.get("/", (_req, res) => res.status(200).send("alive"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ====== 購入登録API（STORES注文番号とLINEユーザーIDを紐づけ） ======
app.post("/register", async (req, res) => {
  try {
    const { userId, orderNumber, days } = req.body; // 例: { userId: "Uxxx", orderNumber: "123456789", days: 30 }

    if (!userId || !orderNumber)
      return res.status(400).json({ ok: false, msg: "userIdまたはorderNumberが未入力です。" });

    const key = `sub:${userId}`;
    const expireAt = Date.now() + (days || 30) * 24 * 60 * 60 * 1000;

    await redis.set(key, JSON.stringify({ orderNumber, expireAt }), "PX", (days || 30) * 86400000);

    res.json({ ok: true, msg: `登録完了。期限: ${new Date(expireAt).toLocaleString()}` });
  } catch (e) {
    console.error("❌ /register error:", e);
    res.status(500).json({ ok: false, msg: e.message });
  }
});

// ====== 有効期限チェック関数 ======
async function checkSubscription(userId) {
  const key = `sub:${userId}`;
  const data = await redis.get(key);
  if (!data) return false;
  const parsed = JSON.parse(data);
  return parsed.expireAt > Date.now();
}

// ====== Webhook（LINEメッセージ受信） ======
app.post("/webhook/line", lineMW(lineConfig), async (req, res) => {
  try {
    const events = req.body?.events || [];

    await Promise.all(
      events.map(async (event) => {
        if (event.type !== "message") return;

        const userId = event.source?.userId;
        const isActive = await checkSubscription(userId);

        // 有効期限が切れている場合
        if (!isActive) {
          await lineClient.replyMessage(event.replyToken, {
            type: "text",
            text:
              "🕒 ご利用期限が切れています。\nSTORESで再購入後に「注文番号」を送信してください✨",
          });
          return;
        }

        // ---------- 画像（骨格診断） ----------
        if (event.message.type === "image") {
          const stream = await lineClient.getMessageContent(event.message.id);
          const chunks = [];
          for await (const chunk of stream) chunks.push(chunk);
          const base64 = "data:image/jpeg;base64," + Buffer.concat(chunks).toString("base64");

          const result = await ai.chat.completions.create({
            model: "meta-llama/Meta-Llama-3.2-90B-Vision-Instruct",
            messages: [
              {
                role: "system",
                content:
                  "あなたは日本語で答える骨格診断AIです。"
                  + "写真からストレート・ウェーブ・ナチュラルの傾向を分析し、"
                  + "似合う服装・素材・シルエットを簡潔に提案してください。",
              },
              {
                role: "user",
                content: [
                  { type: "text", text: "この人の骨格タイプを診断してください。" },
                  { type: "image_url", image_url: base64 },
                ],
              },
            ],
          });

          const reply =
            result?.choices?.[0]?.message?.content?.trim() ||
            "診断に失敗しました。もう一度送信してください📸";
          await lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
          return;
        }

        // ---------- テキスト：食事診断 or 通常応答 ----------
        if (event.message.type === "text") {
          const text = (event.message.text || "").trim();

          // 🔹注文番号登録
          if (/^\d{6,10}$/.test(text)) {
            const key = `sub:${userId}`;
            const expireAt = Date.now() + 30 * 86400000;
            await redis.set(key, JSON.stringify({ orderNumber: text, expireAt }), "PX", 30 * 86400000);

            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: `🔑 注文番号 ${text} を登録しました。\n30日間利用可能です✨`,
            });
            return;
          }

          // 🔹食事レポート（自動判定）
          const isMeal = /ごはん|食べた|朝食|昼食|夕食|ランチ|ディナー|食事/i.test(text);
          if (isMeal) {
            const result = await ai.chat.completions.create({
              model: "meta-llama/Meta-Llama-3.1-70B-Instruct",
              messages: [
                {
                  role: "system",
                  content:
                    "あなたは日本語の栄養士AIです。食事内容からバランスとアドバイスを4〜6行で優しく伝えてください。",
                },
                { role: "user", content: text },
              ],
              temperature: 0.5,
              max_tokens: 500,
            });

            const reply =
              result?.choices?.[0]?.message?.content?.trim() ||
              "内容をうまく解析できませんでした。もう一度お願いします🍎";
            await lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
            return;
          }

          // 🔹通常のダイエット・美容サポート
          const result = await ai.chat.completions.create({
            model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
            messages: [
              {
                role: "system",
                content: "You are a supportive Japanese fitness & styling assistant.",
              },
              { role: "user", content: text },
            ],
            temperature: 0.4,
            max_tokens: 400,
          });

          const reply =
            result?.choices?.[0]?.message?.content?.trim() ||
            "うまく応答できませんでした。もう一度お願いします。";
          await lineClient.replyMessage(event.replyToken, { type: "text", text: reply });
        }
      })
    );

    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).end();
  }
});

// ====== 起動 ======
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
