// server.js  —— ESM 版（"type": "module" 前提）

import express from "express";
import { Client, middleware as lineMW } from "@line/bot-sdk";
import OpenAI from "openai";

const PORT = process.env.PORT || 10000;

// ====== App ======
const app = express();
// ※ グローバルに app.use(express.json()) は入れないでOK
//    （LINEの署名検証に raw body が必要。lineMW が面倒見ます）

// ====== Health & Ping ======
app.get("/", (_req, res) => res.status(200).send("alive"));
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ====== LINE SDK 設定 ======
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const lineClient = new Client(lineConfig);

// ====== OpenAI(DeepInfra) 設定 ======
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,       // DeepInfra の API キー
  baseURL: process.env.OPENAI_BASE_URL,     // 例: https://api.deepinfra.com/v1/openai
});

// ====== デバッグ用（GET でも生存確認できる） ======
app.get("/webhook/line", (_req, res) => {
  res
    .status(200)
    .send("LINE webhook endpoint is alive (POST from LINE required).");
});

// ====== 本番: LINE Webhook (POST) ======
app.post("/webhook/line", lineMW(lineConfig), async (req, res) => {
  try {
    const events = req.body?.events || [];

    await Promise.all(
      events.map(async (event) => {
        if (event.type !== "message" || event.message.type !== "text") return;

        const userText = (event.message.text || "").trim();

        // DeepInfra (OpenAI 互換) に投げる
        const aiRes = await ai.chat.completions.create({
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
          aiRes?.choices?.[0]?.message?.content?.trim() ||
          "うまく生成できませんでした。もう一度お願いします。";

        await lineClient.replyMessage(event.replyToken, [
          { type: "text", text: reply },
        ]);
      })
    );

    // ★必ず200を返す（LINEはこれを期待）
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    // 署名エラー等でも 200 を返し、LINE の再送を避ける
    res.status(200).end();
  }
});

// ====== DeepInfra 単体テスト用 ======
app.get("/test/ai", async (_req, res) => {
  try {
    const r = await ai.chat.completions.create({
      model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      messages: [{ role: "user", content: "接続テスト。1行で返答して。" }],
      max_tokens: 40,
    });
    res.json({ ok: true, text: r.choices?.[0]?.message?.content || "" });
  } catch (e) {
    console.error("❌ /test/ai error:", e);
    res.status(500).json({ ok: false, name: e.name, message: e.message });
  }
});

// ====== Listen ======
app.listen(PORT, () => {
  console.log(`🚀 Server started on port ${PORT}`);
});
