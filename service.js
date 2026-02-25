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

/*
TRANSAKSI A:H (sesuai screenshot)
A time
B product_id
C product_name
D buyer (username/chat)
E invoice
F price
G status
H QR_MSG_ID
*/

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

async function tgAnswerCallback(cbId, text = "", showAlert = false) {
  return tg("answerCallbackQuery", {
    callback_query_id: cbId,
    text,
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

/* ===== Sheet management (add/delete sheet tab) ===== */
async function getSpreadsheetMeta() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return meta.data;
}

async function findSheetIdByTitle(title) {
  const meta = await getSpreadsheetMeta();
  const s = (meta.sheets || []).find((x) => x.properties?.title === title);
  return s?.properties?.sheetId ?? null;
}

async function createSheetTab(title) {
  const meta = await getSpreadsheetMeta();
  const exists = (meta.sheets || []).some((x) => x.properties?.title === title);
  if (exists) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [{ addSheet: { properties: { title } } }],
    },
  });

  // header A:F
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: qRange(`${title}!A1:F1`),
    valueInputOption: "RAW",
    requestBody: {
      values: [["id", "name", "link", "desc", "stock", "price"]],
    },
  });
}

async function deleteSheetTab(title) {
  const sheetId = await findSheetIdByTitle(title);
  if (sheetId == null) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests: [{ deleteSheet: { sheetId } }] },
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
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function isAdmin(chatId, username = "") {
  if (String(chatId) === String(ADMIN_CHAT_ID)) return true;
  if (ADMIN_USERNAME && String(username || "").toLowerCase() === ADMIN_USERNAME.toLowerCase())
    return true;
  return false;
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
    } catch {}
  }

  const sent = await tgSendMessage(chatId, text, { reply_markup: replyMarkup });
  const newId = sent?.result?.message_id || sent?.message_id;
  if (newId) setMainMsgId(chatId, newId);
  return newId;
}

/* ================= ANTI SPAM (RAM) ================= */
const spamState = new Map();
const SPAM_WINDOW_MS = 10_000;
const SPAM_MAX_MSG = 10;
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
async function addMember(chatId) {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  const exists = rows.some((r) => String(r[2] || "") === String(chatId));
  if (exists) return;

  const nomor = rows.length;
  await append(`${TAB_MEMBER}!A:C`, [nomor, nowISO(), String(chatId)]);
}

async function getAllMembersChatIds() {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  const ids = rows.slice(1).map((r) => String(r[2] || "").trim()).filter(Boolean);
  // uniq
  return [...new Set(ids)];
}

async function isBanned(chatId) {
  const rows = await read(`${TAB_BANNED}!A:C`);
  return rows.some((r) => String(r[0]) === String(chatId));
}

async function banUser(chatId, reason) {
  await append(`${TAB_BANNED}!A:C`, [String(chatId), reason || "AUTO BAN", nowISO()]);
}

/* ================= CATEGORY & PRODUCTS ================= */
async function getCategories() {
  const rows = await read(`${TAB_CATEGORY}!A:A`);
  const cats = rows.map((r) => (r[0] || "").trim()).filter(Boolean);
  if (cats.length && cats[0].toUpperCase().includes("CATEG")) return cats.slice(1);
  return cats;
}

async function addCategory(name) {
  const n = String(name || "").trim();
  if (!n) return { ok: false, msg: "Nama kategori kosong." };
  const cats = await getCategories();
  if (cats.includes(n)) return { ok: false, msg: "Kategori sudah ada." };

  await append(`${TAB_CATEGORY}!A:A`, [n]);
  await createSheetTab(n);
  return { ok: true, msg: "Kategori ditambahkan." };
}

async function removeCategory(name) {
  const n = String(name || "").trim();
  const rows = await read(`${TAB_CATEGORY}!A:A`);
  const idx = rows.findIndex((r, i) => i > 0 && String(r[0] || "").trim() === n);
  if (idx === -1) return { ok: false, msg: "Kategori tidak ditemukan." };

  // clear row in categories
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: qRange(`${TAB_CATEGORY}!A${idx + 1}:A${idx + 1}`),
  });

  // delete sheet tab
  await deleteSheetTab(n);

  return { ok: true, msg: "Kategori dihapus." };
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

async function addProduct(cat, payload) {
  // format: ID|NAME|LINK|DESC|STOCK|PRICE
  const parts = String(payload || "").split("|").map((x) => x.trim());
  if (parts.length < 6) {
    return { ok: false, msg: "Format salah. Gunakan: ID|NAME|LINK|DESC|STOCK|PRICE" };
  }
  const [id, name, link, desc, stock, price] = parts;
  if (!id || !name) return { ok: false, msg: "ID dan NAME wajib." };
  await append(`${cat}!A:F`, [id, name, link, desc, stock, price]);
  return { ok: true, msg: "Produk ditambahkan." };
}

async function deleteProduct(cat, rowIndex) {
  await clearRow(cat, rowIndex, "F");
  return { ok: true, msg: "Produk dihapus." };
}

async function setProductPrice(cat, rowIndex, price) {
  await updateCell(`${cat}!F${rowIndex}`, String(price));
  return { ok: true, msg: "Harga diupdate." };
}

async function setProductStock(cat, rowIndex, stock) {
  await updateCell(`${cat}!E${rowIndex}`, String(stock));
  return { ok: true, msg: "Stock diupdate." };
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

/* ================= TRANSAKSI ================= */
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

/* ================= WELCOME (Stat muter + jualan keras) ================= */
function buildWelcomeText() {
  const baseMember = 250;
  const baseSuccess = 270;
  const seed = Math.floor(Date.now() / 60000); // berubah tiap menit

  const totalMember = baseMember + (seed % 50);
  const totalSuccess = baseSuccess + (seed % 40);

  const testimoni = pick([
    "⭐⭐⭐⭐⭐ Cepet banget prosesnya, trusted ✅",
    "⭐⭐⭐⭐⭐ Baru bayar langsung beres ⚡",
    "⭐⭐⭐⭐⭐ Recommended, order berkali-kali aman 🔥",
    "⭐⭐⭐⭐⭐ Fast respon & rapih 🧾",
  ]);

  const ads = pick([
    `📣 <b>IKLAN SPONSOR</b>\nADS: Cari NoKos Tele <a href="https://t.me/gomstele24jam_bot">@gomstele24jam_bot</a>`,
    `📣 <b>IKLAN SPONSOR</b>\nADS: Promo harian 👉 <a href="https://t.me/gomstele24jam_bot">klik sini</a>`,
  ]);

  const adminLine = ADMIN_USERNAME
    ? `Admin: <a href="https://t.me/${ADMIN_USERNAME}">@${ADMIN_USERNAME}</a>`
    : `Admin: @admin`;

  return (
    `🎉 <b>WELCOME TO GOMS APK MOD</b> 🎉\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `📱 <b>APK KHUSUS ANDROID</b>\n` +
    `⚡ <b>AUTO KIRIM</b> • Cepat • Aman\n\n` +
    `📊 <b>STATISTIK TOKO</b>\n` +
    `👥 Member: <b>${totalMember}</b>\n` +
    `✅ Transaksi Sukses: <b>${totalSuccess}</b>\n\n` +
    `💬 <b>Testimoni Pembeli</b>\n` +
    `<pre>${escHtml(testimoni)}</pre>\n\n` +
    `📌 <b>PILIH MENU</b> 👇\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `${ads}\n\n` +
    `${adminLine}`
  );
}

/* ================= PAGES (kategori / produk) ================= */
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

function bestSellerLabelFor(products) {
  // Best seller = stock paling kecil (numeric), abaikan UNLIMITED
  const nums = products
    .map((p) => {
      const s = String(p.stock || "").toUpperCase();
      if (s === "UNLIMITED") return null;
      const n = Number(p.stock);
      return Number.isFinite(n) ? n : null;
    })
    .filter((x) => x != null);

  if (!nums.length) {
    return products[0]?.id ? String(products[0].id) : null;
  }
  const min = Math.min(...nums);
  const pickP = products.find((p) => Number(p.stock) === min);
  return pickP?.id ? String(pickP.id) : null;
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

  const bestId = bestSellerLabelFor(products);

  const start = (page - 1) * perPage;
  const slice = products.slice(start, start + perPage);

  const keyboard = slice.map((p) => {
    const isBest = bestId && String(p.id) === String(bestId);
    const title = isBest ? `⭐ BEST SELLER\n${p.name}` : p.name;
    return [{ text: `${title} — ${rupiah(p.price)}`, callback_data: `BUY_${cat}_${p.id}` }];
  });

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

/* ================= SEND QRIS (simpan QR_MSG_ID kolom H) ================= */
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
    "https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=" + encodeURIComponent(qrString);

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
    await updateCell(`${TAB_TX}!H${tx.rowIndex}`, String(qrMsgId));
  }
}

/* ================= CHECK & DELIVER (hapus QR by QR_MSG_ID kolom H) ================= */
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
    // find product by scanning categories
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

    // reduce stock if not UNLIMITED
    if (String(product.stock).toUpperCase() !== "UNLIMITED") {
      const current = Number(product.stock || 0);
      if (current > 0) await updateCell(`${product.tab}!E${product.rowIndex}`, String(current - 1));
    }

    // delete QR message using column H
    const qrMsgId = row[7];
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

/* ================= ADMIN STATE (RAM) ================= */
const adminState = new Map(); 
// key: chatId -> { mode: "...", data: {...} }

function setAdminState(chatId, mode, data = {}) {
  adminState.set(String(chatId), { mode, data });
}
function getAdminState(chatId) {
  return adminState.get(String(chatId)) || null;
}
function clearAdminState(chatId) {
  adminState.delete(String(chatId));
}

/* ================= ADMIN UI ================= */
function adminMenuInline() {
  return {
    inline_keyboard: [
      [{ text: "📊 Dashboard", callback_data: "ADM_DASH" }],
      [{ text: "📢 Broadcast", callback_data: "ADM_BC" }],
      [{ text: "📁 Kelola Kategori", callback_data: "ADM_CAT" }],
      [{ text: "📦 Kelola Produk", callback_data: "ADM_PROD" }],
      [{ text: "🏠 Home", callback_data: "NAV_HOME" }],
    ],
  };
}

async function showAdminHome(chatId, messageId) {
  await tgEditMessage(chatId, messageId, "🛠 <b>PANEL ADMIN</b>\nPilih menu:", {
    reply_markup: adminMenuInline(),
  });
}

async function showAdminDashboard(chatId, messageId) {
  const members = await getAllMembersChatIds();
  const suc = await read(`${TAB_TX_SUCCESS}!A:H`);
  const fail = await read(`${TAB_TX_FAIL}!A:H`);
  const totalSuccess = Math.max(suc.length - 1, 0);
  const totalFail = Math.max(fail.length - 1, 0);

  await tgEditMessage(
    chatId,
    messageId,
    `📊 <b>DASHBOARD</b>\n\n` +
      `👥 Member: <b>${members.length}</b>\n` +
      `✅ Sukses: <b>${totalSuccess}</b>\n` +
      `❌ Gagal: <b>${totalFail}</b>\n\n` +
      `TRANSAKSI aktif ada di tab <b>${TAB_TX}</b>.`,
    { reply_markup: adminMenuInline() }
  );
}

/* ================= ADMIN: BROADCAST ================= */
async function startBroadcast(chatId, messageId) {
  setAdminState(chatId, "BC_WAIT_TEXT", { messageId });
  await tgEditMessage(
    chatId,
    messageId,
    `📢 <b>BROADCAST</b>\n\nKirim teks broadcast sekarang.\n\n` +
      `Tips: bisa pakai HTML <b>bold</b>, <code>code</code>.`,
    { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "NAV_ADMIN" }]] } }
  );
}

async function runBroadcast(chatId, text) {
  const members = await getAllMembersChatIds();
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < members.length; i++) {
    const id = members[i];
    try {
      await tgSendMessage(id, text);
      ok += 1;
    } catch {
      fail += 1;
    }
    // delay kecil biar aman (anti flood)
    await new Promise((r) => setTimeout(r, 35));
  }

  return { ok, fail, total: members.length };
}

/* ================= ADMIN: CATEGORY MGMT ================= */
async function showCategoryMgmt(chatId, messageId) {
  const cats = await getCategories();

  const kb = [];
  kb.push([{ text: "➕ Tambah Kategori", callback_data: "ADM_CAT_ADD" }]);

  if (cats.length) {
    kb.push([{ text: "🗑 Hapus Kategori", callback_data: "ADM_CAT_DEL" }]);
  }

  kb.push([{ text: "⬅️ Kembali", callback_data: "NAV_ADMIN" }]);

  await tgEditMessage(chatId, messageId, `📁 <b>KELOLA KATEGORI</b>\nTotal: <b>${cats.length}</b>`, {
    reply_markup: { inline_keyboard: kb },
  });
}

async function startAddCategory(chatId, messageId) {
  setAdminState(chatId, "CAT_ADD_WAIT_NAME", { messageId });
  await tgEditMessage(
    chatId,
    messageId,
    `➕ <b>Tambah Kategori</b>\n\nKirim nama kategori (contoh: <code>APK NONTON</code>)`,
    { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "ADM_CAT" }]] } }
  );
}

async function showDeleteCategoryList(chatId, messageId) {
  const cats = await getCategories();
  if (!cats.length) {
    await tgEditMessage(chatId, messageId, "Tidak ada kategori.", {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "ADM_CAT" }]] },
    });
    return;
  }

  const kb = cats.map((c) => [{ text: `🗑 ${c}`, callback_data: `ADM_CAT_DEL_DO_${c}` }]);
  kb.push([{ text: "⬅️ Kembali", callback_data: "ADM_CAT" }]);

  await tgEditMessage(chatId, messageId, "🗑 <b>Pilih kategori yang mau dihapus:</b>", {
    reply_markup: { inline_keyboard: kb },
  });
}

/* ================= ADMIN: PRODUCT MGMT ================= */
async function showProductMgmt(chatId, messageId) {
  const cats = await getCategories();
  if (!cats.length) {
    await tgEditMessage(chatId, messageId, "⚠️ Kategori kosong.", {
      reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "NAV_ADMIN" }]] },
    });
    return;
  }

  const kb = cats.map((c) => [{ text: c, callback_data: `ADM_PROD_CAT_${c}` }]);
  kb.push([{ text: "⬅️ Kembali", callback_data: "NAV_ADMIN" }]);

  await tgEditMessage(chatId, messageId, "📦 <b>Pilih kategori untuk kelola produk:</b>", {
    reply_markup: { inline_keyboard: kb },
  });
}

async function showAdminProducts(chatId, messageId, cat) {
  const prods = await getProducts(cat);

  const kb = [];
  kb.push([{ text: "➕ Tambah Produk", callback_data: `ADM_PROD_ADD_${cat}` }]);

  for (const p of prods.slice(0, 15)) {
    kb.push([{ text: `✏️ ${p.name}`, callback_data: `ADM_PROD_EDIT_${cat}_${p.rowIndex}` }]);
  }

  if (prods.length > 15) {
    kb.push([{ text: "⚠️ Banyak produk, edit via search/manual", callback_data: "NOOP" }]);
  }

  kb.push([{ text: "⬅️ Kembali", callback_data: "ADM_PROD" }]);

  await tgEditMessage(
    chatId,
    messageId,
    `📦 <b>Kelola Produk</b>\nKategori: <b>${escHtml(cat)}</b>\nTotal: <b>${prods.length}</b>\n\nPilih produk untuk edit:`,
    { reply_markup: { inline_keyboard: kb } }
  );
}

async function showEditProductMenu(chatId, messageId, cat, rowIndex) {
  const rows = await read(`${cat}!A:F`);
  const r = rows[rowIndex - 1] || [];
  const id = r[0] || "-";
  const name = r[1] || "-";
  const stock = r[4] || "-";
  const price = r[5] || "-";

  const kb = {
    inline_keyboard: [
      [{ text: "💰 Edit Harga", callback_data: `ADM_SET_PRICE_${cat}_${rowIndex}` }],
      [{ text: "📦 Edit Stock", callback_data: `ADM_SET_STOCK_${cat}_${rowIndex}` }],
      [{ text: "🗑 Hapus Produk", callback_data: `ADM_DEL_PROD_${cat}_${rowIndex}` }],
      [{ text: "⬅️ Kembali", callback_data: `ADM_PROD_CAT_${cat}` }],
    ],
  };

  await tgEditMessage(
    chatId,
    messageId,
    `✏️ <b>Edit Produk</b>\n` +
      `Kategori: <b>${escHtml(cat)}</b>\n` +
      `ID: <code>${escHtml(id)}</code>\n` +
      `Nama: <b>${escHtml(name)}</b>\n` +
      `Stock: <b>${escHtml(stock)}</b>\n` +
      `Harga: <b>${escHtml(price)}</b>`,
    { reply_markup: kb }
  );
}

async function startAddProduct(chatId, messageId, cat) {
  setAdminState(chatId, "PROD_ADD_WAIT_PAYLOAD", { messageId, cat });
  await tgEditMessage(
    chatId,
    messageId,
    `➕ <b>Tambah Produk</b>\nKategori: <b>${escHtml(cat)}</b>\n\n` +
      `Kirim format:\n<code>ID|NAME|LINK|DESC|STOCK|PRICE</code>\n\n` +
      `Contoh:\n<code>1|Netflix Premium|https://...|Akun 1 bulan|10|25000</code>`,
    { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: `ADM_PROD_CAT_${cat}` }]] } }
  );
}

async function startSetPrice(chatId, messageId, cat, rowIndex) {
  setAdminState(chatId, "PROD_SET_PRICE", { messageId, cat, rowIndex });
  await tgEditMessage(
    chatId,
    messageId,
    `💰 <b>Edit Harga</b>\nKategori: <b>${escHtml(cat)}</b>\nRow: <b>${rowIndex}</b>\n\nKirim harga baru (angka saja).`,
    { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: `ADM_PROD_EDIT_${cat}_${rowIndex}` }]] } }
  );
}

async function startSetStock(chatId, messageId, cat, rowIndex) {
  setAdminState(chatId, "PROD_SET_STOCK", { messageId, cat, rowIndex });
  await tgEditMessage(
    chatId,
    messageId,
    `📦 <b>Edit Stock</b>\nKategori: <b>${escHtml(cat)}</b>\nRow: <b>${rowIndex}</b>\n\nKirim stock baru (angka / UNLIMITED).`,
    { reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: `ADM_PROD_EDIT_${cat}_${rowIndex}` }]] } }
  );
}

/* ================= HANDLE UPDATE ================= */
async function handleUpdate(update) {
  const msg = update.message;
  const cb = update.callback_query;

  /* ========= CALLBACK ========= */
  if (cb) {
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const username = cb.from?.username || "";
    const admin = isAdmin(chatId, username);
    const data = cb.data || "";

    if (!chatId) return;

    // keep main msg id in sync
    if (messageId) setMainMsgId(chatId, messageId);

    const sp = checkSpam(String(chatId));
    if (sp.blocked) {
      await tgAnswerCallback(cb.id, "Terlalu cepat. Tunggu sebentar.", false);
      if (sp.reason === "spam" && sp.strike >= SPAM_STRIKE_BAN) {
        if (!(await isBanned(chatId))) {
          await banUser(chatId, "AUTO BAN: SPAM (callback)");
          await tgSendMessage(chatId, "❌ Kamu diblokir otomatis karena spam.");
        }
      }
      return;
    }

    if (await isBanned(chatId)) {
      await tgAnswerCallback(cb.id, "Kamu diblokir.", true);
      return;
    }

    if (data === "NOOP") {
      await tgAnswerCallback(cb.id, "", false);
      return;
    }

    /* ===== NAV ===== */
    if (data === "NAV_HOME") {
      await tgAnswerCallback(cb.id, "OK", false);
      await renderMain(chatId, buildWelcomeText(), mainMenuInline(admin));
      return;
    }

    if (data === "NAV_CAT") {
      await tgAnswerCallback(cb.id, "OK", false);
      await showCategoriesEdit(chatId, messageId);
      return;
    }

    if (data === "NAV_CEK") {
      await tgAnswerCallback(cb.id, "OK", false);
      await tgEditMessage(
        chatId,
        messageId,
        `🧾 <b>Cek Pesanan</b>\n\nKirim invoice kamu (contoh: <code>TX1700000000abcd</code>)`,
        { reply_markup: mainMenuInline(admin) }
      );
      return;
    }

    if (data === "NAV_ORDER") {
      await tgAnswerCallback(cb.id, "OK", false);
      await tgEditMessage(
        chatId,
        messageId,
        `📌 <b>CARA ORDER</b>\n` +
          `1) Klik <b>📦 Kategori</b>\n` +
          `2) Pilih produk\n` +
          `3) Scan QRIS & bayar\n` +
          `4) Klik <b>🧾 Cek Status</b>\n\n` +
          `✅ Setelah sukses, link dikirim otomatis.`,
        { reply_markup: mainMenuInline(admin) }
      );
      return;
    }

    if (data === "NAV_HELP") {
      await tgAnswerCallback(cb.id, "OK", false);
      const adminLine = ADMIN_USERNAME
        ? `Admin: <a href="https://t.me/${ADMIN_USERNAME}">@${ADMIN_USERNAME}</a>`
        : `Admin: @admin`;
      await tgEditMessage(
        chatId,
        messageId,
        `🆘 <b>BANTUAN</b>\n\n` +
          `Kalau QRIS belum muncul, tunggu 10-30 detik lalu coba lagi.\n` +
          `Kalau sudah bayar tapi belum terkirim, klik <b>🧾 Cek Status</b>.\n\n` +
          `${adminLine}`,
        { reply_markup: mainMenuInline(admin) }
      );
      return;
    }

    if (data === "NAV_PING") {
      await tgAnswerCallback(cb.id, "OK", false);
      await tgEditMessage(chatId, messageId, "✅ Pong! Bot aktif 🔥", {
        reply_markup: mainMenuInline(admin),
      });
      return;
    }

    if (data === "NAV_ADMIN") {
      if (!admin) {
        await tgAnswerCallback(cb.id, "Bukan admin.", true);
        return;
      }
      await tgAnswerCallback(cb.id, "OK", false);
      await showAdminHome(chatId, messageId);
      return;
    }

    /* ===== CATEGORY => PRODUCTS ===== */
    if (data.startsWith("CAT_")) {
      const cat = data.replace("CAT_", "");
      await tgAnswerCallback(cb.id, "Membuka produk...", false);
      await showProducts(chatId, cat, messageId, 1);
      return;
    }

    if (data.startsWith("PROD_PAGE_")) {
      const parts = data.split("_"); // PROD_PAGE_{cat}_{page}
      const cat = parts[2];
      const page = Number(parts[3] || 1);
      await tgAnswerCallback(cb.id, "OK", false);
      await showProducts(chatId, cat, messageId, page);
      return;
    }

    if (data === "BACK_CAT") {
      await tgAnswerCallback(cb.id, "OK", false);
      await showCategoriesEdit(chatId, messageId);
      return;
    }

    /* ===== BUY ===== */
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
      await tgAnswerCallback(cb.id, "Invoice dibuat. Membuat QRIS...", false);
      await sendQRIS(chatId, product, invoice);
      return;
    }

    /* ===== CEK STATUS ===== */
    if (data.startsWith("CEK_")) {
      const invoice = data.replace("CEK_", "");
      await tgAnswerCallback(cb.id, "Cek pembayaran...", false);
      await checkAndDeliver(chatId, invoice);
      return;
    }

    /* ===== CANCEL (hapus QR by kolom H) ===== */
    if (data.startsWith("CANCEL_")) {
      const invoice = data.replace("CANCEL_", "");
      await tgAnswerCallback(cb.id, "Membatalkan...", false);

      const tx = await findTransaction(invoice);
      if (!tx) {
        await tgAnswerCallback(cb.id, "Transaksi tidak ditemukan.", true);
        return;
      }

      const row = tx.data;

      // HAPUS pesan QR/invoice yang tersimpan di kolom H
      const qrMsgId = row[7];
      if (qrMsgId) {
        try { await tgDeleteMessage(chatId, Number(qrMsgId)); } catch {}
        try { await updateCell(`${TAB_TX}!H${tx.rowIndex}`, ""); } catch {}
      }

      // CANCELLED + pindah ke gagal
      await markFailed(tx.rowIndex, row, "CANCELLED");

      // hapus pesan yang diklik juga (biar bersih)
      try { await tgDeleteMessage(chatId, messageId); } catch {}

      // balik menu utama
      await renderMain(chatId, buildWelcomeText(), mainMenuInline(admin));
      return;
    }

    /* ===== ADMIN CALLBACKS ===== */
    if (data === "ADM_DASH") {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      await tgAnswerCallback(cb.id, "OK", false);
      await showAdminDashboard(chatId, messageId);
      return;
    }

    if (data === "ADM_BC") {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      await tgAnswerCallback(cb.id, "OK", false);
      await startBroadcast(chatId, messageId);
      return;
    }

    if (data === "ADM_CAT") {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      await tgAnswerCallback(cb.id, "OK", false);
      await showCategoryMgmt(chatId, messageId);
      return;
    }

    if (data === "ADM_CAT_ADD") {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      await tgAnswerCallback(cb.id, "OK", false);
      await startAddCategory(chatId, messageId);
      return;
    }

    if (data === "ADM_CAT_DEL") {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      await tgAnswerCallback(cb.id, "OK", false);
      await showDeleteCategoryList(chatId, messageId);
      return;
    }

    if (data.startsWith("ADM_CAT_DEL_DO_")) {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      const cat = data.replace("ADM_CAT_DEL_DO_", "");
      await tgAnswerCallback(cb.id, "Menghapus...", false);
      const r = await removeCategory(cat);
      await tgEditMessage(chatId, messageId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, {
        reply_markup: adminMenuInline(),
      });
      return;
    }

    if (data === "ADM_PROD") {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      await tgAnswerCallback(cb.id, "OK", false);
      await showProductMgmt(chatId, messageId);
      return;
    }

    if (data.startsWith("ADM_PROD_CAT_")) {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      const cat = data.replace("ADM_PROD_CAT_", "");
      await tgAnswerCallback(cb.id, "OK", false);
      await showAdminProducts(chatId, messageId, cat);
      return;
    }

    if (data.startsWith("ADM_PROD_ADD_")) {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      const cat = data.replace("ADM_PROD_ADD_", "");
      await tgAnswerCallback(cb.id, "OK", false);
      await startAddProduct(chatId, messageId, cat);
      return;
    }

    if (data.startsWith("ADM_PROD_EDIT_")) {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      const parts = data.split("_"); // ADM_PROD_EDIT_{cat}_{rowIndex}
      const cat = parts[3];
      const rowIndex = Number(parts[4]);
      await tgAnswerCallback(cb.id, "OK", false);
      await showEditProductMenu(chatId, messageId, cat, rowIndex);
      return;
    }

    if (data.startsWith("ADM_SET_PRICE_")) {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      const parts = data.split("_"); // ADM_SET_PRICE_{cat}_{rowIndex}
      const cat = parts[3];
      const rowIndex = Number(parts[4]);
      await tgAnswerCallback(cb.id, "OK", false);
      await startSetPrice(chatId, messageId, cat, rowIndex);
      return;
    }

    if (data.startsWith("ADM_SET_STOCK_")) {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      const parts = data.split("_"); // ADM_SET_STOCK_{cat}_{rowIndex}
      const cat = parts[3];
      const rowIndex = Number(parts[4]);
      await tgAnswerCallback(cb.id, "OK", false);
      await startSetStock(chatId, messageId, cat, rowIndex);
      return;
    }

    if (data.startsWith("ADM_DEL_PROD_")) {
      if (!admin) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      const parts = data.split("_"); // ADM_DEL_PROD_{cat}_{rowIndex}
      const cat = parts[3];
      const rowIndex = Number(parts[4]);
      await tgAnswerCallback(cb.id, "Menghapus...", false);
      await deleteProduct(cat, rowIndex);
      await showAdminProducts(chatId, messageId, cat);
      return;
    }

    return;
  }

  /* ========= MESSAGE ========= */
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const username = msg.from?.username || "";
  const admin = isAdmin(chatId, username);

  const sp = checkSpam(String(chatId));
  if (sp.blocked) {
    await tgSendMessage(chatId, "⚠️ Terlalu cepat. Tunggu 1 menit ya.");
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

  // ADMIN STATE HANDLING (Broadcast / Add Category / Add Product / Set Price/Stock)
  if (admin) {
    const st = getAdminState(chatId);
    if (st?.mode === "BC_WAIT_TEXT") {
      clearAdminState(chatId);
      const result = await runBroadcast(chatId, text);
      await tgSendMessage(
        chatId,
        `✅ Broadcast selesai.\n\nTerkirim: <b>${result.ok}</b>\nGagal: <b>${result.fail}</b>\nTotal: <b>${result.total}</b>`
      );
      return;
    }

    if (st?.mode === "CAT_ADD_WAIT_NAME") {
      const mid = st.data.messageId;
      clearAdminState(chatId);
      const r = await addCategory(text);
      await tgEditMessage(chatId, mid, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, { reply_markup: adminMenuInline() });
      return;
    }

    if (st?.mode === "PROD_ADD_WAIT_PAYLOAD") {
      const { messageId, cat } = st.data;
      clearAdminState(chatId);
      const r = await addProduct(cat, text);
      await tgEditMessage(chatId, messageId, r.ok ? `✅ ${r.msg}` : `❌ ${r.msg}`, {
        reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: `ADM_PROD_CAT_${cat}` }]] },
      });
      return;
    }

    if (st?.mode === "PROD_SET_PRICE") {
      const { messageId, cat, rowIndex } = st.data;
      clearAdminState(chatId);
      const price = String(text).replace(/[^\d]/g, "");
      if (!price) {
        await tgEditMessage(chatId, messageId, "❌ Harga tidak valid.", {
          reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: `ADM_PROD_EDIT_${cat}_${rowIndex}` }]] },
        });
        return;
      }
      await setProductPrice(cat, rowIndex, price);
      await showEditProductMenu(chatId, messageId, cat, rowIndex);
      return;
    }

    if (st?.mode === "PROD_SET_STOCK") {
      const { messageId, cat, rowIndex } = st.data;
      clearAdminState(chatId);
      const v = String(text || "").trim();
      if (!v) {
        await tgEditMessage(chatId, messageId, "❌ Stock tidak valid.", {
          reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: `ADM_PROD_EDIT_${cat}_${rowIndex}` }]] },
        });
        return;
      }
      await setProductStock(cat, rowIndex, v);
      await showEditProductMenu(chatId, messageId, cat, rowIndex);
      return;
    }
  }

  if (text === "/start") {
    await addMember(chatId);

    // remove reply keyboard lama (kalau pernah ada)
    await tg("sendMessage", {
      chat_id: chatId,
      text: "✅ Menu siap.",
      reply_markup: { remove_keyboard: true },
    });

    await renderMain(chatId, buildWelcomeText(), mainMenuInline(admin));
    return;
  }

  // invoice manual
  if (/^TX\d+[a-f0-9]{4}$/i.test(text)) {
    await checkAndDeliver(chatId, text);
    return;
  }

  await tgSendMessage(chatId, "Ketik /start untuk membuka menu.");
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
