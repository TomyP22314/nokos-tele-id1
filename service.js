import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import crypto from "crypto";
import QRCode from "qrcode";
import FormData from "form-data";

const app = express();
app.use(express.json());

/* ================= ENV ================= */

const REQUIRED = [
  "BOT_TOKEN",
  "WEBHOOK_SECRET",
  "ADMIN_CHAT_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "SHEET_ID",
  "SHEET_ORDERS_TAB",
  "PAKASIR_SLUG",
  "PAKASIR_API_KEY",
  "PAKASIR_WEBHOOK_SECRET"
];

for (const key of REQUIRED) {
  if (!process.env[key]) throw new Error("Missing ENV: " + key);
}

const {
  BOT_TOKEN,
  WEBHOOK_SECRET,
  ADMIN_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SHEET_ID,
  SHEET_ORDERS_TAB,
  PAKASIR_SLUG,
  PAKASIR_API_KEY,
  PAKASIR_WEBHOOK_SECRET
} = process.env;

const ADMIN_ID = String(ADMIN_CHAT_ID);

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

async function appendRow(tab, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

async function updateCell(tab, a1, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!${a1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] }
  });
}

/* ================= TELEGRAM ================= */

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return await r.json();
}

function rupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function makeInvoice(index) {
  return `INV${index}-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`;
}

function getHarga(nama) {
  if (nama === "DRAKOR ID") return 15000;
  if (nama === "APK DRACIN") return 20000;
  if (nama === "APK ANIME") return 15000;
  return 15000;
}

/* ================= MENU USER ================= */

async function sendStart(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text:
`🔥 Selamat datang di GOMS APK MOD 😎

📦 Produk siap dikirim otomatis
💳 Pembayaran Via QR

Silakan pilih menu di bawah 👇`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "📦 Produk", callback_data: "PRODUK" }],
        [{ text: "📌 Cara Order", callback_data: "CARA" }],
        [{ text: "ℹ️ Info", callback_data: "INFO" }]
      ]
    }
  });
}

async function sendProduk(chatId) {
  const rows = await readSheet("APK NONTON!A2:D");

  const buttons = [];
  let text = "📦 LIST PRODUK\n\n";

  rows.forEach((r, i) => {
    const nama = r[0];
    const stock = r[3] || "UNLIMITED";
    const harga = getHarga(nama);

    text += `• ${nama} — ${rupiah(harga)} — Stok: ${stock}\n`;
    buttons.push([{ text: `Beli ${nama}`, callback_data: "BUY_" + i }]);
  });

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: buttons }
  });
}

/* ================= ADMIN PANEL ================= */

async function adminPanel(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "🛠 ADMIN PANEL",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📦 Cek Stock", callback_data: "ADMIN_STOCK" }],
        [{ text: "➕ Add Product", callback_data: "ADMIN_ADD_PRODUCT" }],
        [{ text: "👥 Cek Pengguna", callback_data: "ADMIN_USERS" }],
        [{ text: "📜 Riwayat Transaksi", callback_data: "ADMIN_HISTORY" }],
        [{ text: "📊 Dashboard", callback_data: "ADMIN_DASH" }]
      ]
    }
  });
}

/* ================= ROUTES ================= */

app.get("/", (req, res) => res.send("OK"));

app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  const update = req.body;

  if (update.message?.
