// service.js (FULL - copy paste)

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
      {
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      },
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
    return await tg("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
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
    // NOTE: kalau message_id invalid (message deleted / too old) bisa error di sini
    console.log("TG editMessageText error:", e?.message || e);
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

/* ================= ANTI SPAM (RAM only) ================= */
const spamState = new Map();
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
  const exists = rows.some(
    (r) => String(r[2] || "") === String(username ? `@${username}` : chatId)
  );
  if (exists) return;

  const nomor = rows.length; // numbering
  await append(`${TAB_MEMBER}!A:C`, [
    nomor,
    nowISO(),
    username ? `@${username}` : String(chatId),
  ]);
}

async function countMembers() {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  return Math.max(rows.length - 1, 0);
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
    await clearRow(TAB_BANNED, idx + 1, "C"); // header offset
  }
}

/* ================= CATEGORY & PRODUCTS ================= */
async function getCategories() {
  const rows = await read(`${TAB_CATEGORY}!A:A`);
  const cats = rows.map((r) => (r[0] || "").trim()).filter(Boolean);
  if (cats.length && cats[0].toUpperCase().includes("CATEG")) return cats.slice(1);
  return cats;
}

async function getProducts(category) {
  const rows = await read(`${category}!A:F`);
  const data = rows.slice(1);
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

  console.log("PAKASIR STATUS:", res.status);
  console.log("PAKASIR BODY:", text);

  if (!res.ok) throw new Error("PAKASIR ERROR " + res.status + ": " + text);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
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
  console.log("PAKASIR CREATE STATUS:", res.status);
  console.log("PAKASIR CREATE BODY:", text);

  if (!res.ok) throw new Error("PAKASIR CREATE ERROR " + res.status + ": " + text);

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("PAKASIR CREATE NOT JSON: " + text);
  }

  return data;
}

/* ================= TRANSAKSI ================= */
async function createTransaction(product, chatId, username) {
  const invoice = "TX" + Date.now() + crypto.randomBytes(2).toString("hex");

  await append(`${TAB_TX}!A:H`, [
    nowISO(),
    product.id,
    product.name,
    username ? `@${username}` : String(chatId),
    invoice,
    product.price,
    "PENDING",
    "", // H = QR_MSG_ID
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
  await append(`${TAB_TX_SUCCESS}!A:G`, rowData);
  await clearRow(TAB_TX, rowIndex, "G");
}

async function markFailed(rowIndex, rowData) {
  await updateCell(`${TAB_TX}!G${rowIndex}`, "FAILED");
  await append(`${TAB_TX_FAIL}!A:G`, rowData);
  await clearRow(TAB_TX, rowIndex, "G");
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

  console.log("PAKASIR CREATE PAY:", JSON.stringify(pay));
  console.log("QR STRING:", qrString);

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
      "Setelah bayar, klik tombol <b>🔄 Cek Status</b>.",
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
  console.log("QR MSG ID SAVED:", qrMsgId);

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
  let detail;
  try {
    detail = await getPaymentDetail(amount, invoice);
  } catch (e) {
    console.log("PAYMENT DETAIL ERROR:", e?.message || e);
    await tgSendMessage(chatId, "⚠️ Gagal cek status pembayaran. Coba lagi sebentar.");
    return;
  }

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

    // reduce stock
    if (String(product.stock).toUpperCase() !== "UNLIMITED") {
      const current = Number(product.stock || 0);
      if (current > 0) {
        await updateCell(`${product.tab}!E${product.rowIndex}`, String(current - 1));
      }
    }

    // delete QR message if exists
    const qrMsgId = row[7]; // kolom H
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

  await tgSendMessage(
    chatId,
    "⏳ Status: <b>MENUNGGU PEMBAYARAN</b>\nCoba cek lagi setelah bayar ya."
  );
}

/* ================= UI: MAIN PAGE (1 pesan, selalu di-edit) ================= */
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
      await tgEditMessage(chatId, mid, text, { reply_markup: replyMarkup });
      return mid;
    } catch {}
  }

  const sent = await tgSendMessage(chatId, text, { reply_markup: replyMarkup });

  const newId =
    sent?.message_id || sent?.result?.message_id || sent?.result?.message?.message_id;

  if (newId) setMainMsgId(chatId, newId);
  return newId;
}

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

async function buildWelcomeText(chatId) {
  let totalMember = await countMembers();
  if (totalMember < 50) totalMember = marketingMemberFallback();

  let totalSuccess = await countSuccessTx();
  if (totalSuccess < 20) totalSuccess = marketingSuccessFallback();

  const testimoni = getRandomTestimoni();
  const randomAds = getRandomAds();

  return (
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
    `${randomAds}`
  );
}

/* ================= MENUS ================= */
async function showCategoriesEdit(chatId, messageId) {
  const categories = await getCategories();
  if (!categories.length) {
    await tgEditMessage(
      chatId,
      messageId,
      "⚠️ Kategori kosong. Isi dulu di sheet tab <b>CATEGORIES</b>.",
      { reply_markup: { inline_keyboard: [[{ text: "🏠 Home", callback_data: "NAV_HOME" }]] } }
    );
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
        inline_keyboard: [
          [
            { text: "⬅️ Kembali", callback_data: "BACK_CAT" },
            { text: "🏠 Home", callback_data: "NAV_HOME" },
          ],
        ],
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

  await tgEditMessage(
    chatId,
    messageId,
    `📦 <b>Produk ${cat}</b>\nPilih salah satu:`,
    { reply_markup: { inline_keyboard: keyboard } }
  );
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
    String(chatIdGlobal) === process.env.ADMIN_CHAT_ID ||
    String(usernameGlobal || "") === String(process.env.ADMIN_USERNAME || "").replace("@", "");

  /* -------- CALLBACK -------- */
  if (cb) {
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const data = cb.data || "";
    if (!chatId || !messageId) return;

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

    // NAV menu
    if (data.startsWith("NAV_")) {
      await tgAnswerCallback(cb.id, "OK", false);

      if (data === "NAV_HOME") {
        const welcome = await buildWelcomeText(chatId);
        await renderMain(chatId, welcome, mainMenuInline(isAdmin));
        return;
      }

      if (data === "NAV_CAT") {
        await showCategoriesEdit(chatId, messageId);
        return;
      }

      if (data === "NAV_CEK") {
        const txt =
          "🧾 <b>Cek Pesanan</b>\n" +
          "Kirim invoice kamu (contoh: <code>TX1700000000abcd</code>)\n" +
          "Nanti aku cek statusnya.";
        await tgEditMessage(chatId, messageId, txt, { reply_markup: mainMenuInline(isAdmin) });
        return;
      }

      if (data === "NAV_ORDER") {
        const txt =
          "📌 <b>CARA ORDER</b>\n" +
          "1) Klik <b>📦 Kategori</b>\n" +
          "2) Pilih produk\n" +
          "3) Scan QRIS & bayar\n" +
          "4) Klik <b>🔄 Cek Status</b>\n\n" +
          "✅ Setelah sukses, link otomatis dikirim.";
        await tgEditMessage(chatId, messageId, txt, { reply_markup: mainMenuInline(isAdmin) });
        return;
      }

      if (data === "NAV_HELP") {
        const txt =
          "🆘 <b>BANTUAN</b>\n\n" +
          "Kalau QRIS belum muncul, tunggu 10-30 detik lalu coba lagi.\n" +
          "Kalau sudah bayar tapi belum terkirim, klik <b>🔄 Cek Status</b>.\n\n" +
          'Admin: <a href="https://t.me/hellogoms">@hellogoms</a>';
        await tgEditMessage(chatId, messageId, txt, { reply_markup: mainMenuInline(isAdmin) });
        return;
      }

      if (data === "NAV_PING") {
        await tgEditMessage(chatId, messageId, "✅ Pong! Bot aktif & siap jualan 🔥", {
          reply_markup: mainMenuInline(isAdmin),
        });
        return;
      }

      if (data === "NAV_ADMIN") {
        await tgEditMessage(chatId, messageId, "🛠 <b>Panel Admin</b>\n\n(coming soon)", {
          reply_markup: mainMenuInline(isAdmin),
        });
        return;
      }

      return;
    }

    // CAT -> products
    if (data.startsWith("CAT_")) {
      const cat = data.replace("CAT_", "");
      await tgAnswerCallback(cb.id, "Membuka produk...", false);
      await showProducts(chatId, cat, messageId);
      return;
    }

    // pagination
    if (data.startsWith("PROD_PAGE_")) {
      const parts = data.split("_");
      const cat = parts[2];
      const page = Number(parts[3] || 1);
      await tgAnswerCallback(cb.id, "Muat halaman...", false);
      await showProducts(chatId, cat, messageId, page);
      return;
    }

    // back to categories
    if (data === "BACK_CAT") {
      await tgAnswerCallback(cb.id, "Kembali ke kategori...", false);
      await showCategoriesEdit(chatId, messageId);
      return;
    }

    // NOOP
    if (data === "NOOP") {
      await tgAnswerCallback(cb.id, "", false);
      return;
    }

    // BUY
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

    // CEK
    if (data.startsWith("CEK_")) {
      const invoice = data.replace("CEK_", "");
      await tgAnswerCallback(cb.id, "Cek pembayaran...", false);
      await checkAndDeliver(chatId, invoice);
      return;
    }

    // CANCEL
    if (data.startsWith("CANCEL_")) {
      const invoice = data.replace("CANCEL_", "");
      await tgAnswerCallback(cb.id, "Membatalkan transaksi...", false);

      const tx = await findTransaction(invoice);
      if (!tx) {
        await tgAnswerCallback(cb.id, "Transaksi tidak ditemukan.", true);
        return;
      }

      await updateCell(`${TAB_TX}!G${tx.rowIndex}`, "CANCELLED");

      await tgEditMessage(
        chatId,
        messageId,
        "❌ <b>Transaksi dibatalkan.</b>\n\nSilakan kembali ke menu.",
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🏠 Home", callback_data: "NAV_HOME" }]],
          },
        }
      );
      return;
    }

    await tgAnswerCallback(cb.id, "OK", false);
    return;
  }

  /* -------- MESSAGE -------- */
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const username = msg.from?.username;

  const sp = checkSpam(String(chatId));
  if (sp.blocked) {
    await tgSendMessage(chatId, "⚠️ Kamu terlalu cepat spam. Tunggu 1 menit ya.");
    if (sp.reason === "spam" && sp.strike >= SPAM_STRIKE_BAN) {
      if (!(await isBanned(chatId))) {
        await banUser(chatId, "AUTO BAN: SPAM (message)");
        await tgSendMessage(chatId, "❌ Kamu diblokir otomatis karena spam.");
      }
    }
    return;
  }

  if (await isBanned(chatId)) {
    await tgSendMessage(chatId, "❌ Kamu diblokir.");
    return;
  }

  // /start
  if (text === "/start") {
    await addMember(chatId, username);
    const welcome = await buildWelcomeText(chatId);
    await renderMain(chatId, welcome, mainMenuInline(isAdmin));
    return;
  }

  // invoice manual
  if (/^TX\d+[a-f0-9]{4}$/i.test(text)) {
    await checkAndDeliver(chatId, text);
    return;
  }

  // admin commands (optional)
  if (isAdmin && text.startsWith("/ban")) {
    const id = (text.split(" ")[1] || "").trim();
    if (!id) return tgSendMessage(chatId, "Format: /ban CHAT_ID");
    await banUser(id, "Admin ban");
    await tgSendMessage(chatId, "✅ User diban.");
    return;
  }

  if (isAdmin && text.startsWith("/unban")) {
    const id = (text.split(" ")[1] || "").trim();
    if (!id) return tgSendMessage(chatId, "Format: /unban CHAT_ID");
    await unbanUser(id);
    await tgSendMessage(chatId, "✅ User di-unban.");
    return;
  }

  // fallback: tampilkan menu utama lagi (TIDAK pakai reply keyboard, biar gak numpuk)
  const welcome = await buildWelcomeText(chatId);
  await renderMain(chatId, welcome, mainMenuInline(isAdmin));
}

/* ================= ROUTES ================= */

// health
app.get("/", (req, res) => res.send("BOT RUNNING"));

// webhook test (GET)
app.get(`/telegram/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  res.send("WEBHOOK OK");
});

// telegram webhook (POST)
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
