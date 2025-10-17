// server.js — ESM ("type": "module")
// deps: express, @line/bot-sdk, openai

import express from "express";
import { Client, middleware as lineMW } from "@line/bot-sdk";
import OpenAI from "openai";

const PORT = Number(process.env.PORT || 10000);

// ====== 安全のためのグローバル例外ロガー ======
process.on("uncaughtException", (err) => console.error("🔥 uncaughtException:", err));
process.on("unhandledRejection", (reason, p) =>
  console.error("🔥 unhandledRejection at:", p, "reason:", reason)
);

// ====== 起動ログ（ENVチェック） ======
console.log("🟢 Booting server...");
console.log("ENV CHECK:", {
  PORT,
  HAS_LINE_ACCESS_TOKEN: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
  HAS_LINE_SECRET: Boolean(process.env.LINE_CHANNEL_SECRET),
  HAS_OPENAI_KEY: Boolean(process.env.OPENAI_API_KEY),
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
});

// ====== App ======
const app = express(); // ※ express.json() は付けない（LINE署名検証を壊さない）

// Health
app.get("/", (_req, res) => res.status(200).send("alive"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ====== LINE SDK ======
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  channelSecret: process.env.LINE_CHANNEL_SECRET || "",
};
const lineClient = new Client(lineConfig);

// ====== DeepInfra (OpenAI 互換) ======
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "",
  baseURL: process.env.OPENAI_BASE_URL, // 例: https://api.deepinfra.com/v1/openai
});

// Debug GET
app.get("/webhook/line", (_req, res) =>
  res.status(200).send("LINE webhook endpoint is alive (POST required).")
);

// 画像取得ヘルパ
async function fetchLineImageBuffer(messageId) {
  const stream = await lineClient.getMessageContent(messageId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ====== Webhook (POST) ======
app.post("/webhook/line", lineMW(lineConfig), async (req, res) => {
  try {
    const events = req.body?.events || [];
    console.log(`📩 Received ${events.length} events`);

    await Promise.all(
      events.map(async (event) => {
        if (event.type !== "message") return;

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
          return; // 画像はここで終了
        }

        // ---------- テキスト：食事診断 or 通常応答 ----------
        if (event.message.type === "text") {
          const userText = (event.message.text || "").trim();

          // ざっくり食事レポート判定（必要なら語彙を足してください）
          const isMealReport = /ごはん|食べた|朝食|昼食|夕食|晩ごはん|メニュー|食事|ランチ|ディナー/i.test(
            userText
          );

          if (isMealReport) {
            const result = await ai.chat.completions.create({
              model: "meta-llama/Meta-Llama-3.1-70B-Instruct",
              messages: [
                {
                  role: "system",
                  content:
                    "あなたは日本語の栄養士AIです。入力された食事内容をもとに、"
                    + "①バランス（糖質・脂質・たんぱく質・ビタミンなど）"
                    + "②摂取カロリー目安（ざっくり）"
                    + "③改善アドバイス（次の食事で足りない栄養素を補う）"
                    + "④一言モチベUPコメント"
                    + "を4〜6行でやさしく具体的に伝えてください。",
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
            return; // 通常応答に落とさない
          }

          // 通常のダイエットサポート
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

    res.status(200).end(); // LINEの再送を避ける
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).end();
  }
});

// ====== 単体接続テスト ======
app.get("/test/ai", async (_req, res) => {
  try {
    const r = await ai.chat.completions.create({
      model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      messages: [{ role: "user", content: "接続テスト。1行で返答して。" }],
      max_tokens: 40,
    });
    res.json({ ok: true, text: r.choices?.[0]?.message?.content ?? "" });
  } catch (e) {
    console.error("❌ /test/ai error:", e);
    res.status(500).json({ ok: false, name: e.name, message: e.message });
  }
});

// ====== Listen ======
const server = app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
server.on("error", (e) => console.error("❌ server error:", e));
