import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "secret";

function telegramApi(method) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function sendMessage(chatId, text) {
  await fetch(telegramApi("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;
    const message = update.message;

    if (message && message.text) {
      const chatId = message.chat.id;

      if (message.text === "/start") {
        await sendMessage(chatId, "Selamat datang di toko kamu 🚀");
      } else {
        await sendMessage(chatId, "Pesan kamu diterima: " + message.text);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.log(err);
    res.sendStatus(200);
  }
});

app.get("/", (req, res) => {
  res.send("Bot is running");
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running"));
