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
  "ADMIN_USERNAME",
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
const ADMIN_USERNAME = String(process.env.ADMIN_USERNAME || "").replace("@", "");
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const SHEET_ID = process.env.SHEET_ID;
const PAYMENT_PROJECT_SLUG = process.env.PAYMENT_PROJECT_SLUG;
const PAYMENT_API_KEY = process.env.PAYMENT_API_KEY;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/* ================= SHEET TABS ================= */
const TAB_CATEGORY = "CATEGORIES";
const TAB_MEMBER = "MEMBER LIST";
const TAB_BANNED = "BANNED";

const TAB_TX = "TRANSAKSI";
const TAB_TX_SUCCESS = "TRANSAKSI BERHASIL";
const TAB_TX_FAIL = "TRANSAKSI GAGAL";

/* ================= TELEGRAM ================= */
async function tg(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

async function tgSendMessage(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function tgEditMessage(chatId, messageId, text, extra = {}) {
  return tg("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function tgSendPhoto(chatId, photo, caption, extra = {}) {
  return tg("sendPhoto", {
    chat_id: chatId,
    photo,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

async function tgDeleteMessage(chatId, messageId) {
  return tg("deleteMessage", { chat_id: chatId, message_id: messageId });
}

async function tgAnswerCallback(cbId, text, showAlert = false) {
  return tg("answerCallbackQuery", {
    callback_query_id: cbId,
    text: text || "",
    show_alert: !!showAlert,
  });
}

/* ================= GOOGLE SHEETS ================= */
const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.JWT(sa.client_email, null, sa.private_key, [
  "https://www.googleapis.com/auth/spreadsheets",
]);

const sheets = google.sheets({ version: "v4", auth });

function qRange(range) {
  if (range.startsWith("'")) return range;
  const idx = range.indexOf("!");
  if (idx === -1) return range;
  const tab = range.slice(0, idx);
  const rest = range.slice(idx);
  return `'${tab}'${rest}`;
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

function escHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isAdmin(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID);
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function getRandomTestimoni() {
  const list = [
    "⭐⭐⭐⭐⭐ Cepet banget, baru bayar langsung beres ⚡",
    "⭐⭐⭐⭐⭐ Aman & trusted, udah order berkali-kali 🔥",
    "⭐⭐⭐⭐⭐ Fast respon, recommended ✅",
    "⭐⭐⭐⭐⭐ Harga masuk, kualitas mantap 💎",
    "⭐⭐⭐⭐⭐ Auto proses, gak nunggu lama 🚀",
  ];
  return randomPick(list);
}

function getRandomAds() {
  const ads = [
    `📣 ADS: Cari NoKos Tele <a href="https://t.me/gomstele24jam_bot">@gomstele24jam_bot</a>`,
    `📣 ADS: Promo harian di <a href="https://t.me/gomstele24jam_bot">klik sini</a>`,
  ];
  return randomPick(ads);
}

/* ================= MAIN MESSAGE (ANTI NUMPUK) ================= */
const MAIN_MSG = new Map(); // chatId -> message_id

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
    } catch {
      // kalau message lama hilang -> kirim baru
    }
  }

  const sent = await tgSendMessage(chatId, text, { reply_markup: replyMarkup });
  const newId = sent?.result?.message_id || sent?.message_id;
  if (newId) setMainMsgId(chatId, newId);
  return newId;
}

/* ================= ANTI SPAM (RAM) ================= */
const spamState = new Map();
const SPAM_WINDOW_MS = 10_000;
const SPAM_MAX_MSG = 8;
const SPAM_STRIKE_BAN = 3;

function checkSpam(chatId) {
  const now = Date.now();
  const st = spamState.get(chatId) || { ts: [], strike: 0, blockedUntil: 0 };

  if (st.blockedUntil && now < st.blockedUntil) {
    spamState.set(chatId, st);
    return { blocked: true, strike: st.strike, reason: "temp" };
  }

  st.ts = st.ts.filter((t) => now - t <= SPAM_WINDOW_MS);
  st.ts.push(now);

  if (st.ts.length > SPAM_MAX_MSG) {
    st.strike += 1;
    st.ts = [];
    st.blockedUntil = now + 60_000;
    spamState.set(chatId, st);
    return { blocked: true, strike: st.strike, reason: "spam" };
  }

  spamState.set(chatId, st);
  return { blocked: false, strike: st.strike };
}

/* ================= MEMBER / BANNED ================= */
async function addMember(chatId, username) {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  const exists = rows.some((r) => String(r[2] || "") === String(chatId));
  if (exists) return;

  const nomor = rows.length;
  await append(`${TAB_MEMBER}!A:C`, [nomor, nowISO(), String(chatId)]);
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
  await append(`${TAB_BANNED}!A:C`, [String(chatId), reason || "AUTO BAN", nowISO()]);
}

/* ================= CATEGORY / PRODUCTS ================= */
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
  if (!res.ok) throw new Error(`PAKASIR CREATE ERROR ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function getPaymentDetail(amount, invoice) {
  const url =
    "https://app.pakasir.com/api/transactiondetail" +
    `?project=${encodeURIComponent(PAYMENT_PROJECT_SLUG)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&order_id=${encodeURIComponent(invoice)}` +
    `&api_key=${encodeURIComponent(PAYMENT_API_KEY)}`;

  const res = await fetch(url);
  const text = await res.text();
  if (!res.ok) throw new Error(`PAKASIR DETAIL ERROR ${res.status}: ${text}`);
  return JSON.parse(text);
}

/* ================= TRANSAKSI (SESUI SHEET KAMU) =================
TRANSAKSI A:H:
A time
B product_id
C product_name
D username/chat
E invoice
F price
G status
H qr_msg_id
*/
function makeInvoice() {
  return "TX" + Date.now() + crypto.randomBytes(2).toString("hex");
}

async function createTransaction(product, chatId, username) {
  const invoice = makeInvoice();

  await append(`${TAB_TX}!A:H`, [
    nowISO(),
    product.id,
    product.name,
    username ? `@${username}` : String(chatId),
    invoice,
    String(product.price || ""),
    "PENDING",
    "", // H QR_MSG_ID
  ]);

  return invoice;
}

async function findTransaction(invoice) {
  const rows = await read(`${TAB_TX}!A:H`);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][4] || "") === String(invoice)) {
      return { rowIndex: i + 1, data: rows[i] };
    }
  }
  return null;
}

async function markSuccess(rowIndex, rowData) {
  await updateCell(`${TAB_TX}!G${rowIndex}`, "SUCCESS");
  await append(`${TAB_TX_SUCCESS}!A:H`, rowData);
  await clearRow(TAB_TX, rowIndex, "H");
}

async function markFailed(rowIndex, rowData, status = "FAILED") {
  await updateCell(`${TAB_TX}!G${rowIndex}`, status);
  await append(`${TAB_TX_FAIL}!A:H`, rowData);
  await clearRow(TAB_TX, rowIndex, "H");
}

async function countSuccessTx() {
  const rows = await read(`${TAB_TX_SUCCESS}!A:H`);
  return Math.max(rows.length - 1, 0);
}

/* ================= UI KEYBOARD ================= */
function mainMenuInline(admin) {
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

  if (admin) rows.push([{ text: "🛠 Panel Admin", callback_data: "NAV_ADMIN" }]);

  return { inline_keyboard: rows };
}

/* ================= PAGES (EDIT biar gak numpuk) ================= */
async function showCategoriesEdit(chatId, messageId) {
  const categories = await getCategories();
  if (!categories.length) {
    await tgEditMessage(chatId, messageId, "⚠️ Kategori kosong. Isi di tab <b>CATEGORIES</b> kolom A.", {
      reply_markup: { inline_keyboard: [[{ text: "🏠 Home", callback_data: "NAV_HOME" }]] },
    });
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
    await tgEditMessage(chatId, messageId, `⚠️ Produk di <b>${escHtml(cat)}</b> kosong.`, {
      reply_markup: {
        inline_keyboard: [
          [{ text: "⬅️ Kembali", callback_data: "BACK_CAT" }],
          [{ text: "🏠 Home", callback_data: "NAV_HOME" }],
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

  keyboard.push([{ text: "⬅️ Kembali", callback_data: "BACK_CAT" }]);
  keyboard.push([{ text: "🏠 Home", callback_data: "NAV_HOME" }]);

  await tgEditMessage(chatId, messageId, `📦 <b>Produk ${escHtml(cat)}</b>\nPilih produk:`, {
    reply_markup: { inline_keyboard: keyboard },
  });
}

/* ================= SEND QRIS (SIMPAN QR_MSG_ID ke kolom H) ================= */
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
    "🧾 <b>Invoice</b>: <code>" + invoice + "</code>\n" +
      "📦 <b>Produk</b>: " + escHtml(product.name) + "\n" +
      "💰 <b>Total</b>: <b>" + rupiah(product.price) + "</b>\n\n" +
      "Silakan scan QRIS di atas.\n" +
      "Setelah bayar, klik <b>🧾 Cek Status</b>.",
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🧾 Cek Status", callback_data: `CEK_${invoice}` }],
          [{ text: "❌ Batalkan", callback_data: `CANCEL_${invoice}` }],
          [{ text: "🏠 Home", callback_data: "NAV_HOME" }],
        ],
      },
    }
  );

  const qrMsgId = sent?.result?.message_id || sent?.message_id;
  const tx = await findTransaction(invoice);
  if (tx && qrMsgId) {
    await updateCell(`${TAB_TX}!H${tx.rowIndex}`, String(qrMsgId)); // ✅ kolom H
  }
}

/* ================= CHECK & DELIVER (HAPUS QR MSG dari kolom H) ================= */
async function checkAndDeliver(chatId, invoice) {
  const tx = await findTransaction(invoice);
  if (!tx) {
    await tgSendMessage(chatId, "❌ Invoice tidak ditemukan.");
    return;
  }

  const row = tx.data;

  const statusSheet = String(row[6] || "").toUpperCase(); // G
  if (statusSheet === "SUCCESS") {
    await tgSendMessage(chatId, "✅ Transaksi sudah berhasil sebelumnya.");
    return;
  }

  const amount = row[5]; // F price
  let detail;
  try {
    detail = await getPaymentDetail(amount, invoice);
  } catch (e) {
    console.log("PAKASIR DETAIL ERROR:", e?.message || e);
    await tgSendMessage(chatId, "⚠️ Gagal cek status. Coba lagi sebentar.");
    return;
  }

  const status = String(detail?.transaction?.status || detail?.status || "").toUpperCase();

  if (status === "COMPLETED" || status === "SUCCESS" || status === "PAID") {
    // cari produk (scan semua kategori)
    const cats = await getCategories();
    let product = null;

    for (const cat of cats) {
      const prods = await getProducts(cat);
      const found = prods.find((p) => String(p.id) === String(row[1])); // B product_id
      if (found) {
        product = found;
        break;
      }
    }

    if (!product) {
      await tgSendMessage(ADMIN_CHAT_ID, `⚠️ Produk tidak ditemukan untuk invoice <code>${invoice}</code>`);
      await tgSendMessage(chatId, "⚠️ Produk tidak ditemukan. Admin sudah diberitahu.");
      return;
    }

    // kurangi stock jika bukan UNLIMITED
    if (String(product.stock).toUpperCase() !== "UNLIMITED") {
      const current = Number(product.stock || 0);
      if (current > 0) await updateCell(`${product.tab}!E${product.rowIndex}`, String(current - 1));
    }

    // ✅ hapus pesan QR pakai kolom H
    const qrMsgId = row[7]; // H
    if (qrMsgId) {
      try { await tgDeleteMessage(chatId, Number(qrMsgId)); } catch {}
      try { await updateCell(`${TAB_TX}!H${tx.rowIndex}`, ""); } catch {}
    }

    await markSuccess(tx.rowIndex, row);

    await tgSendMessage(
      chatId,
      `✅ <b>Pembayaran Berhasil!</b>\n\n` +
        `📦 <b>${escHtml(product.name)}</b>\n\n` +
        `🔗 <b>Link:</b>\n${escHtml(product.link)}\n\n` +
        `Terima kasih 🙏`
    );
    return;
  }

  if (status === "EXPIRED" || status === "FAILED" || status === "CANCELLED") {
    // hapus QR message kalau ada
    const qrMsgId = row[7];
    if (qrMsgId) {
      try { await tgDeleteMessage(chatId, Number(qrMsgId)); } catch {}
      try { await updateCell(`${TAB_TX}!H${tx.rowIndex}`, ""); } catch {}
    }

    await markFailed(tx.rowIndex, row, status);
    await tgSendMessage(chatId, "❌ Transaksi gagal / expired.");
    return;
  }

  await tgSendMessage(chatId, "⏳ Status: <b>MENUNGGU PEMBAYARAN</b>\nCoba cek lagi setelah bayar ya.");
}

/* ================= WELCOME TEXT ================= */
async function buildWelcome(chatId) {
  let totalMember = await countMembers();
  let totalSuccess = await countSuccessTx();

  const testimoni = getRandomTestimoni();
  const ads = getRandomAds();

  const adminLine = ADMIN_USERNAME
    ? `Admin: <a href="https://t.me/${ADMIN_USERNAME}">@${ADMIN_USERNAME}</a>`
    : `Admin: @${ADMIN_USERNAME || "admin"}`;

  return (
    `🎉 <b>WELCOME</b> 🎉\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📊 <b>STATISTIK</b>\n` +
    `👥 Member: <b>${totalMember}</b>\n` +
    `✅ Transaksi Sukses: <b>${totalSuccess}</b>\n\n` +
    `💬 <b>Testimoni</b>\n` +
    `<pre>${escHtml(testimoni)}</pre>\n\n` +
    `📌 <b>PILIH MENU</b> 👇\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${ads}\n\n` +
    `${adminLine}`
  );
}

/* ================= HANDLE UPDATE ================= */
async function handleUpdate(update) {
  const msg = update.message;
  const cb = update.callback_query;

  const from = msg?.from || cb?.from;
  const chat = msg?.chat || cb?.message?.chat;

  const chatIdGlobal = chat?.id;
  const usernameGlobal = from?.username || "";

  /* ===== CALLBACK ===== */
  if (cb) {
    const chatIdCb = cb.message?.chat?.id;
    const data = cb.data || "";
    if (!chatIdCb) return;

    const sp = checkSpam(String(chatIdCb));
    if (sp.blocked) {
      await tgAnswerCallback(cb.id, "Terlalu cepat. Tunggu sebentar.", false);
      if (sp.reason === "spam" && sp.strike >= SPAM_STRIKE_BAN) {
        if (!(await isBanned(chatIdCb))) {
          await banUser(chatIdCb, "AUTO BAN: SPAM (callback)");
          await tgSendMessage(chatIdCb, "❌ Kamu diblokir otomatis karena spam.");
        }
      }
      return;
    }

    if (await isBanned(chatIdCb)) {
      await tgAnswerCallback(cb.id, "Kamu diblokir.", true);
      return;
    }

    if (data === "NOOP") {
      await tgAnswerCallback(cb.id, "", false);
      return;
    }

    if (data === "NAV_HOME") {
      await tgAnswerCallback(cb.id, "OK", false);
      const welcome = await buildWelcome(chatIdCb);
      await renderMain(chatIdCb, welcome, mainMenuInline(isAdmin(chatIdCb)));
      return;
    }

    if (data === "NAV_CAT") {
      await tgAnswerCallback(cb.id, "OK", false);
      await showCategoriesEdit(chatIdCb, cb.message.message_id);
      return;
    }

    if (data === "NAV_CEK") {
      await tgAnswerCallback(cb.id, "OK", false);
      await tgEditMessage(
        chatIdCb,
        cb.message.message_id,
        `🧾 <b>Cek Pesanan</b>\n\nKirim invoice kamu (contoh: <code>TX1700000000abcd</code>)`,
        { reply_markup: mainMenuInline(isAdmin(chatIdCb)) }
      );
      return;
    }

    if (data === "NAV_ORDER") {
      await tgAnswerCallback(cb.id, "OK", false);
      await tgEditMessage(
        chatIdCb,
        cb.message.message_id,
        `📌 <b>CARA ORDER</b>\n` +
          `1) Klik <b>📦 Kategori</b>\n` +
          `2) Pilih produk\n` +
          `3) Scan QRIS & bayar\n` +
          `4) Klik <b>🧾 Cek Status</b>\n\n` +
          `✅ Setelah sukses, link dikirim otomatis.`,
        { reply_markup: mainMenuInline(isAdmin(chatIdCb)) }
      );
      return;
    }

    if (data === "NAV_HELP") {
      await tgAnswerCallback(cb.id, "OK", false);
      const adminLine = ADMIN_USERNAME
        ? `Admin: <a href="https://t.me/${ADMIN_USERNAME}">@${ADMIN_USERNAME}</a>`
        : `Admin: @${ADMIN_USERNAME || "admin"}`;

      await tgEditMessage(
        chatIdCb,
        cb.message.message_id,
        `🆘 <b>BANTUAN</b>\n\n` +
          `Kalau QRIS belum muncul, tunggu 10-30 detik lalu coba lagi.\n` +
          `Kalau sudah bayar tapi belum terkirim, klik <b>🧾 Cek Status</b>.\n\n` +
          `${adminLine}`,
        { reply_markup: mainMenuInline(isAdmin(chatIdCb)) }
      );
      return;
    }

    if (data === "NAV_PING") {
      await tgAnswerCallback(cb.id, "OK", false);
      await tgEditMessage(chatIdCb, cb.message.message_id, "✅ Pong! Bot aktif 🔥", {
        reply_markup: mainMenuInline(isAdmin(chatIdCb)),
      });
      return;
    }

    // category select
    if (data.startsWith("CAT_")) {
      const cat = data.replace("CAT_", "");
      await tgAnswerCallback(cb.id, "Membuka produk...", false);
      await showProducts(chatIdCb, cat, cb.message.message_id, 1);
      return;
    }

    // pagination
    if (data.startsWith("PROD_PAGE_")) {
      const parts = data.split("_"); // PROD_PAGE_{cat}_{page}
      const cat = parts[2];
      const page = Number(parts[3] || 1);
      await tgAnswerCallback(cb.id, "OK", false);
      await showProducts(chatIdCb, cat, cb.message.message_id, page);
      return;
    }

    if (data === "BACK_CAT") {
      await tgAnswerCallback(cb.id, "OK", false);
      await showCategoriesEdit(chatIdCb, cb.message.message_id);
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

      const invoice = await createTransaction(product, chatIdCb, cb.from?.username);
      await tgAnswerCallback(cb.id, "Invoice dibuat. Membuat QRIS...", false);
      await sendQRIS(chatIdCb, product, invoice);
      return;
    }

    // CEK STATUS
    if (data.startsWith("CEK_")) {
      const invoice = data.replace("CEK_", "");
      await tgAnswerCallback(cb.id, "Cek pembayaran...", false);
      await checkAndDeliver(chatIdCb, invoice);
      return;
    }

    // CANCEL (HAPUS QR MSG ID KOL H + HAPUS PESAN YANG DIKLIK + BALIK MENU)
    if (data.startsWith("CANCEL_")) {
      const invoice = data.replace("CANCEL_", "");
      await tgAnswerCallback(cb.id, "Membatalkan...", false);

      const tx = await findTransaction(invoice);
      if (!tx) {
        await tgAnswerCallback(cb.id, "Transaksi tidak ditemukan.", true);
        return;
      }

      const row = tx.data;

      // hapus pesan QR/invoice yang tersimpan di kolom H
      const qrMsgId = row[7]; // H
      if (qrMsgId) {
        try { await tgDeleteMessage(chatIdCb, Number(qrMsgId)); } catch {}
        try { await updateCell(`${TAB_TX}!H${tx.rowIndex}`, ""); } catch {}
      }

      // set status CANCELLED di kolom G
      await updateCell(`${TAB_TX}!G${tx.rowIndex}`, "CANCELLED");

      // pindah ke gagal & hapus baris transaksi
      await markFailed(tx.rowIndex, row, "CANCELLED");

      // hapus pesan yang sedang diklik (yang ada tombol batalkan)
      try { await tgDeleteMessage(chatIdCb, cb.message.message_id); } catch {}

      // balik menu utama (1 pesan)
      const welcome = await buildWelcome(chatIdCb);
      await renderMain(chatIdCb, welcome, mainMenuInline(isAdmin(chatIdCb)));
      return;
    }

    await tgAnswerCallback(cb.id, "OK", false);
    return;
  }

  /* ===== MESSAGE ===== */
  if (!msg) return;

  const chatIdMsg = msg.chat.id;
  const text = (msg.text || "").trim();
  const username = msg.from?.username || "";

  const sp = checkSpam(String(chatIdMsg));
  if (sp.blocked) {
    await tgSendMessage(chatIdMsg, "⚠️ Terlalu cepat. Tunggu 1 menit ya.");
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

  if (text === "/start") {
    await addMember(chatIdMsg, usernameGlobal);

    // hilangkan tombol bawah lama (reply keyboard) jika pernah ada
    await tg("sendMessage", {
      chat_id: chatIdMsg,
      text: "✅ Menu siap.",
      reply_markup: { remove_keyboard: true },
    });

    const welcome = await buildWelcome(chatIdMsg);
    await renderMain(chatIdMsg, welcome, mainMenuInline(isAdmin(chatIdMsg)));
    return;
  }

  // user kirim invoice manual
  if (/^TX\d+[a-f0-9]{4}$/i.test(text)) {
    await checkAndDeliver(chatIdMsg, text);
    return;
  }

  await tgSendMessage(chatIdMsg, "Ketik /start untuk membuka menu.");
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
