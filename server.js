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
        if (event.type !== "message") return;

        // 🖼️ 画像が送られた場合
        if (event.message.type === "image") {
          try {
            const stream = await lineClient.getMessageContent(event.message.id);
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const buffer = Buffer.concat(chunks);

            // 画像をVisionモデルに送る（DeepInfra）
            const aiRes = await ai.chat.completions.create({
              model: "meta-llama/Meta-Llama-3.2-90B-Vision-Instruct",
              messages: [
                {
                  role: "system",
                  content:
                    "あなたは日本語で答える骨格診断AIアドバイザーです。画像をもとに、骨格タイプを（ストレート・ナチュラル・ウェーブ）から判定し、特徴と似合う服装・注意点を簡潔に伝えてください。",
                },
                {
                  role: "user",
                  content: [
                    { type: "text", text: "この人の骨格タイプを診断してください。" },
                    { type: "image_url", image_url: "data:image/jpeg;base64," + buffer.toString("base64") },
                  ],
                },
              ],
              max_tokens: 500,
            });

            const replyText = aiRes.choices[0].message.content.trim();
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: replyText,
            });
          } catch (e) {
            console.error("Vision error:", e);
            await lineClient.replyMessage(event.replyToken, {
              type: "text",
              text: "画像を分析できませんでした。もう一度明るい環境で撮影して送ってみてください📸",
            });
          }
          return;
        }

        // 🗣️ テキスト処理（既存部分）
        if (event.message.type === "text") {
          const userText = (event.message.text || "").trim();
          const aiRes = await ai.chat.completions.create({
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
            aiRes?.choices?.[0]?.message?.content?.trim() ||
            "うまく生成できませんでした。もう一度お願いします。";

          await lineClient.replyMessage(event.replyToken, [
            { type: "text", text: reply },
          ]);
        }
      })
    );

    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(200).end();
  }
});

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

