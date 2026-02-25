// service.js (ESM)
// NOTE: package.json harus ada: { "type": "module" }

import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import crypto from "crypto";

/* ================= APP ================= */
const app = express();
app.use(express.json({ limit: "2mb" }));

/* ================= ENV ================= */
const REQUIRED_ENVS = [
  "BOT_TOKEN",
  "ADMIN_CHAT_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "SHEET_ID",
  "PAYMENT_PROJECT_SLUG",
  "PAYMENT_API_KEY",
  "WEBHOOK_SECRET",
];

for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error("Missing ENV:", k);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID);
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SHEET_ID = process.env.SHEET_ID;
const PAYMENT_PROJECT_SLUG = process.env.PAYMENT_PROJECT_SLUG;
const PAYMENT_API_KEY = process.env.PAYMENT_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/* ================= CONSTANT TAB ================= */
const TAB_MEMBER = "MEMBER LIST";
const TAB_TX = "TRANSAKSI";
const TAB_TX_SUCCESS = "TRANSAKSI BERHASIL";
const TAB_TX_FAIL = "TRANSAKSI GAGAL";
const TAB_CATEGORY = "CATEGORIES";
const TAB_BANNED = "BANNED";

/* ================= TELEGRAM ================= */
async function tg(method, body) {
  const url = "https://api.telegram.org/bot" + BOT_TOKEN + "/" + method;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function tgSendMessage(chatId, text, extra = {}) {
  try {
    const payload = Object.assign(
      { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true },
      extra || {}
    );
    return await tg("sendMessage", payload);
  } catch (e) {
    console.log("TG sendMessage error:", e?.message || e);
  }
}

async function tgSendPhoto(chatId, photo, caption, extra = {}) {
  try {
    const payload = Object.assign(
      { chat_id: chatId, photo, caption, parse_mode: "HTML" },
      extra || {}
    );
    return await tg("sendPhoto", payload);
  } catch (e) {
    console.log("TG sendPhoto error:", e?.message || e);
  }
}

async function tgDeleteMessage(chatId, messageId) {
  try {
    return await tg("deleteMessage", { chat_id: chatId, message_id: messageId });
  } catch (e) {
    console.log("TG deleteMessage error:", e?.message || e);
  }
}

async function tgAnswerCallback(cbId, text, showAlert = false) {
  try {
    return await tg("answerCallbackQuery", {
      callback_query_id: cbId,
      text: text || "",
      show_alert: !!showAlert,
    });
  } catch (e) {}
}

async function tgEditMessage(chatId, messageId, text, extra = {}) {
  try {
    const payload = Object.assign(
      {
        chat_id: chatId,
        message_id: messageId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
      extra || {}
    );
    return await tg("editMessageText", payload);
  } catch (e) {
    // NOTE: edit bisa gagal kalau message_id bukan milik bot / sudah dihapus
    console.log("TG editMessageText error:", e?.message || e);
    throw e;
  }
}

/* ================= GOOGLE SHEETS ================= */
const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.JWT(
  sa.client_email,
  null,
  sa.private_key,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth });

// quote sheet name if needed (support spaces)
function qRange(range) {
  if (range.startsWith("'")) return range;
  const idx = range.indexOf("!");
  if (idx === -1) return range;
  const tab = range.slice(0, idx);
  const rest = range.slice(idx);
  return "'" + tab + "'" + rest;
}

async function read(range) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: qRange(range),
  });
  return r.data.values || [];
}

async function append(range, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: qRange(range),
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

async function updateCell(range, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: qRange(range),
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

async function clearRow(tab, rowIndex, colEndLetter) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: qRange(`${tab}!A${rowIndex}:${colEndLetter}${rowIndex}`),
  });
}

/* ================= HELPERS ================= */
function nowISO() {
  return new Date().toISOString();
}

function rupiah(n) {
  const num = Number(n || 0);
  return "Rp " + num.toLocaleString("id-ID");
}

function getRandomTestimoni() {
  const list = [
    "⭐⭐⭐⭐⭐ Cepet banget prosesnya, baru bayar langsung dikirim! ⚡",
    "⭐⭐⭐⭐⭐ Trusted parah, udah order 3x aman semua 🔥",
    "⭐⭐⭐⭐⭐ Admin fast respon & ramah banget 😍",
    "⭐⭐⭐⭐⭐ Harga murah tapi kualitas premium 💎",
    "⭐⭐⭐⭐⭐ Auto kirim beneran, gak pake lama! 🚀",
    "⭐⭐⭐⭐⭐ Recommended seller, gak tipu-tipu! ✅",
    "⭐⭐⭐⭐⭐ Udah langganan disini, aman terus! 🛡️",
    "⭐⭐⭐⭐⭐ Proses cuma hitungan detik ⚡",
  ];
  return list[Math.floor(Math.random() * list.length)];
}

function getRandomAds() {
  const adsList = [
    '🏠 Cari NoKos Tele 👉 <a href="https://t.me/gomstele24jam_bot">@gomstele24jam_bot</a>',
    '🔥 Butuh akun UBOT? Gas 👉 <a href="https://t.me/gomstele24jam_bot">Beli Disini</a>',
    '💎 Join Channel NoKos Premium 👉 <a href="https://t.me/gomstele24jam_bot">Klik Masuk</a>',
    '🚀 Auto Order NoKos 24 Jam 👉 <a href="https://t.me/gomstele24jam_bot">Langsung Chat</a>',
  ];
  return adsList[Math.floor(Math.random() * adsList.length)];
}

function marketingMemberFallback() {
  const base = 120;
  const days = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const growth = days % 200;
  const randomBoost = Math.floor(Math.random() * 30);
  return base + growth + randomBoost;
}

function marketingSuccessFallback() {
  const base = 150;
  const days = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const growth = days % 300;
  const randomBoost = Math.floor(Math.random() * 20);
  return base + growth + randomBoost;
}

/* ================= INLINE MENUS ================= */
function mainMenuInline(isAdmin) {
  const rows = [
    [
      { text: "📦 Kategori", callback_data: "NAV_CAT" },
      { text: "🧾 Cek Pesanan", callback_data: "NAV_CEK" },
    ],
    [
      { text: "📌 Cara Order", callback_data: "NAV_ORDER" },
      { text: "🆘 Bantuan", callback_data: "NAV_HELP" },
    ],
    [{ text: "📍 Ping", callback_data: "NAV_PING" }],
  ];
  if (isAdmin) rows.push([{ text: "🛠 Panel Admin", callback_data: "NAV_ADMIN" }]);
  return { inline_keyboard: rows };
}

function adminPanelInline() {
  return {
    inline_keyboard: [
      [
        { text: "➕ Tambah Kategori", callback_data: "ADM_ADD_CAT" },
        { text: "🗑 Hapus Kategori", callback_data: "ADM_DEL_CAT" },
      ],
      [
        { text: "➕ Tambah Stock", callback_data: "ADM_ADD_STOCK" },
        { text: "➖ Kurangi Stock", callback_data: "ADM_DEL_STOCK" },
      ],
      [{ text: "📣 Broadcast", callback_data: "ADM_BROADCAST" }],
      [{ text: "🏠 Home", callback_data: "NAV_HOME" }],
    ],
  };
}

/* ================= ANTI SPAM (RAM only) ================= */
const spamState = new Map();
// rules: max 8 messages / 10 seconds, strike -> ban after 3 strikes
const SPAM_WINDOW_MS = 10_000;
const SPAM_MAX_MSG = 8;
const SPAM_STRIKE_BAN = 3;

function checkSpam(chatId) {
  const now = Date.now();
  const st = spamState.get(chatId) || { ts: [], strike: 0, bannedUntil: 0 };

  if (st.bannedUntil && now < st.bannedUntil) {
    spamState.set(chatId, st);
    return { blocked: true, reason: "temporary" };
  }

  st.ts = st.ts.filter((t) => now - t <= SPAM_WINDOW_MS);
  st.ts.push(now);

  if (st.ts.length > SPAM_MAX_MSG) {
    st.strike += 1;
    st.ts = [];
    st.bannedUntil = now + 60_000; // 60s
    spamState.set(chatId, st);
    return { blocked: true, reason: "spam", strike: st.strike };
  }

  spamState.set(chatId, st);
  return { blocked: false };
}

/* ================= MEMBER SYSTEM ================= */
async function addMember(chatId, username) {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  const key = String(username ? `@${username}` : chatId);
  const exists = rows.some((r) => String(r[2] || "") === key);
  if (exists) return;
  const nomor = rows.length; // simple numbering
  await append(`${TAB_MEMBER}!A:C`, [nomor, nowISO(), key]);
}

async function countMembers() {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  return Math.max(rows.length - 1, 0);
}

async function listMemberChatIds() {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  const data = rows.slice(1);
  const ids = [];
  for (const r of data) {
    const v = String(r[2] || "").trim();
    if (!v) continue;
    // kita simpan chatId kalau memang angka, kalau @username skip
    if (/^\d+$/.test(v)) ids.push(v);
  }
  return ids;
}

async function isBanned(chatId) {
  const rows = await read(`${TAB_BANNED}!A:C`);
  return rows.some((r) => String(r[0]) === String(chatId));
}

async function banUser(chatId, reason) {
  await append(`${TAB_BANNED}!A:C`, [String(chatId), reason || "No reason", nowISO()]);
}

async function unbanUser(chatId) {
  const rows = await read(`${TAB_BANNED}!A:C`);
  const idx = rows.findIndex((r) => String(r[0]) === String(chatId));
  if (idx >= 0) {
    await clearRow(TAB_BANNED, idx + 1, "C"); // +1 header offset
  }
}

/* ================= CATEGORY & PRODUCTS ================= */
async function getCategories() {
  const rows = await read(`${TAB_CATEGORY}!A:A`);
  const cats = rows.map((r) => (r[0] || "").trim()).filter(Boolean);
  if (cats.length && cats[0].toUpperCase().includes("CATEG")) return cats.slice(1);
  return cats;
}

async function addCategory(catName) {
  const name = String(catName || "").trim();
  if (!name) throw new Error("Nama kategori kosong");
  const cats = await getCategories();
  if (cats.some((c) => c.toLowerCase() === name.toLowerCase())) return false;
  await append(`${TAB_CATEGORY}!A:A`, [name]);
  return true;
}

async function deleteCategory(catName) {
  const name = String(catName || "").trim();
  if (!name) throw new Error("Nama kategori kosong");
  const rows = await read(`${TAB_CATEGORY}!A:A`);
  // cari row index (1-based)
  for (let i = 0; i < rows.length; i++) {
    const v = String(rows[i][0] || "").trim();
    if (!v) continue;
    if (v.toLowerCase() === name.toLowerCase()) {
      await clearRow(TAB_CATEGORY, i + 1, "A");
      return true;
    }
  }
  return false;
}

async function getProducts(category) {
  const rows = await read(`${category}!A:F`);
  const data = rows.slice(1); // skip header
  return data
    .map((r, i) => ({
      id: String(r[0] || "").trim(),
      name: String(r[1] || "").trim(),
      link: String(r[2] || "").trim(),
      desc: String(r[3] || "").trim(),
      stock: String(r[4] || "").trim(),
      price: String(r[5] || "").trim(),
      rowIndex: i + 2,
      tab: category,
    }))
    .filter((p) => p.id && p.name);
}

async function updateProductStock(category, productId, delta) {
  const cat = String(category || "").trim();
  const pid = String(productId || "").trim();
  const d = Number(delta);
  if (!cat || !pid || Number.isNaN(d)) throw new Error("Format salah");

  const products = await getProducts(cat);
  const p = products.find((x) => String(x.id) === pid);
  if (!p) throw new Error("Produk tidak ditemukan");

  if (String(p.stock).toUpperCase() === "UNLIMITED") {
    throw new Error("Stock produk ini UNLIMITED (tidak bisa diubah)");
  }

  const cur = Number(p.stock || 0);
  const next = Math.max(0, cur + d);
  await updateCell(`${p.tab}!E${p.rowIndex}`, String(next));
  return { before: cur, after: next, product: p };
}

/* ================= PAYMENT (PAKASIR) ================= */
async function getPaymentDetail(amount, invoice) {
  const url =
    "https://app.pakasir.com/api/transactiondetail" +
    `?project=${encodeURIComponent(PAYMENT_PROJECT_SLUG)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&order_id=${encodeURIComponent(invoice)}` +
    `&api_key=${encodeURIComponent(PAYMENT_API_KEY)}`;

  const res = await fetch(url);
  const text = await res.text();

  if (!res.ok) {
    throw new Error("PAKASIR ERROR " + res.status + ": " + text);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("PAKASIR NOT JSON: " + text);
  }
  return data;
}

async function createPakasirQRIS(amount, invoice) {
  const url = "https://app.pakasir.com/api/transactioncreate/qris";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project: PAYMENT_PROJECT_SLUG,
      order_id: invoice,
      amount: Number(amount),
      api_key: PAYMENT_API_KEY,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error("PAKASIR CREATE ERROR " + res.status + ": " + text);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error("PAKASIR CREATE NOT JSON: " + text);
  }
  return data;
}

/* ================= TRANSAKSI ================= */
async function createTransaction(product, chatId, username) {
  const invoice = "TX" + Date.now() + crypto.randomBytes(2).toString("hex");

  // A:time B:pid C:name D:user E:invoice F:price G:status H:QR_MSG_ID
  await append(`${TAB_TX}!A:H`, [
    nowISO(),
    product.id,
    product.name,
    username ? `@${username}` : String(chatId),
    invoice,
    product.price,
    "PENDING",
    "",
  ]);

  return invoice;
}

async function findTransaction(invoice) {
  const rows = await read(`${TAB_TX}!A:H`);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][4]) === String(invoice)) {
      return { rowIndex: i + 1, data: rows[i] };
    }
  }
  return null;
}

async function markSuccess(rowIndex, rowData) {
  await updateCell(`${TAB_TX}!G${rowIndex}`, "SUCCESS");
  await append(`${TAB_TX_SUCCESS}!A:G`, rowData.slice(0, 7));
  await clearRow(TAB_TX, rowIndex, "H");
}

async function markFailed(rowIndex, rowData) {
  await updateCell(`${TAB_TX}!G${rowIndex}`, "FAILED");
  await append(`${TAB_TX_FAIL}!A:G`, rowData.slice(0, 7));
  await clearRow(TAB_TX, rowIndex, "H");
}

async function markCancelled(rowIndex, rowData) {
  await updateCell(`${TAB_TX}!G${rowIndex}`, "CANCELLED");
  // simpan juga ke fail sheet biar ada jejak
  const copy = [...rowData];
  copy[6] = "CANCELLED";
  await append(`${TAB_TX_FAIL}!A:G`, copy.slice(0, 7));
  await clearRow(TAB_TX, rowIndex, "H");
}

async function countSuccessTx() {
  const rows = await read(`${TAB_TX_SUCCESS}!A:G`);
  return Math.max(rows.length - 1, 0);
}

/* ================= QRIS SEND ================= */
async function sendQRIS(chatId, product, invoice) {
  let pay;
  try {
    pay = await createPakasirQRIS(product.price, invoice);
  } catch (e) {
    console.log("PAKASIR CREATE ERROR:", e?.message || e);
    await tgSendMessage(chatId, "⚠️ QRIS gagal dibuat. Coba lagi sebentar ya.");
    return;
  }

  const qrString =
    pay?.payment?.payment_number ||
    pay?.payment?.payment_string ||
    pay?.payment?.qr_string ||
    pay?.transaction?.payment_number ||
    pay?.transaction?.qris_string ||
    pay?.transaction?.qr_string ||
    null;

  if (!qrString) {
    await tgSendMessage(chatId, "⚠️ QRIS belum tersedia. Coba lagi sebentar ya.");
    return;
  }

  const qrImageUrl =
    "https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=" +
    encodeURIComponent(qrString);

  const sent = await tgSendPhoto(
    chatId,
    qrImageUrl,
    "🧾 <b>Invoice</b>: <code>" +
      invoice +
      "</code>\n" +
      "📦 <b>Produk</b>: " +
      product.name +
      "\n" +
      "💰 <b>Total</b>: <b>" +
      rupiah(product.price) +
      "</b>\n\n" +
      "Silakan scan QRIS di atas.\n" +
      "Setelah bayar, klik tombol <b>🧾 Cek Status</b>.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "🧾 Cek Status", callback_data: `CEK_${invoice}` },
            { text: "❌ Batalkan", callback_data: `CANCEL_${invoice}` },
          ],
          [{ text: "🏠 Home", callback_data: "NAV_HOME" }],
        ],
      },
    }
  );

  const qrMsgId = sent?.result?.message_id || sent?.message_id;
  const tx = await findTransaction(invoice);
  if (tx && qrMsgId) {
    await updateCell(`${TAB_TX}!H${tx.rowIndex}`, String(qrMsgId));
  }
}

/* ================= CEK STATUS & DELIVER ================= */
async function checkAndDeliver(chatId, invoice) {
  const tx = await findTransaction(invoice);
  if (!tx) {
    await tgSendMessage(chatId, "❌ Invoice tidak ditemukan.");
    return;
  }

  const row = tx.data;
  const statusOnSheet = String(row[6] || "").toUpperCase();
  if (statusOnSheet === "SUCCESS") {
    await tgSendMessage(chatId, "✅ Transaksi ini sudah berhasil sebelumnya.");
    return;
  }

  const amount = row[5];
  const detail = await getPaymentDetail(amount, invoice);

  const status = String(detail?.transaction?.status || detail?.status || "").toUpperCase();

  if (status === "COMPLETED" || status === "SUCCESS" || status === "PAID") {
    const cats = await getCategories();
    let product = null;

    for (const cat of cats) {
      const prods = await getProducts(cat);
      const found = prods.find((p) => String(p.id) === String(row[1]));
      if (found) {
        product = found;
        break;
      }
    }

    if (!product) {
      await tgSendMessage(
        ADMIN_CHAT_ID,
        `⚠️ Produk tidak ditemukan untuk invoice <code>${invoice}</code>`
      );
      await tgSendMessage(chatId, "⚠️ Produk tidak ditemukan. Admin sudah diberitahu.");
      return;
    }

    // reduce stock if not UNLIMITED
    if (String(product.stock).toUpperCase() !== "UNLIMITED") {
      const current = Number(product.stock || 0);
      if (current > 0) {
        await updateCell(`${product.tab}!E${product.rowIndex}`, String(current - 1));
      }
    }

    // hapus pesan QRIS kalau ada (kolom H)
    const qrMsgId = row[7];
    if (qrMsgId) {
      await tgDeleteMessage(chatId, Number(qrMsgId));
      await updateCell(`${TAB_TX}!H${tx.rowIndex}`, "");
    }

    await markSuccess(tx.rowIndex, row);

    await tgSendMessage(
      chatId,
      `✅ <b>Pembayaran Berhasil!</b>\n\n` +
        `📦 <b>${product.name}</b>\n\n` +
        `🔗 <b>Link Download:</b>\n${product.link}\n\n` +
        `Terima kasih sudah order di <b>GOMS APK MOD</b> 🙏🔥`
    );
    return;
  }

  if (status === "EXPIRED" || status === "FAILED" || status === "CANCELLED") {
    await markFailed(tx.rowIndex, row);
    await tgSendMessage(chatId, "❌ Transaksi gagal / expired.");
    return;
  }

  await tgSendMessage(chatId, "⏳ Status: <b>MENUNGGU PEMBAYARAN</b>\nCoba cek lagi setelah bayar ya.");
}

/* ================= MENUS ================= */
async function showCategoriesEdit(chatId, messageId) {
  const categories = await getCategories();
  if (!categories.length) {
    await tgEditMessage(chatId, messageId, "⚠️ Kategori kosong. Isi dulu di sheet tab <b>CATEGORIES</b>.");
    return;
  }

  const buttons = categories.map((c) => [{ text: c, callback_data: `CAT_${c}` }]);
  buttons.push([{ text: "🏠 Home", callback_data: "NAV_HOME" }]);

  await tgEditMessage(chatId, messageId, "📦 <b>Pilih Kategori:</b>", {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function showProducts(chatId, cat, messageId, page = 1) {
  const products = await getProducts(cat);

  const perPage = 6;
  const totalPages = Math.max(1, Math.ceil(products.length / perPage));
  page = Math.min(Math.max(page, 1), totalPages);

  if (!products.length) {
    await tgEditMessage(chatId, messageId, `⚠️ Produk di <b>${cat}</b> masih kosong.`, {
      reply_markup: {
        inline_keyboard: [[
          { text: "⬅️ Kembali", callback_data: "BACK_CAT" },
          { text: "🏠 Home", callback_data: "NAV_HOME" },
        ]],
      },
    });
    return;
  }

  const start = (page - 1) * perPage;
  const slice = products.slice(start, start + perPage);

  const keyboard = slice.map((p) => [
    { text: `${p.name} — ${rupiah(p.price)}`, callback_data: `BUY_${cat}_${p.id}` },
  ]);

  const navRow = [];
  if (page > 1) navRow.push({ text: "⬅️ Prev", callback_data: `PROD_PAGE_${cat}_${page - 1}` });
  navRow.push({ text: `📄 ${page}/${totalPages}`, callback_data: "NOOP" });
  if (page < totalPages) navRow.push({ text: "Next ➡️", callback_data: `PROD_PAGE_${cat}_${page + 1}` });
  keyboard.push(navRow);

  keyboard.push([
    { text: "⬅️ Kembali", callback_data: "BACK_CAT" },
    { text: "🏠 Home", callback_data: "NAV_HOME" },
  ]);

  await tgEditMessage(chatId, messageId, `📦 <b>Produk ${cat}</b>\nPilih salah satu:`, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

/* ================= MAIN PAGE (1 pesan, selalu di-edit) ================= */
const MAIN_MSG = new Map(); // chatId(string) -> message_id(number)

function getMainMsgId(chatId) {
  return MAIN_MSG.get(String(chatId)) || null;
}
function setMainMsgId(chatId, messageId) {
  if (!chatId || !messageId) return;
  MAIN_MSG.set(String(chatId), Number(messageId));
}

async function renderMain(chatId, text, replyMarkup) {
  const mid = getMainMsgId(chatId);

  if (mid) {
    try {
      await tgEditMessage(chatId, mid, text, {
        reply_markup: replyMarkup,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
      return mid;
    } catch (e) {
      // fallback kirim baru
    }
  }

  const sent = await tgSendMessage(chatId, text, {
    reply_markup: replyMarkup,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });

  const newId = sent?.message_id || sent?.result?.message_id || sent?.result?.message?.message_id;
  if (newId) setMainMsgId(chatId, newId);
  return newId;
}

async function buildWelcomeText() {
  let totalMember = await countMembers();
  if (totalMember < 50) totalMember = marketingMemberFallback();

  let totalSuccess = await countSuccessTx();
  if (totalSuccess < 20) totalSuccess = marketingSuccessFallback();

  const testimoni = getRandomTestimoni();
  const randomAds = getRandomAds();

  const welcome =
    `🎉 <b>WELCOME TO GOMS APK MOD</b> 🎉\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📱 <b>APK KHUSUS ANDROID</b>\n` +
    `⚡ <b>Auto kirim</b> • Cepat • Aman\n\n` +
    `📊 <b>STATISTIK TOKO</b>\n` +
    `👥 Member: <b>${totalMember}</b>\n` +
    `✅ Transaksi Sukses: <b>${totalSuccess}</b>\n\n` +
    `💬 <b>Testimoni Pembeli</b>\n` +
    `<pre>${testimoni}</pre>\n\n` +
    `📌 <b>PILIH MENU</b> 👇\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📣 <b>IKLAN SPONSOR</b>\n` +
    `${randomAds}`;

  return welcome;
}

/* ================= ADMIN STATE (multi-step) ================= */
const adminState = new Map(); // chatId -> { action: string }

function setAdminState(chatId, action) {
  adminState.set(String(chatId), { action, ts: Date.now() });
}
function getAdminState(chatId) {
  const st = adminState.get(String(chatId));
  if (!st) return null;
  // expire 10 menit
  if (Date.now() - st.ts > 10 * 60 * 1000) {
    adminState.delete(String(chatId));
    return null;
  }
  return st;
}
function clearAdminState(chatId) {
  adminState.delete(String(chatId));
}

async function runBroadcast(text) {
  const ids = await listMemberChatIds();
  let ok = 0;
  let fail = 0;

  for (const id of ids) {
    try {
      const r = await tgSendMessage(id, text);
      if (r?.ok) ok++;
      else fail++;
    } catch (e) {
      fail++;
    }
    // throttle biar aman
    await new Promise((r) => setTimeout(r, 80));
  }

  return { ok, fail, total: ids.length };
}

/* ================= UPDATE HANDLER ================= */
async function handleUpdate(update) {
  const msg = update.message;
  const cb = update.callback_query;

  const from = msg?.from || cb?.from;
  const chat = msg?.chat || cb?.message?.chat;

  const chatIdGlobal = chat?.id;
  const usernameGlobal = from?.username;

  const isAdmin =
    String(chatIdGlobal) === String(ADMIN_CHAT_ID) ||
    String(usernameGlobal || "") === String(process.env.ADMIN_USERNAME || "").replace("@", "");

  /* ========== CALLBACK ========== */
  if (cb) {
    const chatId = cb.message?.chat?.id;
    const data = cb.data || "";
    if (!chatId) return;

    // anti spam callback
    const sp = checkSpam(String(chatId));
    if (sp.blocked) {
      await tgAnswerCallback(cb.id, "Terlalu cepat. Tunggu sebentar ya.", false);
      if (sp.reason === "spam" && sp.strike >= SPAM_STRIKE_BAN) {
        if (!(await isBanned(chatId))) {
          await banUser(chatId, "AUTO BAN: SPAM (callback)");
          await tgSendMessage(chatId, "❌ Kamu diblokir otomatis karena spam.");
        }
      }
      return;
    }

    // NAV
    if (data.startsWith("NAV_")) {
      await tgAnswerCallback(cb.id, "OK", false);

      if (data === "NAV_HOME") {
        const welcome = await buildWelcomeText();
        await renderMain(chatId, welcome, mainMenuInline(isAdmin));
        return;
      }

      if (data === "NAV_CAT") {
        await showCategoriesEdit(chatId, cb.message.message_id);
        return;
      }

      if (data === "NAV_CEK") {
        const txt =
          "🧾 <b>Cek Pesanan</b>\n" +
          "Kirim invoice kamu (contoh: <code>TX1700000000abcd</code>)\n" +
          "Nanti aku cek statusnya.";
        await tgEditMessage(chatId, cb.message.message_id, txt, {
          reply_markup: mainMenuInline(isAdmin),
        });
        return;
      }

      if (data === "NAV_ORDER") {
        const txt =
          "📌 <b>CARA ORDER</b>\n" +
          "1) Klik <b>📦 Kategori</b>\n" +
          "2) Pilih produk\n" +
          "3) Scan QRIS & bayar\n" +
          "4) Klik <b>🧾 Cek Status</b>\n\n" +
          "✅ Setelah sukses, link otomatis dikirim.";
        await tgEditMessage(chatId, cb.message.message_id, txt, {
          reply_markup: mainMenuInline(isAdmin),
        });
        return;
      }

      if (data === "NAV_HELP") {
        const txt =
          "🆘 <b>BANTUAN</b>\n\n" +
          "Kalau QRIS belum muncul, tunggu 10-30 detik lalu coba lagi.\n" +
          "Kalau sudah bayar tapi belum terkirim, klik <b>🧾 Cek Status</b>.\n\n" +
          'Admin: <a href="https://t.me/hellogoms">@hellogoms</a>';
        await tgEditMessage(chatId, cb.message.message_id, txt, {
          reply_markup: mainMenuInline(isAdmin),
        });
        return;
      }

      if (data === "NAV_PING") {
        await tgEditMessage(chatId, cb.message.message_id, "✅ Pong! Bot aktif & siap jualan 🔥", {
          reply_markup: mainMenuInline(isAdmin),
        });
        return;
      }

      if (data === "NAV_ADMIN") {
        if (!isAdmin) {
          await tgAnswerCallback(cb.id, "Bukan admin.", true);
          return;
        }
        await tgEditMessage(chatId, cb.message.message_id, "🛠 <b>Panel Admin</b>\nPilih aksi:", {
          reply_markup: adminPanelInline(),
        });
        return;
      }

      return;
    }

    /* ===== ADMIN ACTIONS ===== */
    if (data.startsWith("ADM_")) {
      if (!isAdmin) {
        await tgAnswerCallback(cb.id, "Bukan admin.", true);
        return;
      }
      await tgAnswerCallback(cb.id, "OK", false);

      if (data === "ADM_ADD_CAT") {
        setAdminState(chatId, "ADD_CAT");
        await tgSendMessage(
          chatId,
          "➕ <b>Tambah Kategori</b>\nKirim <b>nama kategori</b>.\nContoh: <code>APK PREMIUM</code>"
        );
        return;
      }

      if (data === "ADM_DEL_CAT") {
        setAdminState(chatId, "DEL_CAT");
        await tgSendMessage(
          chatId,
          "🗑 <b>Hapus Kategori</b>\nKirim <b>nama kategori</b> yang mau dihapus.\nContoh: <code>APK PREMIUM</code>"
        );
        return;
      }

      if (data === "ADM_ADD_STOCK") {
        setAdminState(chatId, "ADD_STOCK");
        await tgSendMessage(
          chatId,
          "➕ <b>Tambah Stock</b>\nKirim format:\n<code>KATEGORI|PRODUCT_ID|JUMLAH</code>\nContoh:\n<code>APK PREMIUM|12|5</code>"
        );
        return;
      }

      if (data === "ADM_DEL_STOCK") {
        setAdminState(chatId, "DEL_STOCK");
        await tgSendMessage(
          chatId,
          "➖ <b>Kurangi Stock</b>\nKirim format:\n<code>KATEGORI|PRODUCT_ID|JUMLAH</code>\nContoh:\n<code>APK PREMIUM|12|3</code>"
        );
        return;
      }

      if (data === "ADM_BROADCAST") {
        setAdminState(chatId, "BROADCAST");
        await tgSendMessage(
          chatId,
          "📣 <b>Broadcast</b>\nKirim teks broadcast sekarang.\n(Bisa HTML sederhana)"
        );
        return;
      }

      return;
    }

    /* ===== CATEGORIES / PRODUCTS ===== */
    if (data.startsWith("CAT_")) {
      const cat = data.replace("CAT_", "");
      await tgAnswerCallback(cb.id, "Membuka produk...", false);
      await showProducts(chatId, cat, cb.message.message_id);
      return;
    }

    if (data.startsWith("PROD_PAGE_")) {
      const parts = data.split("_"); // PROD_PAGE_{cat}_{page}
      const cat = parts[2];
      const page = Number(parts[3] || 1);
      await tgAnswerCallback(cb.id, "Muat halaman...", false);
      await showProducts(chatId, cat, cb.message.message_id, page);
      return;
    }

    if (data === "BACK_CAT") {
      await tgAnswerCallback(cb.id, "Kembali ke kategori...", false);
      await showCategoriesEdit(chatId, cb.message.message_id);
      return;
    }

    if (data === "NOOP") {
      await tgAnswerCallback(cb.id, "", false);
      return;
    }

    /* ===== BUY / CEK / CANCEL ===== */
    if (data.startsWith("BUY_")) {
      const parts = data.split("_");
      const cat = parts[1];
      const id = parts[2];

      const products = await getProducts(cat);
      const product = products.find((p) => String(p.id) === String(id));
      if (!product) {
        await tgAnswerCallback(cb.id, "Produk tidak ditemukan.", true);
        return;
      }

      const invoice = await createTransaction(product, chatId, cb.from?.username);
      await tgAnswerCallback(cb.id, "Invoice dibuat. Kirim QRIS...", false);
      await sendQRIS(chatId, product, invoice);
      return;
    }

    if (data.startsWith("CEK_")) {
      const invoice = data.replace("CEK_", "");
      await tgAnswerCallback(cb.id, "Cek pembayaran...", false);
      await checkAndDeliver(chatId, invoice);
      return;
    }

    if (data.startsWith("CANCEL_")) {
      const invoice = data.replace("CANCEL_", "");
      await tgAnswerCallback(cb.id, "Membatalkan transaksi...", false);

      const tx = await findTransaction(invoice);
      if (!tx) {
        await tgAnswerCallback(cb.id, "Transaksi tidak ditemukan.", true);
        return;
      }

      // hapus pesan QRIS yg tersimpan (kolom H)
      const row = tx.data;
      const qrMsgId = row[7];
      if (qrMsgId) {
        await tgDeleteMessage(chatId, Number(qrMsgId));
      }

      await markCancelled(tx.rowIndex, row);

      const welcome = await buildWelcomeText();
      await renderMain(chatId, welcome, mainMenuInline(isAdmin));
      return;
    }

    await tgAnswerCallback(cb.id, "OK", false);
    return;
  }

  /* ========== MESSAGE ========== */
  if (!msg) return;

  const chatIdMsg = msg.chat.id;
  const text = (msg.text || "").trim();
  const username = msg.from?.username;

  // spam guard message
  const sp = checkSpam(String(chatIdMsg));
  if (sp.blocked) {
    await tgSendMessage(chatIdMsg, "⚠️ Kamu terlalu cepat spam. Tunggu 1 menit ya.");
    if (sp.reason === "spam" && sp.strike >= SPAM_STRIKE_BAN) {
      if (!(await isBanned(chatIdMsg))) {
        await banUser(chatIdMsg, "AUTO BAN: SPAM (message)");
        await tgSendMessage(chatIdMsg, "❌ Kamu diblokir otomatis karena spam.");
      }
    }
    return;
  }

  if (await isBanned(chatIdMsg)) {
    await tgSendMessage(chatIdMsg, "❌ Kamu diblokir.");
    return;
  }

  // admin multi-step handler
  const st = getAdminState(chatIdMsg);
  if (st && isAdmin) {
    try {
      if (st.action === "ADD_CAT") {
        const ok = await addCategory(text);
        clearAdminState(chatIdMsg);
        await tgSendMessage(chatIdMsg, ok ? "✅ Kategori ditambahkan." : "ℹ️ Kategori sudah ada.");
        return;
      }

      if (st.action === "DEL_CAT") {
        const ok = await deleteCategory(text);
        clearAdminState(chatIdMsg);
        await tgSendMessage(chatIdMsg, ok ? "✅ Kategori dihapus (cell dikosongkan)." : "❌ Kategori tidak ditemukan.");
        return;
      }

      if (st.action === "ADD_STOCK" || st.action === "DEL_STOCK") {
        // format: CAT|ID|N
        const parts = text.split("|").map((s) => s.trim());
        if (parts.length !== 3) throw new Error("Format harus: KATEGORI|PRODUCT_ID|JUMLAH");

        const cat = parts[0];
        const pid = parts[1];
        const n = Number(parts[2]);
        if (!cat || !pid || Number.isNaN(n) || n <= 0) throw new Error("JUMLAH harus angka > 0");

        const delta = st.action === "ADD_STOCK" ? n : -n;
        const r = await updateProductStock(cat, pid, delta);

        clearAdminState(chatIdMsg);
        await tgSendMessage(
          chatIdMsg,
          `✅ Stock updated\n` +
            `📦 ${r.product.name} (ID: <code>${r.product.id}</code>)\n` +
            `Stock: <b>${r.before}</b> → <b>${r.after}</b>`
        );
        return;
      }

      if (st.action === "BROADCAST") {
        clearAdminState(chatIdMsg);
        await tgSendMessage(chatIdMsg, "⏳ Mengirim broadcast...");

        const r = await runBroadcast(text);
        await tgSendMessage(
          chatIdMsg,
          `✅ Broadcast selesai\nTotal: <b>${r.total}</b>\nTerkirim: <b>${r.ok}</b>\nGagal: <b>${r.fail}</b>`
        );
        return;
      }
    } catch (e) {
      clearAdminState(chatIdMsg);
      await tgSendMessage(chatIdMsg, "❌ " + (e?.message || String(e)));
      return;
    }
  }

  // /start -> render main (inline keyboard)
  if (text === "/start") {
    await addMember(chatIdMsg, username);
    const welcome = await buildWelcomeText();
    await renderMain(chatIdMsg, welcome, mainMenuInline(isAdmin));
    return;
  }

  // invoice manual
  if (/^TX\d+[a-f0-9]{4}$/i.test(text)) {
    await checkAndDeliver(chatIdMsg, text);
    return;
  }

  // admin commands optional
  if (isAdmin && text.startsWith("/ban")) {
    const id = (text.split(" ")[1] || "").trim();
    if (!id) return tgSendMessage(chatIdMsg, "Format: /ban CHAT_ID");
    await banUser(id, "Admin ban");
    await tgSendMessage(chatIdMsg, "✅ User diban.");
    return;
  }

  if (isAdmin && text.startsWith("/unban")) {
    const id = (text.split(" ")[1] || "").trim();
    if (!id) return tgSendMessage(chatIdMsg, "Format: /unban CHAT_ID");
    await unbanUser(id);
    await tgSendMessage(chatIdMsg, "✅ User di-unban.");
    return;
  }

  if (isAdmin && text === "/admin") {
    await tgSendMessage(chatIdMsg, "🛠 <b>Panel Admin</b>\nPilih aksi:", {
      reply_markup: adminPanelInline(),
    });
    return;
  }

  // fallback -> arahkan ke /start supaya pakai main page 1 pesan
  await tgSendMessage(chatIdMsg, "Ketik /start untuk buka menu utama 👇");
}

/* ================= ROUTES ================= */
app.get("/", (req, res) => res.send("BOT RUNNING"));
app.get(`/telegram/webhook/${WEBHOOK_SECRET}`, (req, res) => res.send("WEBHOOK OK"));

app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    await handleUpdate(req.body);
    res.sendStatus(200);
  } catch (e) {
    console.log("WEBHOOK ERROR:", e?.message || e);
    res.sendStatus(200);
  }
});

/* ================= SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server started on port", PORT));
