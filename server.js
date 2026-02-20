/**
 * Premium Telegram Shop Bot (Legal Digital Products)
 * - Welcome animation + Premium dashboard (total users + completed tx auto from Sheets)
 * - Stock from Google Sheets tabs: ID1..ID8 (rows after header = items)
 * - READY only: show groups with stock > 0
 * - Create Pakasir QRIS invoice + send QR image + cancel button
 * - Pakasir webhook "completed" -> deliver 1 item -> delete row from stock sheet (so it won't show again)
 *
 * REQUIRED SHEETS (tabs):
 * - ID1, ID2, ... ID8  (stock tabs)
 * - Orders            (orders tab)
 * - Users             (users tab)
 */

import express from "express";
import { google } from "googleapis";
import QRCode from "qrcode";

const app = express();
app.use(express.json({ limit: "2mb" }));

// =======================
// ENV (Render Environment)
// =======================
const REQUIRED_ENV = [
  "BOT_TOKEN",
  "WEBHOOK_SECRET", // telegram webhook secret (path segment)
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "SHEET_ID",
  "SHEET_ORDERS_TAB", // "Orders"
  "PAKASIR_SLUG",
  "PAKASIR_API_KEY",
  "PAKASIR_WEBHOOK_SECRET", // for /pakasir/webhook/<secret>
  "WELCOME_ANIM_FILE_ID", // your animation file_id
];

function assertEnv() {
  const missing = REQUIRED_ENV.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
  if (missing.length) throw new Error("Missing ENV: " + missing.join(", "));
}
assertEnv();

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_SECRET = process.env.WEBHOOK_SECRET;

const SHEET_ID = process.env.SHEET_ID;
const ORDERS_TAB = process.env.SHEET_ORDERS_TAB; // Orders
const USERS_TAB = "Users"; // fixed

const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const PAKASIR_WEBHOOK_SECRET = process.env.PAKASIR_WEBHOOK_SECRET;

const WELCOME_ANIM_FILE_ID = process.env.WELCOME_ANIM_FILE_ID;

// ============
// PRICE LIST
// ============
const PRICE_BY_GROUP = {
  ID1: 28000,
  ID2: 25000,
  ID3: 23000,
  ID4: 20000,
  ID5: 18000,
  ID6: 15000,
  ID7: 10000,
  ID8: 9000,
};
const GROUPS = Object.keys(PRICE_BY_GROUP);

// =================
// Google Sheets Auth
// =================
function getServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  return JSON.parse(raw);
}
const sa = getServiceAccount();
const jwt = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth: jwt });

// =================
// Helpers
// =================
function nowISO() {
  return new Date().toISOString();
}
function rupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function tg(method, payload) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.log("Telegram API error:", data);
  return data;
}

async function sendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function sendQRPhoto(chatId, qrString, caption, extra = {}) {
  // Generate QR PNG buffer
  const pngBuffer = await QRCode.toBuffer(qrString, {
    type: "png",
    width: 800,
    margin: 1,
    errorCorrectionLevel: "M",
  });

  // Telegram sendPhoto multipart/form-data
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", caption);
  form.append("parse_mode", "HTML");
  form.append("photo", new Blob([pngBuffer], { type: "image/png" }), "qris.png");
  if (extra.reply_markup) form.append("reply_markup", JSON.stringify(extra.reply_markup));

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) console.log("Telegram sendPhoto error:", data);
  return data;
}

// ==========================
// Google Sheets basic ops
// ==========================
async function sheetGet(range) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return r.data.values || [];
}
async function sheetAppend(range, values) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [values] },
  });
}
async function sheetUpdate(range, values) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}
async function getSheetIdByTitle(title) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const found = meta.data.sheets?.find((s) => s.properties?.title === title);
  return found?.properties?.sheetId;
}
async function sheetDeleteRowByTabTitle(tabTitle, rowIndexZeroBased) {
  const sheetIdNum = await getSheetIdByTitle(tabTitle);
  if (typeof sheetIdNum !== "number") throw new Error(`Sheet tab not found: ${tabTitle}`);

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheetIdNum,
              dimension: "ROWS",
              startIndex: rowIndexZeroBased,
              endIndex: rowIndexZeroBased + 1,
            },
          },
        },
      ],
    },
  });
}

// ==========================
// Users tracking (Users tab)
// ==========================
async function ensureUsersHeader() {
  const values = await sheetGet(`${USERS_TAB}!A1:C1`).catch(() => []);
  const header = values[0] || [];
  const want = ["chat_id", "first_seen", "last_seen"];
  const ok = want.every((v, i) => String(header[i] || "").trim() === v);
  if (!ok) await sheetUpdate(`${USERS_TAB}!A1:C1`, want);
}

async function upsertUser(chatId) {
  await ensureUsersHeader();
  const values = await sheetGet(`${USERS_TAB}!A:C`).catch(() => []);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || "") === String(chatId)) {
      const rowNum = i + 1; // 1-based
      const firstSeen = values[i][1] || nowISO();
      await sheetUpdate(`${USERS_TAB}!A${rowNum}:C${rowNum}`, [String(chatId), firstSeen, nowISO()]);
      return;
    }
  }
  await sheetAppend(`${USERS_TAB}!A:C`, [String(chatId), nowISO(), nowISO()]);
}

async function getTotalUsers() {
  const values = await sheetGet(`${USERS_TAB}!A:A`).catch(() => []);
  return Math.max(0, values.length - 1); // minus header
}

// ==========================
// Orders tracking (Orders tab)
// ==========================
async function ensureOrdersHeader() {
  const values = await sheetGet(`${ORDERS_TAB}!A1:G1`).catch(() => []);
  const header = values[0] || [];
  const want = ["order_id", "chat_id", "group_id", "amount", "status", "created_at", "completed_at"];
  const ok = want.every((v, i) => String(header[i] || "").trim() === v);
  if (!ok) await sheetUpdate(`${ORDERS_TAB}!A1:G1`, want);
}

async function appendOrder({ orderId, chatId, groupId, amount, status }) {
  await ensureOrdersHeader();
  await sheetAppend(`${ORDERS_TAB}!A:G`, [
    orderId,
    String(chatId),
    groupId,
    String(amount),
    status,
    nowISO(),
    "",
  ]);
}

async function findOrderRow(orderId) {
  const values = await sheetGet(`${ORDERS_TAB}!A:G`).catch(() => []);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || "") === orderId) {
      return { rowNumber1Based: i + 1, row: values[i] };
    }
  }
  return null;
}

async function markOrderCompleted(orderId, completedAtISO) {
  const found = await findOrderRow(orderId);
  if (!found) return false;

  const r = found.row;
  const updated = [
    r[0] || orderId,
    r[1] || "",
    r[2] || "",
    r[3] || "",
    "completed",
    r[5] || "",
    completedAtISO || nowISO(),
  ];
  await sheetUpdate(`${ORDERS_TAB}!A${found.rowNumber1Based}:G${found.rowNumber1Based}`, updated);
  return true;
}

async function getTotalCompletedTransactions() {
  const values = await sheetGet(`${ORDERS_TAB}!A:G`).catch(() => []);
  if (values.length <= 1) return 0;
  let count = 0;
  for (let i = 1; i < values.length; i++) {
    const status = String(values[i][4] || "").toLowerCase().trim();
    if (status === "completed") count++;
  }
  return count;
}

// ==========================
// Stock logic (ID1..ID8)
// ==========================
async function getStockCount(groupId) {
  const values = await sheetGet(`${groupId}!A:Z`).catch(() => []);
  if (values.length <= 1) return 0;
  const rows = values.slice(1);
  const nonEmpty = rows.filter((r) => r.some((c) => String(c || "").trim() !== ""));
  return nonEmpty.length;
}

async function buildStockMessage() {
  const counts = {};
  for (const g of GROUPS) counts[g] = await getStockCount(g);

  const lines = [];
  lines.push("📦 <b>Stok saat ini (READY saja):</b>");
  for (const g of GROUPS) {
    const c = counts[g];
    const dot = c > 0 ? "🟢" : "🔴";
    lines.push(`${dot} <b>${g}</b>: <b>${c}</b> stok — ${rupiah(PRICE_BY_GROUP[g])}`);
  }
  lines.push("");
  lines.push("Pilih ID yang ingin dibeli:");

  const inline = [];
  for (const g of GROUPS) {
    if (counts[g] > 0) inline.push([{ text: `${g} (${rupiah(PRICE_BY_GROUP[g])})`, callback_data: `buy:${g}` }]);
  }
  if (inline.length === 0) inline.push([{ text: "Stok habis", callback_data: "noop" }]);

  return { text: lines.join("\n"), reply_markup: { inline_keyboard: inline } };
}

// Deliver one stock item: pick first non-empty row (after header), send all filled columns, then delete row
function formatProductDetail(headers, row) {
  const lines = [];
  lines.push("✅ <b>Produk berhasil dibeli</b>");
  lines.push("");
  lines.push("<b>Detail produk:</b>");
  for (let i = 0; i < headers.length; i++) {
    const key = String(headers[i] || "").trim();
    const val = String(row[i] || "").trim();
    if (key && val) lines.push(`• <b>${escapeHtml(key)}</b>: <code>${escapeHtml(val)}</code>`);
  }
  lines.push("");
  lines.push("Terima kasih 🙏");
  return lines.join("\n");
}

async function deliverOneItem(chatId, groupId) {
  const values = await sheetGet(`${groupId}!A:Z`).catch(() => []);
  if (values.length <= 1) {
    await sendMessage(chatId, "Maaf, stok habis saat diproses. Silakan order ulang.");
    return false;
  }

  const headers = values[0] || [];
  const rows = values.slice(1);

  let pickedIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].some((c) => String(c || "").trim() !== "")) {
      pickedIndex = i;
      break;
    }
  }
  if (pickedIndex === -1) {
    await sendMessage(chatId, "Maaf, stok habis saat diproses. Silakan order ulang.");
    return false;
  }

  const pickedRow = rows[pickedIndex];
  await sendMessage(chatId, formatProductDetail(headers, pickedRow));

  // delete that row from sheet (header row = 0, first data row = 1)
  const rowIndexZeroBased = 1 + pickedIndex;
  await sheetDeleteRowByTabTitle(groupId, rowIndexZeroBased);
  return true;
}

// ==========================
// Pakasir API (your current working style)
// ==========================
// NOTE: If your Pakasir endpoint differs, only edit these two functions.
// From your earlier setup, these endpoints match what you used.
async function pakasirCreateQris(orderId, amount) {
  const url = "https://app.pakasir.com/api/transactioncreate/qris";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: PAKASIR_SLUG,
      order_id: orderId,
      amount,
      api_key: PAKASIR_API_KEY,
    }),
  });

  const data = await res.json().catch(() => ({}));
  // Expect: data.payment.payment_number (QR string), total_payment, expired_at, payment_method
  if (!data?.payment?.payment_number) {
    console.log("Pakasir create error:", data);
    throw new Error("Gagal membuat invoice Pakasir");
  }
  return data.payment;
}

async function pakasirCancel(orderId, amount) {
  const url = "https://app.pakasir.com/api/transactioncancel";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: PAKASIR_SLUG,
      order_id: orderId,
      amount,
      api_key: PAKASIR_API_KEY,
    }),
  });
  return res.json().catch(() => ({}));
}

// ==========================
// Premium Dashboard / Welcome
// ==========================
async function handleStart(chatId) {
  await upsertUser(chatId);

  const totalUsers = await getTotalUsers();
  const totalDone = await getTotalCompletedTransactions();

  const caption =
    "👋 <b>Welcome to Ann Store</b>\n" +
    "────────────────────\n" +
    `👥 <b>Total User Bot:</b> ${totalUsers} Orang\n` +
    `✅ <b>Total Transaksi Terselesaikan:</b> ${totalDone}x\n\n` +
    "Gunakan menu di bawah untuk mulai ✨";

  // Send animation welcome
  await tg("sendAnimation", {
    chat_id: chatId,
    animation: WELCOME_ANIM_FILE_ID,
    caption,
    parse_mode: "HTML",
  });

  // Send menu keyboard
  await sendMessage(chatId, "👇 Pilih Menu:", {
reply_markup: {
  keyboard: [
    [{ text: "📦 List Produk" }],
    [{ text: "ℹ️ INFORMASI" }, { text: "✨ Cara Order" }],
  ],
  resize_keyboard: true,
},
  });
}

// ==========================
// Text handler (menu buttons)
// ==========================
async function handleText(chatId, text) {
  const t = (text || "").trim().toLowerCase();

  if (t === "/start") return handleStart(chatId);

  if (t.includes("list produk")) {
    const stock = await buildStockMessage();
    return sendMessage(chatId, stock.text, { reply_markup: stock.reply_markup });
  }

  if (t.includes("stock")) {
    const stock = await buildStockMessage();
    return sendMessage(chatId, stock.text, { reply_markup: stock.reply_markup });
  }

  if (t.includes("informasi")) {
    return sendMessage(
      chatId,
      "ℹ️ <b>INFORMASI</b>\n\n" +
        "• Produk digital legal\n" +
        "• Proses otomatis setelah pembayaran\n" +
        "• Jika ada kendala, hubungi admin"
    );
  }

  if (t.includes("cara order")) {
    return sendMessage(
      chatId,
      "✨ <b>Cara Order</b>\n\n" +
        "1) Klik 📦 <b>List Produk</b>\n" +
        "2) Pilih ID yang tersedia\n" +
        "3) Bayar via QRIS (scan QR)\n" +
        "4) Setelah status <b>completed</b>, bot kirim detail produk otomatis\n"
    );
  }

  if (t.includes("deposit")) {
    // Optional feature; keep it simple
    return sendMessage(chatId, "💰 <b>DEPOSIT</b>\n\nFitur deposit bisa ditambahkan nanti. Untuk sekarang gunakan pembayaran per order ya.");
  }

  return sendMessage(chatId, "Ketik /start atau klik menu.");
}

// ==========================
// Callback handler (buy / cancel)
// ==========================
async function handleCallback(callbackQuery) {
  const chatId = callbackQuery.message?.chat?.id;
  const data = callbackQuery.data || "";

  await tg("answerCallbackQuery", { callback_query_id: callbackQuery.id });

  if (!chatId) return;
  if (data === "noop") return;

  // buy:IDx
  if (data.startsWith("buy:")) {
    const groupId = data.split(":")[1];
    if (!PRICE_BY_GROUP[groupId]) return sendMessage(chatId, "ID tidak dikenal.");

    const stockCount = await getStockCount(groupId);
    if (stockCount <= 0) return sendMessage(chatId, "Maaf, stok habis.");

    const amount = PRICE_BY_GROUP[groupId];
    const orderId = `TX${Date.now()}-${chatId}-${groupId}`;

    await appendOrder({ orderId, chatId, groupId, amount, status: "pending" });

    const pay = await pakasirCreateQris(orderId, amount);

    const totalPay = Number(pay.total_payment ?? amount);
    const expiredAt = pay.expired_at ? String(pay.expired_at) : "-";
    const method = pay.payment_method ? String(pay.payment_method) : "qris";

    const caption =
      "💳 <b>Invoice Berhasil Dibuat</b>\n\n" +
      "🧾 <b>Informasi Item</b>\n" +
      `— List Yang Dibeli:\n` +
      `1. ${escapeHtml(groupId)} x1 — <b>${rupiah(amount)}</b>\n\n` +
      "🧾 <b>Informasi Pembayaran</b>\n" +
      `— ID Transaksi: <code>${escapeHtml(orderId)}</code>\n` +
      `— Total Dibayar: <b>${rupiah(totalPay)}</b>\n` +
      `— Metode: <b>${escapeHtml(method)}</b>\n` +
      `— Expired: <b>${escapeHtml(expiredAt)}</b>\n\n` +
      "Silakan scan QR di atas untuk membayar.";

    await sendQRPhoto(chatId, pay.payment_number, caption, {
      reply_markup: {
        inline_keyboard: [[{ text: "❌ Batalkan Pembelian", callback_data: `cancel:${orderId}:${amount}` }]],
      },
    });

    return;
  }

  // cancel:orderId:amount
  if (data.startsWith("cancel:")) {
    const parts = data.split(":");
    const orderId = parts[1];
    const amount = Number(parts[2] || 0);

    if (!orderId || !amount) return sendMessage(chatId, "Data pembatalan tidak valid.");

    await pakasirCancel(orderId, amount);
    await sendMessage(chatId, "✅ Pembelian dibatalkan. Kamu bisa order lagi kapan saja.");
    return;
  }
}

// ==========================
// Webhooks
// ==========================
app.post(`/telegram/webhook/${TELEGRAM_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    if (update.callback_query) {
      const chatId = update.callback_query.message?.chat?.id;
      if (chatId) await upsertUser(chatId);
      await handleCallback(update.callback_query);
      return res.json({ ok: true });
    }

    const msg = update.message;
    if (!msg) return res.json({ ok: true });

    const chatId = msg.chat?.id;
    if (!chatId) return res.json({ ok: true });

    await upsertUser(chatId);
    await handleText(chatId, msg.text);
    res.json({ ok: true });
  } catch (e) {
    console.log("Telegram webhook error:", e);
    res.json({ ok: true });
  }
});

// Pakasir webhook: expects status "completed"
app.post(`/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const body = req.body || {};
    const status = String(body.status || "").toLowerCase();
    const orderId = String(body.order_id || "");
    const amount = Number(body.amount || 0);

    if (!orderId) return res.json({ ok: true });

    if (status !== "completed") return res.json({ ok: true });

    await markOrderCompleted(orderId, body.completed_at || nowISO());

    const found = await findOrderRow(orderId);
    if (!found) return res.json({ ok: true });

    const chatId = Number(found.row[1] || 0);
    const groupId = String(found.row[2] || "");
    const expectedAmount = Number(found.row[3] || 0);

    if (!chatId || !groupId) return res.json({ ok: true });

    // Safety check nominal
    if (expectedAmount && amount && expectedAmount !== amount) {
      await sendMessage(chatId, "⚠️ Pembayaran terdeteksi, tapi nominal tidak sesuai. Admin akan cek.");
      return res.json({ ok: true });
    }

    await deliverOneItem(chatId, groupId);
    res.json({ ok: true });
  } catch (e) {
    console.log("Pakasir webhook error:", e);
    res.json({ ok: true });
  }
});

// Health
app.get("/", (req, res) => res.send("OK"));

// Start server (Render)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
