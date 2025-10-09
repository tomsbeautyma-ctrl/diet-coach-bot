import express from "express";
import { Client, middleware as lineMiddleware } from "@line/bot-sdk";
import OpenAI from "openai";

const app = express();

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new Client(lineConfig);
const ai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL,
});

app.get("/", (req, res) => {
  res.send("✅ Diet Coach Bot server is running!");
});

app.post("/line/webhook", lineMiddleware(lineConfig), async (req, res) => {
  const events = req.body.events;
  for (const event of events) {
    if (event.type !== "message" || event.message.type !== "text") continue;

    const userMsg = event.message.text;

    const aiRes = await ai.chat.completions.create({
      model: "meta-llama/Meta-Llama-3.1-70B-Instruct",
      messages: [{ role: "user", content: userMsg }],
      max_tokens: 300,
    });

    const replyText = aiRes.choices[0].message.content.trim();

    await client.replyMessage(event.replyToken, {
      type: "text",
      text: replyText,
    });
  }
  res.status(200).end();
});

app.listen(process.env.PORT || 3000, () => {
  console.log("🚀 Server started on port", process.env.PORT || 3000);
});
