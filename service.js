```js
// service.js (FINAL) - Copy Paste Full File
// Features:
// ✅ Reply keyboard menu: Kategori, Cek Pesanan, Cara Order, Bantuan, Ping, Panel Admin
// ✅ Inline buttons: kategori -> produk -> bayar -> cek status
// ✅ Google Sheets safe range quoting (tabs with spaces supported)
// ✅ Pakasir QRIS create + detail + webhook auto-deliver
// ✅ Anti-spam (RAM) + autoban (write to sheet only when banned)
// ✅ Cache (banned + categories + products) to reduce Google Sheet load
// ✅ Compatible with your sheet structure (7 columns TRANSAKSI)

import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import crypto from "crypto";

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
];

for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error("Missing ENV:", k);
    process.exit(1);
  }
}

const {
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SHEET_ID,
  PAYMENT_PROJECT_SLUG,
  PAYMENT_API_KEY,
} = process.env;

const SPAM_STRIKES_TO_BAN = Number(process.env.SPAM_STRIKES_TO_BAN || 3);

/* ================= TABS ================= */
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
    body: JSON.stringify(body),
  });
  return res.json();
}

async function tgSafeSendMessage(chatId, text, extra = {}) {
  try {
    return await tg("sendMessage", { chat_id: chatId, text, ...extra });
  } catch (e) {
    console.log("TG sendMessage error:", e?.message);
  }
}

async function tgSafeSendPhoto(chatId, photo, caption, extra = {}) {
  try {
    return await tg("sendPhoto", { chat_id: chatId, photo, caption, ...extra });
  } catch (e) {
    console.log("TG sendPhoto error:", e?.message);
  }
}

async function tgAnswerCallback(cbId, text, showAlert = false) {
  try {
    return await tg("answerCallbackQuery", {
      callback_query_id: cbId,
      text,
      show_alert: showAlert,
    });
  } catch (e) {}
}

/* ================= GOOGLE ================= */
const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.JWT(
  sa.client_email,
  null,
  sa.private_key,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth });

function qSheet(range) {
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
    range: qSheet(range),
  });
  return r.data.values || [];
}

async function append(range, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: qSheet(range),
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

async function update(range, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: qSheet(range),
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

async function clearRow(tab, rowIndex, colEndLetter) {
  const r = tab + "!A" + rowIndex + ":" + colEndLetter + rowIndex;
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: qSheet(r),
  });
}

/* ================= HELPERS ================= */
function nowISO() {
  return new Date().toISOString();
}

function displayUser(username, chatId) {
  const u = username ? "@" + username : "-";
  return u + " | " + chatId;
}

function parseChatIdFromDisplay(display) {
  const parts = String(display || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean);
  const maybe = parts[parts.length - 1];
  const n = Number(maybe);
  return Number.isFinite(n) ? String(n) : null;
}

function normalizeStatus(s) {
  return String(s || "").trim().toUpperCase();
}

function rupiah(n) {
  const num = Number(n || 0);
  return `Rp ${num.toLocaleString("id-ID")}`;
}

/* ================= REPLY KEYBOARD MENU ================= */
function mainMenuKeyboard(isAdmin) {
  const base = [
    [{ text: "📁 Kategori" }, { text: "📄 Cek Pesanan" }],
    [{ text: "📌 Cara Order" }, { text: "🆘 Bantuan" }],
    [{ text: "🏓 Ping" }],
  ];

  if (isAdmin) {
    base.push([{ text: "🧑‍💻 Panel Admin" }]);
  }

  return {
    keyboard: base,
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

/* ================= MEMBER SYSTEM ================= */
async function addMember(chatId, username) {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  const exists = rows.some((r) => String(r[2] || "").includes(String(chatId)));
  if (exists) return;

  const nomor = rows.length; // includes header
  await append(`${TAB_MEMBER}!A:C`, [
    nomor,
    new Date().toISOString().slice(0, 10),
    displayUser(username, chatId),
  ]);
}

/* ================= BANNED CACHE (reduce sheet load) ================= */
let bannedCache = new Set();
let bannedCacheAt = 0;
const BANNED_CACHE_TTL = 2 * 60 * 1000;

async function refreshBannedCacheIfNeeded() {
  const now = Date.now();
  if (now - bannedCacheAt < BANNED_CACHE_TTL) return;

  const rows = await read(`${TAB_BANNED}!A:C`);
  bannedCache = new Set(rows.slice(1).map((r) => String(r[0])));
  bannedCacheAt = now;
}

async function isBanned(chatId) {
  await refreshBannedCacheIfNeeded();
  return bannedCache.has(String(chatId));
}

async function banUser(chatId, reason) {
  await refreshBannedCacheIfNeeded();
  if (bannedCache.has(String(chatId))) return;

  await append(`${TAB_BANNED}!A:C`, [String(chatId), reason || "No reason", nowISO()]);
  bannedCache.add(String(chatId));
}

async function unbanUser(chatId) {
  const rows = await read(`${TAB_BANNED}!A:C`);
  const index = rows.findIndex((r) => String(r[0]) === String(chatId));
  if (index >= 0) {
    await clearRow(TAB_BANNED, index + 1, "C");
    bannedCache.delete(String(chatId));
  }
}

/* ================= CATEGORY + PRODUCT CACHE ================= */
let catCache = { data: null, at: 0 };
const CAT_TTL = 60 * 1000;

async function getCategories() {
  const rows = await read(`${TAB_CATEGORY}!A:B`);
  return rows.slice(1).map((r) => r[0]).filter(Boolean);
}

async function getCategoriesCached() {
  const now = Date.now();
  if (catCache.data && now - catCache.at < CAT_TTL) return catCache.data;
  const data = await getCategories();
  catCache = { data, at: now };
  return data;
}

const prodCache = new Map(); // category -> { data, at }
const PROD_TTL = 60 * 1000;

async function getProducts(category) {
  const rows = await read(`${category}!A:F`);
  return rows.slice(1).map((r, i) => ({
    id: r[0],
    name: r[1],
    link: r[2],
    desc: r[3],
    stock: r[4],
    price: r[5],
    rowIndex: i + 2,
    tab: category,
  }));
}

async function getProductsCached(category) {
  const now = Date.now();
  const hit = prodCache.get(category);
  if (hit && now - hit.at < PROD_TTL) return hit.data;
  const data = await getProducts(category);
  prodCache.set(category, { data, at: now });
  return data;
}

async function getProductById(productId) {
  const categories = await getCategoriesCached();
  for (const cat of categories) {
    const prods = await getProductsCached(cat);
    const found = prods.find((p) => String(p.id) === String(productId));
    if (found) return found;
  }
  return null;
}

/* ================= PAYMENT (PAKASIR) ================= */
async function createPakasirQRIS(amount, orderId) {
  const url = "https://app.pakasir.com/api/transactioncreate/qris";
  const body = {
    project: PAYMENT_PROJECT_SLUG,
    order_id: orderId,
    amount: Number(amount),
    api_key: PAYMENT_API_KEY,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  return json;
}

async function getPaymentDetail(amount, invoice) {
  const url =
    `https://app.pakasir.com/api/transactiondetail` +
    `?project=${encodeURIComponent(PAYMENT_PROJECT_SLUG)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&order_id=${encodeURIComponent(invoice)}` +
    `&api_key=${encodeURIComponent(PAYMENT_API_KEY)}`;

  const res = await fetch(url);
  return res.json();
}

function buildQrImageUrlFromQrString(qrString) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(
    qrString
  )}`;
}

/* ================= TRANSAKSI (7 COLUMNS) =================
A tanggal
B id produk
C nama produk
D username/id pembeli => "@user | chatId"
E invoice
F harga
G status
*/
async function createTransaction(product, chatId, username) {
  const invoice = "INV-" + Date.now() + "-" + crypto.randomBytes(2).toString("hex");

  await append(`${TAB_TX}!A:G`, [
    nowISO(),
    product.id,
    product.name,
    displayUser(username, chatId),
    invoice,
    String(product.price),
    "PENDING",
  ]);

  return invoice;
}

async function findTransactionInTab(tab, invoice) {
  const rows = await read(`${tab}!A:G`);
  for (let i = 1; i < rows.length; i++) {
    const inv = rows[i][4]; // E
    if (String(inv) === String(invoice)) {
      return { rowIndex: i + 1, data: rows[i] };
    }
  }
  return null;
}

async function findTransaction(invoice) {
  return findTransactionInTab(TAB_TX, invoice);
}

async function markSuccess(rowIndex, rowData) {
  await update(`${TAB_TX}!G${rowIndex}`, "SUCCESS");
  const newRow = [...rowData];
  newRow[6] = "SUCCESS";
  await append(`${TAB_TX_SUCCESS}!A:G`, newRow);
  await clearRow(TAB_TX, rowIndex, "G");
}

async function markFailed(rowIndex, rowData, statusText = "FAILED") {
  await update(`${TAB_TX}!G${rowIndex}`, statusText);
  const newRow = [...rowData];
  newRow[6] = statusText;
  await append(`${TAB_TX_FAIL}!A:G`, newRow);
  await clearRow(TAB_TX, rowIndex, "G");
}

/* ================= ORDER UI ================= */
async function showCategories(chatId, isAdmin = false) {
  const categories = await getCategoriesCached();
  if (!categories.length) {
    await tgSafeSendMessage(
      chatId,
      "⚠️ Kategori belum diisi.\nBuat tab 'CATEGORIES' dan isi kolom A dengan nama kategori (contoh: APK NONTON).",
      { reply_markup: { keyboard: mainMenuKeyboard(isAdmin).keyboard, resize_keyboard: true } }
    );
    return;
  }

  const buttons = categories.map((c) => [{ text: c, callback_data: `CAT_${c}` }]);

  await tgSafeSendMessage(chatId, "📁 Pilih kategori:", {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function showProducts(chatId, category) {
  const products = await getProductsCached(category);

  if (!products.length) {
    await tgSafeSendMessage(chatId, `⚠️ Produk di "${category}" masih kosong.`);
    return;
  }

  const buttons = products.map((p) => [
    {
      text: `${p.name} - ${rupiah(p.price)}`,
      callback_data: `BUY_${category}_${p.id}`,
    },
  ]);

  await tgSafeSendMessage(chatId, `📦 Produk ${category}:`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

/* ================= AUTO QRIS ================= */
async function sendQRIS(chatId, product, invoice) {
  const created = await createPakasirQRIS(product.price, invoice);

  const payment = created?.payment || created?.transaction || null;
  const qrString = payment?.payment_number || null;
  const totalPayment = payment?.total_payment || product.price;

  if (!qrString) {
    await tgSafeSendMessage(
      chatId,
      "⚠️ Gagal membuat QRIS.\nCoba lagi beberapa saat, atau hubungi admin."
    );

    await tgSafeSendMessage(
      ADMIN_CHAT_ID,
      `⚠️ Gagal create QRIS\nInvoice: ${invoice}\nResp: ${JSON.stringify(created).slice(0, 1500)}`
    );
    return;
  }

  const qrImageUrl = buildQrImageUrlFromQrString(qrString);

  await tgSafeSendPhoto(chatId, qrImageUrl, 
    `🧾 Invoice: ${invoice}\n` +
    `📦 Produk: ${product.name}\n` +
    `💰 Total Bayar: ${rupiah(totalPayment)}\n\n` +
    `Silakan scan QRIS.\n` +
    `Setelah bayar, bot akan otomatis kirim produk.\n` +
    `Atau klik tombol cek status.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔄 Cek Status", callback_data: `CEK_${invoice}` }],
        ],
      },
    }
  );
}

/* ================= DELIVERY ================= */
async function deliverProduct(row) {
  const productId = row[1]; // B
  const buyerDisplay = row[3]; // D
  const invoice = row[4];
  const chatId = parseChatIdFromDisplay(buyerDisplay);

  if (!chatId) {
    await tgSafeSendMessage(
      ADMIN_CHAT_ID,
      `⚠️ Deliver gagal: chat_id tidak terbaca.\nBuyer: ${buyerDisplay}\nInvoice: ${invoice}`
    );
    return { ok: false, reason: "CHAT_ID_NOT_FOUND" };
  }

  const product = await getProductById(productId);
  if (!product) {
    await tgSafeSendMessage(
      ADMIN_CHAT_ID,
      `⚠️ Produk tidak ditemukan.\nProductId: ${productId}\nInvoice: ${invoice}`
    );
    return { ok: false, reason: "PRODUCT_NOT_FOUND" };
  }

  // Stock check
  if (String(product.stock).toUpperCase() !== "UNLIMITED") {
    const current = Number(product.stock || 0);
    if (current <= 0) {
      await tgSafeSendMessage(chatId, "⚠️ Maaf, stok habis. Hubungi admin.");
      await tgSafeSendMessage(
        ADMIN_CHAT_ID,
        `⚠️ Stok habis saat deliver.\nProduk: ${product.name}\nInvoice: ${invoice}`
      );
      return { ok: false, reason: "OUT_OF_STOCK" };
    }
    await update(`${product.tab}!E${product.rowIndex}`, current - 1);
    // Clear product cache for this tab so stock updates reflect
    prodCache.delete(product.tab);
  }

  await tgSafeSendMessage(
    chatId,
    `✅ Pembayaran Berhasil!\n\n📦 ${product.name}\n\n🔗 Link Download:\n${product.link}`
  );

  return { ok: true };
}

/* ================= CEK STATUS ================= */
async function checkAndDeliver(chatId, invoice) {
  const tx = await findTransaction(invoice);

  if (!tx) {
    const done = await findTransactionInTab(TAB_TX_SUCCESS, invoice);
    if (done) {
      await tgSafeSendMessage(chatId, "✅ Transaksi ini sudah SUCCESS sebelumnya. Silakan cek pesan link produk ya.");
      return;
    }
    const failed = await findTransactionInTab(TAB_TX_FAIL, invoice);
    if (failed) {
      await tgSafeSendMessage(chatId, "❌ Transaksi ini sudah tercatat GAGAL/EXPIRED.");
      return;
    }

    await tgSafeSendMessage(chatId, "Invoice tidak ditemukan.");
    return;
  }

  const row = tx.data;
  const amount = row[5]; // F
  const detail = await getPaymentDetail(amount, invoice);

  const status = normalizeStatus(detail?.transaction?.status || detail?.status);

  if (status === "COMPLETED") {
    const delivered = await deliverProduct(row);
    if (delivered.ok) {
      await markSuccess(tx.rowIndex, row);
    } else {
      await tgSafeSendMessage(
        ADMIN_CHAT_ID,
        `⚠️ Pembayaran completed tapi deliver gagal (${delivered.reason}). Invoice: ${invoice}`
      );
    }
    return;
  }

  if (["EXPIRED", "FAILED", "CANCELLED", "CANCELED"].includes(status)) {
    await markFailed(tx.rowIndex, row, status);
    await tgSafeSendMessage(chatId, `❌ Transaksi ${status}.`);
    return;
  }

  await tgSafeSendMessage(chatId, "Status: " + (status || "MENUNGGU PEMBAYARAN"));
}

/* ================= LAST ORDER LOOKUP (Cek Pesanan) ================= */
async function getLastOrderForChat(chatId) {
  const rows = await read(`${TAB_TX}!A:G`);
  // scan from bottom
  for (let i = rows.length - 1; i >= 1; i--) {
    const buyer = rows[i][3];
    const cid = parseChatIdFromDisplay(buyer);
    if (String(cid) === String(chatId)) {
      return { tab: TAB_TX, rowIndex: i + 1, row: rows[i] };
    }
  }
  // also check success
  const succ = await read(`${TAB_TX_SUCCESS}!A:G`);
  for (let i = succ.length - 1; i >= 1; i--) {
    const buyer = succ[i][3];
    const cid = parseChatIdFromDisplay(buyer);
    if (String(cid) === String(chatId)) {
      return { tab: TAB_TX_SUCCESS, rowIndex: i + 1, row: succ[i] };
    }
  }
  // fail
  const fail = await read(`${TAB_TX_FAIL}!A:G`);
  for (let i = fail.length - 1; i >= 1; i--) {
    const buyer = fail[i][3];
    const cid = parseChatIdFromDisplay(buyer);
    if (String(cid) === String(chatId)) {
      return { tab: TAB_TX_FAIL, rowIndex: i + 1, row: fail[i] };
    }
  }
  return null;
}

/* ================= ANTI SPAM (RAM) ================= */
const spamState = new Map();
/*
spamState.get(chatId) = {
  msg: { count, ts },
  cb: { count, ts },
  strikes,
  lastWarnAt
}
*/

function getSpam(chatId) {
  const key = String(chatId);
  if (!spamState.has(key)) {
    spamState.set(key, {
      msg: { count: 0, ts: Date.now() },
      cb: { count: 0, ts: Date.now() },
      strikes: 0,
      lastWarnAt: 0,
    });
  }
  return spamState.get(key);
}

function hitLimiter(bucket, limit, windowMs) {
  const now = Date.now();
  if (now - bucket.ts > windowMs) {
    bucket.ts = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

async function warnOrBan(chatId, reason) {
  const s = getSpam(chatId);
  const now = Date.now();

  // Only warn at most every 30s to avoid noisy chats
  const canWarn = now - s.lastWarnAt > 30_000;
  s.lastWarnAt = canWarn ? now : s.lastWarnAt;

  s.strikes += 1;

  if (s.strikes >= SPAM_STRIKES_TO_BAN) {
    await banUser(chatId, `AutoBan Spam: ${reason}`);
    if (canWarn) {
      await tgSafeSendMessage(chatId, "❌ Kamu diblokir otomatis karena spam.");
    }
    await tgSafeSendMessage(
      ADMIN_CHAT_ID,
      `🚫 AutoBan spam\nChat: ${chatId}\nReason: ${reason}\nStrikes: ${s.strikes}`
    );
    return true;
  } else {
    if (canWarn) {
      await tgSafeSendMessage(chatId, `⚠️ Jangan spam ya. (Peringatan ${s.strikes}/${SPAM_STRIKES_TO_BAN})`);
    }
    return false;
  }
}

/* ================= PAKASIR WEBHOOK (AUTO DELIVER) ================= */
app.post("/pakasir/webhook", async (req, res) => {
  try {
    res.sendStatus(200);

    const body = req.body || {};
    const invoice = body.order_id;
    const amount = body.amount;
    const status = normalizeStatus(body.status);

    if (!invoice || !amount) return;
    if (body.project && String(body.project) !== String(PAYMENT_PROJECT_SLUG)) return;
    if (status !== "COMPLETED") return;

    const tx = await findTransaction(invoice);
    if (!tx) return;

    const row = tx.data;
    const sheetAmount = String(row[5]); // F
    if (String(sheetAmount) !== String(amount)) {
      await tgSafeSendMessage(
        ADMIN_CHAT_ID,
        `⚠️ Webhook amount mismatch\nInvoice: ${invoice}\nWebhook: ${amount}\nSheet: ${sheetAmount}`
      );
      return;
    }

    const delivered = await deliverProduct(row);
    if (delivered.ok) {
      await markSuccess(tx.rowIndex, row);
    }
  } catch (e) {
    console.log("PAKASIR WEBHOOK ERROR:", e?.message);
  }
});

/* ================= TELEGRAM HANDLER (WEBHOOK ROOT "/") ================= */
app.post("/", async (req, res) => {
  // Always reply 200 quickly to Telegram
  res.sendStatus(200);

  try {
    const msg = req.body.message;
    const cb = req.body.callback_query;

    /* ========= CALLBACK ========= */
    if (cb) {
      const chatId = cb.message?.chat?.id;
      const data = cb.data || "";

      if (!chatId) return;

      if (await isBanned(chatId)) {
        await tgAnswerCallback(cb.id, "Kamu diblokir.", true);
        return;
      }

      // Anti-spam callback: max 10 per 10s
      const s = getSpam(chatId);
      const violated = hitLimiter(s.cb, 10, 10_000);
      if (violated) {
        await warnOrBan(chatId, "Callback spam");
        await tgAnswerCallback(cb.id, "Terlalu cepat. Tunggu sebentar.", false);
        return;
      }

      if (data.startsWith("CAT_")) {
        const cat = data.replace("CAT_", "");
        await showProducts(chatId, cat);
        await tgAnswerCallback(cb.id, "OK", false);
        return;
      }

      if (data.startsWith("BUY_")) {
        const parts = data.split("_");
        const cat = parts[1];
        const id = parts[2];

        const products = await getProductsCached(cat);
        const product = products.find((p) => String(p.id) === String(id));
        if (!product) {
          await tgAnswerCallback(cb.id, "Produk tidak ditemukan.", true);
          return;
        }

        // Stock check before creating invoice
        if (String(product.stock).toUpperCase() !== "UNLIMITED") {
          const current = Number(product.stock || 0);
          if (current <= 0) {
            await tgAnswerCallback(cb.id, "Stok habis.", true);
            await tgSafeSendMessage(chatId, "⚠️ Stok produk ini sedang habis.");
            return;
          }
        }

        const invoice = await createTransaction(product, chatId, cb.from?.username);
        await sendQRIS(chatId, product, invoice);
        await tgAnswerCallback(cb.id, "Silakan bayar QRIS.", false);
        return;
      }

      if (data.startsWith("CEK_")) {
        const invoice = data.replace("CEK_", "");
        await checkAndDeliver(chatId, invoice);
        await tgAnswerCallback(cb.id, "Dicek.", false);
        return;
      }

      await tgAnswerCallback(cb.id, "OK", false);
      return;
    }

    /* ========= MESSAGE ========= */
    if (!msg) return;

    const chatId = msg.chat?.id;
    const text = msg.text || "";
    const username = msg.from?.username;

    if (!chatId) return;

    if (await isBanned(chatId)) {
      await tgSafeSendMessage(chatId, "❌ Kamu diblokir.");
      return;
    }

    // Anti-spam message: max 6 per 10s
    const s = getSpam(chatId);
    const violated = hitLimiter(s.msg, 6, 10_000);
    if (violated) {
      await warnOrBan(chatId, "Message spam");
      return;
    }

    const isAdmin = String(chatId) === String(ADMIN_CHAT_ID);

    // /start
    if (text === "/start") {
      await addMember(chatId, username);

      await tgSafeSendMessage(
        chatId,
        "Selamat datang 👋\nGunakan menu di bawah untuk mulai.",
        { reply_markup: mainMenuKeyboard(isAdmin) }
      );

      // Immediately show categories as well
      await showCategories(chatId, isAdmin);
      return;
    }

    // Menu: Kategori
    if (text === "📁 Kategori") {
      await showCategories(chatId, isAdmin);
      return;
    }

    // Menu: Cek Pesanan
    if (text === "📄 Cek Pesanan") {
      const last = await getLastOrderForChat(chatId);
      if (!last) {
        await tgSafeSendMessage(chatId, "Belum ada transaksi untuk akun kamu.");
        return;
      }
      const row = last.row;
      await tgSafeSendMessage(
        chatId,
        `📄 Pesanan Terakhir:\n\n` +
          `🧾 Invoice: ${row[4]}\n` +
          `📦 Produk: ${row[2]}\n` +
          `💰 Harga: ${rupiah(row[5])}\n` +
          `📌 Status: ${row[6]}\n\n` +
          `Klik tombol di bawah untuk cek status pembayaran.`,
        {
          reply_markup: {
            inline_keyboard: [[{ text: "🔄 Cek Status", callback_data: `CEK_${row[4]}` }]],
          },
        }
      );
      return;
    }

    // Menu: Cara Order
    if (text === "📌 Cara Order") {
      await tgSafeSendMessage(
        chatId,
        `📌 Cara Order:\n\n` +
          `1) Klik 📁 Kategori\n` +
          `2) Pilih produk yang ingin dibeli\n` +
          `3) Scan QRIS dan lakukan pembayaran\n` +
          `4) Setelah pembayaran sukses, bot otomatis kirim link produk\n\n` +
          `Jika ada kendala, klik 🆘 Bantuan.`
      );
      return;
    }

    // Menu: Bantuan
    if (text === "🆘 Bantuan") {
      await tgSafeSendMessage(
        chatId,
        `🆘 Bantuan:\n\n` +
          `• Jika bot belum kirim produk setelah bayar, klik 📄 Cek Pesanan lalu 🔄 Cek Status.\n` +
          `• Pastikan pembayaran QRIS sukses.\n` +
          `• Jika masih gagal, kirim invoice ke admin.\n\n` +
          `Admin: ${ADMIN_CHAT_ID}`
      );
      return;
    }

    // Menu: Ping
    if (text === "🏓 Ping") {
      await tgSafeSendMessage(chatId, "Pong ✅ Bot aktif.");
      return;
    }

    // Admin panel
    if (text === "🧑‍💻 Panel Admin" && isAdmin) {
      await tgSafeSendMessage(
        chatId,
        `🧑‍💻 Panel Admin:\n\n` +
          `• /dashboard\n` +
          `• /ban <chat_id>\n` +
          `• /unban <chat_id>\n\n` +
          `Catatan: Kelola produk langsung di Google Sheet.`
      );
      return;
    }

    // Admin commands
    if (isAdmin) {
      if (text.startsWith("/ban ")) {
        const id = text.split(" ")[1];
        await banUser(id, "Admin ban");
        await tgSafeSendMessage(chatId, "User diban.");
        return;
      }

      if (text.startsWith("/unban ")) {
        const id = text.split(" ")[1];
        await unbanUser(id);
        await tgSafeSendMessage(chatId, "User di-unban.");
        return;
      }

      if (text === "/dashboard") {
        const success = await read(`${TAB_TX_SUCCESS}!A:G`);
        const fail = await read(`${TAB_TX_FAIL}!A:G`);
        await tgSafeSendMessage(
          chatId,
          `📊 Dashboard\n\n✅ Berhasil: ${Math.max(success.length - 1, 0)}\n❌ Gagal: ${Math.max(fail.length - 1, 0)}`
        );
        return;
      }
    }

    // Default
    await tgSafeSendMessage(
      chatId,
      "Gunakan menu di bawah ya 👇",
      { reply_markup: mainMenuKeyboard(isAdmin) }
    );
  } catch (err) {
    console.log("TELEGRAM HANDLER ERROR:", err?.message);
  }
});

/* ================= SERVER ================= */
app.get("/", (req, res) => res.send("BOT RUNNING"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Server started");
});
```
