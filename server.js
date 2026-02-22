import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import crypto from "crypto";

const app = express();
app.use(express.json());

/* ================= ENV ================= */

const REQUIRED = [
  "BOT_TOKEN",
  "WEBHOOK_SECRET",
  "ADMIN_CHAT_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "SHEET_ID",
  "PAKASIR_SLUG",
  "PAKASIR_API_KEY",
  "PAKASIR_WEBHOOK_SECRET"
];

for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error("Missing ENV: " + key);
  }
}

const {
  BOT_TOKEN,
  WEBHOOK_SECRET,
  ADMIN_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SHEET_ID,
  PAKASIR_SLUG,
  PAKASIR_API_KEY,
  PAKASIR_WEBHOOK_SECRET
} = process.env;

/* ================= GOOGLE ================= */

const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

async function readSheet(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });
  return res.data.values || [];
}

async function appendTransaksi(row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "TRANSAKSI!A:E",
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

/* ================= TELEGRAM ================= */

async function tg(method, body) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

function rupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function makeInvoice() {
  return "INV" + Date.now() + crypto.randomBytes(2).toString("hex").toUpperCase();
}

/* ================= LIST PRODUK ================= */

async function sendProduk(chatId) {
  const rows = await readSheet("APK NONTON!A2:C");

  const buttons = rows.map((r, i) => ([
    { text: r[0], callback_data: "BUY_" + i }
  ]));

  await tg("sendMessage", {
    chat_id: chatId,
    text: "Pilih produk:",
    reply_markup: { inline_keyboard: buttons }
  });
}

/* ================= CHECKOUT ================= */

async function startCheckout(chatId, username, index) {
  const rows = await readSheet("APK NONTON!A2:C");
  const produk = rows[index];
  if (!produk) return;

  const namaProduk = produk[0];
  const invoice = makeInvoice();

  let harga = 15000;

  if (namaProduk === "DRAKOR ID") harga = 15000;
  if (namaProduk === "APK DRACIN") harga = 20000;
  if (namaProduk === "APK ANIME") harga = 15000;

  const payUrl =
    `https://app.pakasir.com/pay/${PAKASIR_SLUG}/${harga}?order_id=${invoice}`;

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `Invoice: ${invoice}\nProduk: ${namaProduk}\nTotal: ${rupiah(harga)}`,
    reply_markup: {
      inline_keyboard: [[{ text: "Bayar Sekarang", url: payUrl }]]
    }
  });

  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `Order baru:\n${invoice}\n${namaProduk}\n${rupiah(harga)}`
  });
}

/* ================= DELIVERY ================= */

async function deliver(orderId, amount) {
  const rows = await readSheet("APK NONTON!A2:C");

  const produk = rows[0]; // kirim produk pertama (simple mode)
  if (!produk) return;

  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `Pembayaran sukses ${orderId}`
  });

  await appendTransaksi([
    new Date().toISOString(),
    produk[0],
    "-",
    orderId,
    amount
  ]);
}

/* ================= ROUTES ================= */

app.get("/", (req, res) => res.send("OK"));

app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  const update = req.body;

  if (update.message?.text === "/start") {
    await sendProduk(update.message.chat.id);
  }

  if (update.callback_query) {
    const index = Number(update.callback_query.data.replace("BUY_", ""));
    await startCheckout(
      update.callback_query.message.chat.id,
      update.callback_query.from.username,
      index
    );
  }

  res.sendStatus(200);
});

app.post(`/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}`, async (req, res) => {
  const { order_id, amount, status } = req.body;

  if (status === "completed") {
    await deliver(order_id, amount);
  }

  res.sendStatus(200);
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server running...");
});
