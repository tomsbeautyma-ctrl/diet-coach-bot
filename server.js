// server.js — ESM ("type": "module")
// 依存: express, @line/bot-sdk, openai

import express from "express";
import { Client, middleware as lineMW } from "@line/bot-sdk";
import OpenAI from "openai";

const PORT = process.env.PORT || 10000;

// ------------------------ 基本セットアップ ------------------------
const app = express();
// ※LINE署名検証のため、グローバルの express.json() は入れない

// Health checks
app.get("/", (_req, res) => res.status(200).send("alive"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// LINE SDK
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new Client(lineConfig);

// DeepInfra (OpenAI互換)
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,         // DeepInfraのAPIキー (hf_...)
  baseURL: process.env.OPENAI_BASE_URL,       // 例: https://api.deepinfra.com/v1/openai
});

// デバッグ用：GETで疎通確認
app.get("/webhook/line", (_req, res) => {
  res.status(200).send("LINE webhook endpoint is alive (POST required).");
});

// ------------------------ 画像取得ヘルパ ------------------------
async function fetchLineImageBuffer(messageId) {
  const stream = await lineClient.getMessageContent(messageId); // Readable
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ------------------------ Webhook (POST) ------------------------
app.post("/webhook/line", lineMW(lineConfig), async (req, res) => {
  try {
    const events = req.body?.events || [];

    await Promise.all(
      events.map(async (event) => {
        if (event.type !== "message") return;

        // ========== 画像診断 ==========
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
                    "あなたは日本語で答える骨格診断の専門アシスタントです。"
                    + "写真からストレート/ウェーブ/ナチュラルの傾向(%)を推定し、"
                    + "特徴、似合うシルエットと素材、避けたい例を簡潔に3〜6行で答えてください。"
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
              "画像をうまく解析できませんでした。もう一度明るいところで撮影して送ってください📸";

            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: reply,
            });
          } catch (e) {
            console.error("Vision error:", e);
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: "画像の取得/解析でエラーが起きました。もう一度お試しください🙏",
            });
          }
          return; // 画像処理はここで終了
        }

        // ========== テキスト応答 ==========
        if (event.message.type === "text") {
          const userText = (event.message.text || "").trim();

          const result = await ai.chat.completions.create({
            model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
            messages: [
              {
                role: "system",
                content:
                  "You are a supportive Japanese fitness & styling assistant.",
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

    // 必ず 200 を返す（LINEの再送を避ける）
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).end();
  }
});

// ------------------------ 単体テスト用 ------------------------
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

