// server.js  —— CommonJS版（ESMは使いません）

const express = require("express");
const { Client, middleware: lineMW } = require("@line/bot-sdk");
const OpenAI = require("openai"); // DeepInfra(OpenAI互換)SDK

const PORT = process.env.PORT || 10000;

// ====== App ======
const app = express();
// ※ グローバルの app.use(express.json()) は入れない
//    （LINE署名検証に raw body が必要なため。必要なら別ルートで個別に付けてください）

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
  apiKey: process.env.OPENAI_API_KEY,       // DeepInfraのAPIキー
  baseURL: process.env.OPENAI_BASE_URL,     // https://api.deepinfra.com/v1/openai
});

// ====== デバッグ用: GETでも生存確認ができるようにする ======
app.get("/webhook/line", (_req, res) => {
  res
    .status(200)
    .send("LINE webhook endpoint is alive (POST from LINE required).");
});

// ====== 本番: LINE Webhook (POST専用) ======
app.post("/webhook/line", lineMW(lineConfig), async (req, res) => {
  try {
    const events = req.body?.events || [];
    // すべてのイベントを処理（最低限の実装）
    await Promise.all(
      events.map(async (event) => {
        if (event.type !== "message" || event.message.type !== "text") return;

        const userText = (event.message.text || "").trim();

        // ここでDeepInfraに質問（必要ならモデル名を軽いものへ）
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
          "うまく考えがまとまりませんでした。もう一度お願いします。";

        await lineClient.replyMessage(event.replyToken, [
          { type: "text", text: reply },
        ]);
      })
    );

    // ★必ず200を返す（LINE側はこれを期待）
    res.status(200).end();
  } catch (err) {
    console.error("Webhook error:", err);
    // 署名エラーなどでも200を返すのが無難（LINEの再送を防ぐ）
    res.status(200).end();
  }
});

// ====== DeepInfra 単体テスト用（GETでOK） ======
app.get("/test/ai", async (_req, res) => {
  try {
    const r = await ai.chat.completions.create({
      model: "meta-llama/Meta-Llama-3.1-8B-Instruct",
      messages: [{ role: "user", content: "接続テストです。1行で返答して。" }],
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
