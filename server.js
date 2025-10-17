// server.js — ESM ("type": "module")
// deps: express, @line/bot-sdk, openai

import express from "express";
import { Client, middleware as lineMW } from "@line/bot-sdk";
import OpenAI from "openai";

const PORT = Number(process.env.PORT || 10000);

// ====== グローバル例外ハンドラ（原因を必ずログ） ======
process.on("uncaughtException", (err) => {
  console.error("🔥 uncaughtException:", err);
});
process.on("unhandledRejection", (reason, p) => {
  console.error("🔥 unhandledRejection at:", p, "reason:", reason);
});

console.log("🟢 Booting server...");
console.log("ENV CHECK:", {
  PORT,
  HAS_LINE_ACCESS_TOKEN: Boolean(process.env.LINE_CHANNEL_ACCESS_TOKEN),
  HAS_LINE_SECRET: Boolean(process.env.LINE_CHANNEL_SECRET),
  HAS_OPENAI_KEY: Boolean(process.env.OPENAI_API_KEY),
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
});

// ====== App ======
const app = express(); // ※ express.json() は付けない（LINE署名のため）

// Health
app.get("/", (_req, res) => res.status(200).send("alive"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ====== Safe init: LINE / OpenAI を try-catch で ======
let lineClient;
let lineConfig;
try {
  lineConfig = {
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
    channelSecret: process.env.LINE_CHANNEL_SECRET || "",
  };
  lineClient = new Client(lineConfig);
  console.log("✅ LINE SDK initialized");
} catch (e) {
  console.error("❌ LINE SDK init failed:", e);
}

let ai;
try {
  ai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY || "",
    baseURL: process.env.OPENAI_BASE_URL, // 例: https://api.deepinfra.com/v1/openai
  });
  console.log("✅ OpenAI(DeepInfra) client initialized");
} catch (e) {
  console.error("❌ OpenAI client init failed:", e);
}

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

// Webhook
app.post("/webhook/line", lineMW(lineConfig), async (req, res) => {
  try {
    const events = req.body?.events || [];
    console.log(`📩 Received ${events.length} events`);

    await Promise.all(
      events.map(async (event) => {
        if (event.type !== "message") return;

        // 画像
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
              "画像を解析できませんでした。もう一度お試しください。";
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: reply,
            });
          } catch (e) {
            console.error("Vision error:", e);
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: "画像の取得/解析でエラーが起きました。もう一度お願いします🙏",
            });
          }
          return;
        }

        // テキスト
        if (event.message.type === "text") {
          const userText = (event.message.text || "").trim();
          const result = await ai.chat.completions.create({
            model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
            messages: [
              {
                role: "system",
                content: "You are a supportive Japanese fitness & styling assistant.",
              },
              { role: "user", content: userText },
            ],
            temperature: 0.4,
            max_tokens: 500,
          });

          const reply =
            result?.choices?.[0]?.message?.content?.trim() ||
            "うまく生成できませんでした。もう一度お願いします。";
          await lineClient.replyMessage(event.replyToken, {
            type: "text",
            text: reply,
          });
        }
      })
    );

    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).end(); // 再送防止
  }
});

// Listen
const server = app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
server.on("error", (e) => console.error("❌ server error:", e));
