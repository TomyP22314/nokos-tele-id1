import express from "express";
import { google } from "googleapis";
import fetch from "node-fetch";
import crypto from "crypto";
import FormData from "form-data";

/**
 * =========================
 * ENV (WAJIB)
 * =========================
 */
const REQUIRED_ENVS = [
  "BOT_TOKEN",
  "WEBHOOK_SECRET",
  "ADMIN_CHAT_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "SHEET_ID",
  "PAYMENT_PROJECT_SLUG",
  "PAYMENT_API_KEY",
  "PAYMENT_WEBHOOK_SECRET"
];

function assertEnv() {
  const missing = REQUIRED_ENVS.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
  if (missing.length) throw new Error("Missing ENV: " + missing.join(", "));
}
assertEnv();

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID);
const SHEET_ID = process.env.SHEET_ID;

const PAYMENT_PROJECT_SLUG = process.env.PAYMENT_PROJECT_SLUG;
const PAYMENT_API_KEY = process.env.PAYMENT_API_KEY;
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET;

// optional
const BRAND_NAME = process.env.BRAND_NAME || "GOMS APK";
const BANNER_URL = process.env.BANNER_URL || "";
const WELCOME_ANIM_FILE_ID = process.env.WELCOME_ANIM_FILE_ID || "";

// Sheet tab names (fixed)
const TAB_CATEGORIES = "CATEGORIES";
const TAB_BANNED = "BANNED";
const TAB_MEMBER = "MEMBER LIST";
const TAB_TX = "TRANSAKSI";
const TAB_SUCCESS = "TRANSAKSI BERHASIL";
const TAB_FAIL = "TRANSAKSI GAGAL";

// Product sheet format per category tab:
// A ID | B NAMA PRODUK | C LINK DOWNLOAD | D DESKRIPSI | E STOCK | F HARGA

/**
 * =========================
 * EXPRESS
 * =========================
 */
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// health checks (biar gak bingung 404)
app.get("/", (req, res) => res.status(200).send("OK"));
app.get(`/telegram/webhook/${WEBHOOK_SECRET}`, (req, res) => res.status(200).send("TG OK"));
app.get(`/payment/webhook/${PAYMENT_WEBHOOK_SECRET}`, (req, res) => res.status(200).send("PAY OK"));

/**
 * =========================
 * GOOGLE SHEETS AUTH
 * =========================
 */
function getGoogleAuth() {
  let sa;
  try {
    sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON bukan JSON valid.");
  }

  return new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}

const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });

async function readRange(rangeA1) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: rangeA1 });
  return r.data.values || [];
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

async function batchUpdate(requests) {
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { requests }
  });
}

async function getSpreadsheetMeta() {
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  return meta.data;
}

async function ensureSheetTabExists(title) {
  const meta = await getSpreadsheetMeta();
  const exists = (meta.sheets || []).some((s) => s.properties?.title === title);
  if (exists) return true;

  await batchUpdate([
    {
      addSheet: {
        properties: { title }
      }
    }
  ]);
  return true;
}

async function ensureBaseTabs() {
  // ensure required tabs exist
  await ensureSheetTabExists(TAB_CATEGORIES);
  await ensureSheetTabExists(TAB_BANNED);
  await ensureSheetTabExists(TAB_MEMBER);
  await ensureSheetTabExists(TAB_TX);
  await ensureSheetTabExists(TAB_SUCCESS);
  await ensureSheetTabExists(TAB_FAIL);

  // ensure headers (best effort, only if empty)
  const cats = await readRange(`${TAB_CATEGORIES}!A1:B1`);
  if (!cats.length) await appendRow(TAB_CATEGORIES, ["CATEGORY_NAME", "CREATED_AT"]);

  const banned = await readRange(`${TAB_BANNED}!A1:C1`);
  if (!banned.length) await appendRow(TAB_BANNED, ["CHAT_ID", "REASON", "BANNED_AT"]);

  const members = await readRange(`${TAB_MEMBER}!A1:C1`);
  if (!members.length) await appendRow(TAB_MEMBER, ["NOMOR", "TANGGAL GABUNG", "CHAT_ID"]);

  const tx = await readRange(`${TAB_TX}!A1:H1`);
  if (!tx.length)
    await appendRow(TAB_TX, [
      "TANGGAL",
      "KATEGORI",
      "ID PRODUK",
      "NAMA PRODUK",
      "PEMBELI",
      "INVOICE",
      "HARGA",
      "STATUS"
    ]);

  const ok = await readRange(`${TAB_SUCCESS}!A1:H1`);
  if (!ok.length)
    await appendRow(TAB_SUCCESS, [
      "TANGGAL",
      "KATEGORI",
      "ID PRODUK",
      "NAMA PRODUK",
      "PEMBELI",
      "INVOICE",
      "HARGA",
      "STATUS"
    ]);

  const fail = await readRange(`${TAB_FAIL}!A1:H1`);
  if (!fail.length)
    await appendRow(TAB_FAIL, [
      "TANGGAL",
      "KATEGORI",
      "ID PRODUK",
      "NAMA PRODUK",
      "PEMBELI",
      "INVOICE",
      "HARGA",
      "STATUS"
    ]);
}

/**
 * =========================
 * TELEGRAM
 * =========================
 */
async function tg(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const isForm = body instanceof FormData;
  const resp = await fetch(url, {
    method: "POST",
    headers: isForm ? undefined : { "Content-Type": "application/json" },
    body: isForm ? body : JSON.stringify(body)
  });
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram error: ${JSON.stringify(data)}`);
  return data.result;
}

function isAdmin(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID);
}

function rupiah(n) {
  return "Rp " + Number(n || 0).toLocaleString("id-ID");
}

function makeInvoice() {
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `TX${Date.now()}${rand}`;
}

function nowISO() {
  return new Date().toISOString();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatIDDateTime(d = new Date()) {
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${String(d.getFullYear()).slice(-2)} ${pad2(
    d.getHours()
  )}.${pad2(d.getMinutes())}`;
}

function formatIDDateTimeLong(d = new Date()) {
  const months = [
    "Januari",
    "Februari",
    "Maret",
    "April",
    "Mei",
    "Juni",
    "Juli",
    "Agustus",
    "September",
    "Oktober",
    "November",
    "Desember"
  ];
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${pad2(d.getHours())}:${pad2(
    d.getMinutes()
  )}:${pad2(d.getSeconds())}`;
}

/**
 * =========================
 * UI (GOMS APK)
 * =========================
 */
function welcomeText() {
  return (
    `🔥 *Selamat Datang di ${BRAND_NAME}* 🔥\n\n` +
    `✅ Produk dikirim otomatis setelah pembayaran sukses\n` +
    `💳 Pembayaran via QR (langsung tampil)\n` +
    `⚡ Fast respon & Auto System\n\n` +
    `Klik *🗂 Kategori* untuk mulai belanja 👇`
  );
}

function howToText() {
  return (
    `📌 *Cara Order*\n\n` +
    `1) Klik *🗂 Kategori*\n` +
    `2) Pilih kategori → pilih produk\n` +
    `3) Klik *✅ Beli* (bot buat invoice)\n` +
    `4) QR langsung muncul → scan & bayar\n` +
    `5) Setelah sukses, link produk dikirim otomatis ✅\n\n` +
    `Cek status: /cek TX...`
  );
}

function helpText() {
  return (
    `👨‍💻 *Bantuan*\n\n` +
    `Jika pembayaran sukses tapi produk belum masuk:\n` +
    `1) Klik *🔄 Cek Status*\n` +
    `2) Tunggu 1-2 menit\n` +
    `3) Kirim ID transaksi ke admin\n\n` +
    `Cek status: /cek TX...`
  );
}

function mainMenuKeyboard(admin = false) {
  const base = [
    [{ text: "🗂 Kategori" }, { text: "🧾 Cek Pesanan" }],
    [{ text: "📌 Cara Order" }, { text: "👨‍💻 Bantuan" }],
    [{ text: "🏓 Ping" }]
  ];
  if (admin) base.push([{ text: "🛠 Panel Admin" }]);
  return { keyboard: base, resize_keyboard: true };
}

/**
 * =========================
 * CATEGORIES
 * =========================
 */
async function getCategories() {
  await ensureBaseTabs();
  const values = await readRange(`${TAB_CATEGORIES}!A:B`);
  if (values.length <= 1) return [];
  return values
    .slice(1)
    .map((r) => String(r[0] || "").trim())
    .filter(Boolean);
}

async function addCategory(name) {
  const cat = String(name || "").trim();
  if (!cat) throw new Error("Nama kategori kosong.");

  const current = await getCategories();
  if (current.includes(cat)) return true;

  // create tab for category products
  await ensureSheetTabExists(cat);

  // set header for product tab (best effort)
  const head = await readRange(`${cat}!A1:F1`);
  if (!head.length) {
    await appendRow(cat, ["ID", "NAMA PRODUK", "LINK DOWNLOAD", "DESKRIPSI", "STOCK", "HARGA"]);
  }

  await appendRow(TAB_CATEGORIES, [cat, nowISO()]);
  return true;
}

async function editCategory(oldName, newName) {
  const from = String(oldName || "").trim();
  const to = String(newName || "").trim();
  if (!from || !to) throw new Error("Format salah.");

  const cats = await getCategories();
  if (!cats.includes(from)) throw new Error("Kategori lama tidak ditemukan.");
  if (cats.includes(to)) throw new Error("Kategori baru sudah ada.");

  // rename sheet tab
  const meta = await getSpreadsheetMeta();
  const target = (meta.sheets || []).find((s) => s.properties?.title === from);
  if (!target) throw new Error("Tab kategori tidak ditemukan di sheet.");

  await batchUpdate([
    {
      updateSheetProperties: {
        properties: { sheetId: target.properties.sheetId, title: to },
        fields: "title"
      }
    }
  ]);

  // update CATEGORIES sheet row
  const values = await readRange(`${TAB_CATEGORIES}!A:A`);
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0] || "").trim() === from) {
      await updateCell(TAB_CATEGORIES, `A${i + 1}`, to);
      break;
    }
  }
  return true;
}

async function delCategory(name) {
  // NOTE: not deleting sheet tab (safety). Only remove from list.
  const cat = String(name || "").trim();
  if (!cat) throw new Error("Nama kategori kosong.");

  const values = await readRange(`${TAB_CATEGORIES}!A:B`);
  if (values.length <= 1) return false;

  // rebuild without cat
  const rows = values.slice(1).filter((r) => String(r[0] || "").trim() !== cat);
  // clear + rewrite
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${TAB_CATEGORIES}!A2:Z` });
  for (const r of rows) await appendRow(TAB_CATEGORIES, r);
  return true;
}

/**
 * =========================
 * PRODUCTS
 * =========================
 */
function parseStock(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return 0;
  if (s === "UNLIMITED" || s === "UNLIMIT") return "UNLIMITED";
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function stockText(stock) {
  if (stock === "UNLIMITED") return "∞ Ready";
  return Number(stock) > 0 ? `${stock} Ready` : "0 (Habis)";
}

async function getProducts(tabName) {
  const values = await readRange(`${tabName}!A:F`);
  if (values.length <= 1) return [];
  const rows = values.slice(1);

  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const id = String(r[0] || "").trim();
    if (!id) continue;

    out.push({
      tabName,
      rowIndex: i + 2,
      id,
      name: String(r[1] || "").trim() || id,
      link: String(r[2] || "").trim(),
      desc: String(r[3] || "").trim(),
      stock: parseStock(r[4]),
      price: Number(String(r[5] || "").trim() || 0)
    });
  }
  return out;
}

async function findProduct(category, productId) {
  const prods = await getProducts(category);
  return prods.find((p) => String(p.id) === String(productId));
}

async function addProduct(category, { id, name, link, desc, stock, price }) {
  const cat = String(category || "").trim();
  if (!cat) throw new Error("Kategori kosong.");

  await ensureSheetTabExists(cat);
  const head = await readRange(`${cat}!A1:F1`);
  if (!head.length) await appendRow(cat, ["ID", "NAMA PRODUK", "LINK DOWNLOAD", "DESKRIPSI", "STOCK", "HARGA"]);

  await appendRow(cat, [String(id), String(name), String(link), String(desc || ""), String(stock || "0"), String(price || "0")]);
  return true;
}

async function setProductStock(category, rowIndex, value) {
  await updateCell(category, `E${rowIndex}`, value);
}
async function setProductPrice(category, rowIndex, value) {
  await updateCell(category, `F${rowIndex}`, value);
}

/**
 * =========================
 * MEMBER LIST (untuk broadcast)
 * =========================
 */
async function ensureMember(chatId) {
  await ensureBaseTabs();
  const values = await readRange(`${TAB_MEMBER}!A:C`);
  const key = String(chatId);

  if (values.length > 1) {
    for (const r of values.slice(1)) {
      if (String(r[2] || "").trim() === key) return true;
    }
  }

  const nomor = Math.max(1, values.length || 1);
  await appendRow(TAB_MEMBER, [String(nomor), new Date().toISOString().slice(0, 10), key]);
  return true;
}

async function getAllMemberChatIds() {
  await ensureBaseTabs();
  const values = await readRange(`${TAB_MEMBER}!A:C`);
  if (values.length <= 1) return [];
  return values
    .slice(1)
    .map((r) => String(r[2] || "").trim())
    .filter((x) => /^\d+$/.test(x));
}

/**
 * =========================
 * BAN LIST
 * =========================
 */
async function isBanned(chatId) {
  await ensureBaseTabs();
  const values = await readRange(`${TAB_BANNED}!A:C`);
  if (values.length <= 1) return false;
  const key = String(chatId);
  return values.slice(1).some((r) => String(r[0] || "").trim() === key);
}

async function banUser(chatIdToBan, reason = "") {
  await ensureBaseTabs();
  const id = String(chatIdToBan).trim();
  if (!/^\d+$/.test(id)) throw new Error("CHAT_ID tidak valid.");
  const already = await isBanned(id);
  if (already) return true;
  await appendRow(TAB_BANNED, [id, String(reason || ""), nowISO()]);
  return true;
}

async function unbanUser(chatIdToUnban) {
  await ensureBaseTabs();
  const id = String(chatIdToUnban).trim();
  const values = await readRange(`${TAB_BANNED}!A:C`);
  if (values.length <= 1) return false;

  const rows = values.slice(1).filter((r) => String(r[0] || "").trim() !== id);
  await sheets.spreadsheets.values.clear({ spreadsheetId: SHEET_ID, range: `${TAB_BANNED}!A2:Z` });
  for (const r of rows) await appendRow(TAB_BANNED, r);
  return true;
}

/**
 * =========================
 * TRANSAKSI
 * =========================
 * TRANSAKSI columns:
 * A TANGGAL | B KATEGORI | C ID PRODUK | D NAMA | E USER | F INVOICE | G HARGA | H STATUS
 */
async function createTx({ category, product, chatId, username, invoice }) {
  const buyer = `${username ? "@" + username : "-"} | ${chatId}`;
  await appendRow(TAB_TX, [
    nowISO(),
    category,
    product.id,
    product.name,
    buyer,
    invoice,
    String(product.price),
    "PENDING"
  ]);
}

async function findTxByInvoice(invoice) {
  const values = await readRange(`${TAB_TX}!A:H`);
  if (values.length <= 1) return null;

  for (let i = 0; i < values.slice(1).length; i++) {
    const r = values[i + 1];
    if (String(r[5] || "").trim() === String(invoice).trim()) {
      const buyer = String(r[4] || "");
      const chatIdMatch = buyer.match(/\|\s*(\d+)\s*$/);
      return {
        rowIndex: i + 2,
        tanggal: r[0],
        category: r[1],
        product_id: r[2],
        product_name: r[3],
        buyer: r[4],
        invoice: r[5],
        price: Number(r[6] || 0),
        status: String(r[7] || ""),
        chat_id: chatIdMatch ? chatIdMatch[1] : ""
      };
    }
  }
  return null;
}

async function setTxStatus(rowIndex, status) {
  await updateCell(TAB_TX, `H${rowIndex}`, status);
}

async function copyTxTo(tabName, txRow) {
  await appendRow(tabName, [
    txRow.tanggal || nowISO(),
    txRow.category,
    txRow.product_id,
    txRow.product_name,
    txRow.buyer,
    txRow.invoice,
    String(txRow.price || 0),
    txRow.status
  ]);
}

/**
 * =========================
 * PAYMENT (NO BRAND di UI)
 * =========================
 */
async function transactionDetail(amount, invoice) {
  const url =
    `https://app.pakasir.com/api/transactiondetail` +
    `?project=${encodeURIComponent(PAYMENT_PROJECT_SLUG)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&order_id=${encodeURIComponent(invoice)}` +
    `&api_key=${encodeURIComponent(PAYMENT_API_KEY)}`;

  const resp = await fetch(url);
  return resp.json().catch(() => ({}));
}

function extractQrUrl(detail) {
  const t = detail?.transaction || {};
  return (
    t.qr_url ||
    t.qris_url ||
    t.qrcode_url ||
    t.qr_image ||
    detail?.qr_url ||
    detail?.qris_url ||
    ""
  );
}

/**
 * =========================
 * USER FLOWS
 * =========================
 */
async function sendWelcome(chatId, admin) {
  const text = welcomeText();

  if (BANNER_URL) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: BANNER_URL,
      caption: text,
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(admin)
    });
    return;
  }

  if (WELCOME_ANIM_FILE_ID) {
    await tg("sendAnimation", {
      chat_id: chatId,
      animation: WELCOME_ANIM_FILE_ID,
      caption: text,
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(admin)
    });
    return;
  }

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(admin)
  });
}

async function sendCategories(chatId) {
  const cats = await getCategories();
  if (!cats.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "⚠️ Kategori belum ada. Admin bisa tambah dengan /addcategory NAMA"
    });
    return;
  }

  const buttons = cats.map((c) => [{ text: `📁 ${c}`, callback_data: `CAT:${c}` }]);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `🗂 *Pilih Kategori*`,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons }
  });
}

async function sendCategoryProducts(chatId, category) {
  const products = await getProducts(category);
  if (!products.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Belum ada produk di kategori ini." });
    return;
  }

  let text = `📁 *${category}*\nPilih produk:\n\n`;
  const buttons = [];

  for (const p of products) {
    text += `• *${p.name}* — ${rupiah(p.price)} — _${stockText(p.stock)}_\n`;
    buttons.push([{ text: `🛒 ${p.name}`, callback_data: `PROD:${category}:${p.id}` }]);
  }

  buttons.push([{ text: "⬅️ Kembali", callback_data: "BACK:CATS" }]);

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons }
  });
}

async function sendProductDetail(chatId, category, productId) {
  const p = await findProduct(category, productId);
  if (!p) {
    await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
    return;
  }

  const text =
    `✅ *Konfirmasi Pesanan*\n\n` +
    `Produk: *${p.name}*\n` +
    `Harga: *${rupiah(p.price)}*\n` +
    `Stok: *${stockText(p.stock)}*\n\n` +
    `Lanjut buat invoice pembayaran?`;

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Ya, Buat Invoice", callback_data: `BUY:${category}:${p.id}` }],
        [{ text: "⬅️ Batal", callback_data: `CAT:${category}` }]
      ]
    }
  });
}

async function startCheckout(chatId, username, category, productId) {
  // banned gate
  if (await isBanned(chatId)) {
    await tg("sendMessage", { chat_id: chatId, text: "❌ Kamu tidak bisa menggunakan bot ini." });
    return;
  }

  const product = await findProduct(category, productId);
  if (!product) {
    await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
    return;
  }

  if (product.stock !== "UNLIMITED" && Number(product.stock) <= 0) {
    await tg("sendMessage", { chat_id: chatId, text: `❌ ${product.name} sedang habis.` });
    return;
  }

  const invoice = makeInvoice();
  await createTx({ category, product, chatId, username, invoice });

  const createdAt = new Date();
  const expiredAt = new Date(Date.now() + 60 * 60 * 1000);

  // get QR detail
  const detail = await transactionDetail(product.price, invoice);
  const qrUrl = extractQrUrl(detail);

  const caption =
    `Sedang memuat pembayaranmu, harap tunggu sebentar...\n\n` +
    `🧾 *Invoice Berhasil Dibuat*\n\n` +
    `salin\n` +
    `\`${invoice}\`\n\n` +
    `Informasi Item:\n` +
    `— Item Price Total: *${rupiah(product.price)}*\n` +
    `— Jumlah Item: *1x*\n` +
    `— List Yang Dibeli:\n` +
    `1. *${product.name}* x1 = *${rupiah(product.price)}*\n\n` +
    `Informasi Pembayaran:\n` +
    `— ID Transaksi: *${invoice}*\n` +
    `— Tanggal Dibuat: *${formatIDDateTime(createdAt)}*\n` +
    `— Total Dibayar: *${rupiah(product.price)}*\n` +
    `— Expired In: *${formatIDDateTimeLong(expiredAt)}*`;

  const markup = {
    inline_keyboard: [
      [{ text: "📋 Salin ID", callback_data: `COPY:${invoice}` }],
      [{ text: "🔄 Cek Status", callback_data: `CHECK:${invoice}` }],
      [{ text: "❌ Batalkan Pembelian", callback_data: `CANCEL:${invoice}` }],
      [{ text: "👨‍💻 Bantuan", callback_data: `HELP` }]
    ]
  };

  // send QR as photo (no web link button)
  if (qrUrl) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: qrUrl,
      caption,
      parse_mode: "Markdown",
      reply_markup: markup
    });
  } else {
    await tg("sendMessage", {
      chat_id: chatId,
      text: caption + `\n\n⚠️ QR belum tersedia. Klik *Cek Status* beberapa saat lagi.`,
      parse_mode: "Markdown",
      reply_markup: markup
    });
  }

  // notify admin order baru
  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `🆕 Order baru\n` +
      `Kategori: ${category}\n` +
      `Produk: ${product.name}\n` +
      `Invoice: ${invoice}\n` +
      `User: @${username || "-"} | ${chatId}\n` +
      `Total: ${rupiah(product.price)}`
  });
}

async function checkStatus(chatId, invoice) {
  const tx = await findTxByInvoice(invoice);
  if (!tx) {
    await tg("sendMessage", { chat_id: chatId, text: "Invoice tidak ditemukan." });
    return;
  }

  const detail = await transactionDetail(tx.price, invoice);
  const status = String(detail?.transaction?.status || detail?.status || "unknown").toUpperCase();

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `🧾 *Status Pesanan*\n\n` +
      `Invoice: \`${invoice}\`\n` +
      `Produk: *${tx.product_name}*\n` +
      `Total: *${rupiah(tx.price)}*\n` +
      `Status: *${status}*`,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Cek Lagi", callback_data: `CHECK:${invoice}` }],
        [{ text: "🗂 Kategori", callback_data: "BACK:CATS" }]
      ]
    }
  });
}

async function cancelInvoice(chatId, invoice) {
  const tx = await findTxByInvoice(invoice);
  if (!tx) {
    await tg("sendMessage", { chat_id: chatId, text: "Invoice tidak ditemukan." });
    return;
  }

  if (String(tx.chat_id) !== String(chatId)) {
    await tg("sendMessage", { chat_id: chatId, text: "Invoice ini bukan milik kamu." });
    return;
  }

  const st = String(tx.status || "").toUpperCase();
  if (st === "SUCCESS" || st === "PAID") {
    await tg("sendMessage", { chat_id: chatId, text: "Invoice sudah berhasil, tidak bisa dibatalkan." });
    return;
  }

  tx.status = "CANCELLED";
  await setTxStatus(tx.rowIndex, "CANCELLED");
  await copyTxTo(TAB_FAIL, tx);

  await tg("sendMessage", { chat_id: chatId, text: `✅ Invoice ${invoice} dibatalkan.` });
}

// deliver after PAID (from payment webhook)
async function deliverPaid(invoice, amount) {
  const tx = await findTxByInvoice(invoice);
  if (!tx) {
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Pembayaran sukses tapi invoice tidak ada di sheet\nInvoice: ${invoice}\nAmount: ${amount}`
    });
    return;
  }

  if (String(tx.status).toUpperCase() === "SUCCESS") return;

  // ambil produk dari kategori + id
  const product = await findProduct(tx.category, tx.product_id);

  if (!product) {
    tx.status = "SUCCESS";
    await setTxStatus(tx.rowIndex, "SUCCESS");
    await copyTxTo(TAB_SUCCESS, tx);
    await tg("sendMessage", {
      chat_id: tx.chat_id,
      text: `✅ Pembayaran sukses.\nNamun produk tidak ditemukan di sheet. Hubungi admin.\nInvoice: ${invoice}`
    });
    return;
  }

  // amount match check
  if (Number(product.price) !== Number(amount)) {
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Amount mismatch\nInvoice: ${invoice}\nPrice: ${product.price}\nWebhook: ${amount}`
    });
    return;
  }

  // reduce stock
  if (product.stock !== "UNLIMITED") {
    const current = Number(product.stock || 0);
    if (current > 0) {
      await setProductStock(tx.category, product.rowIndex, String(current - 1));
    }
  }

  // set success
  tx.status = "SUCCESS";
  await setTxStatus(tx.rowIndex, "SUCCESS");
  await copyTxTo(TAB_SUCCESS, tx);

  // deliver product
  await tg("sendMessage", {
    chat_id: tx.chat_id,
    parse_mode: "Markdown",
    text:
      `✅ *Transaksi berhasil!*\n\n` +
      `📦 Produk: *${product.name}*\n` +
      `🧾 Invoice: \`${invoice}\`\n\n` +
      `🔗 *Link Download:*\n${product.link || "(link kosong di sheet)"}\n\n` +
      `Terima kasih 🙏`
  });

  // notify admin success
  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `✅ Transaksi berhasil\n` +
      `Kategori: ${tx.category}\n` +
      `Produk: ${product.name}\n` +
      `Invoice: ${invoice}\n` +
      `Pembeli: ${tx.buyer}\n` +
      `Total: ${rupiah(product.price)}`
  });
}

/**
 * =========================
 * ADMIN PANEL (FULL)
 * =========================
 */
function adminPanelKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "📣 Broadcast", callback_data: "AD:BROADCAST" }],
      [{ text: "📦 Kelola Stock", callback_data: "AD:STOCK" }, { text: "💰 Kelola Harga", callback_data: "AD:PRICE" }],
      [{ text: "🗂 Kelola Kategori", callback_data: "AD:CATS" }, { text: "🧾 Riwayat Transaksi", callback_data: "AD:TXHIST" }],
      [{ text: "📊 Dashboard", callback_data: "AD:DASH" }, { text: "🚫 Ban/Unban", callback_data: "AD:BANMENU" }],
      [{ text: "📤 Export CSV", callback_data: "AD:EXPORTCSV" }]
    ]
  };
}

async function sendAdminPanel(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `🛠 *Panel Admin ${BRAND_NAME}*\n\n` +
      `Perintah cepat:\n` +
      `• /broadcast pesan\n` +
      `• /addcategory NAMA\n` +
      `• /editcategory LAMA|BARU\n` +
      `• /delcategory NAMA\n` +
      `• /addproduct KATEGORI|ID|NAMA|LINK|HARGA|STOCK|DESK\n` +
      `• /setprice KATEGORI|ID|HARGA\n` +
      `• /setstock KATEGORI|ID|STOCK(angka/UNLIMITED)\n` +
      `• /ban CHAT_ID|ALASAN\n` +
      `• /unban CHAT_ID\n`,
    parse_mode: "Markdown",
    reply_markup: adminPanelKeyboard()
  });
}

async function adminAskBroadcast(chatId) {
  await tg("sendMessage", { chat_id: chatId, text: "📣 Broadcast\nKetik:\n/broadcast pesan kamu" });
}

async function adminDoBroadcast(chatId, message) {
  const ids = await getAllMemberChatIds();
  let sent = 0;
  for (const id of ids) {
    try {
      await tg("sendMessage", { chat_id: id, text: message });
      sent++;
    } catch {}
  }
  await tg("sendMessage", { chat_id: chatId, text: `✅ Broadcast terkirim ke ${sent} member.` });
}

async function adminShowCategories(chatId) {
  const cats = await getCategories();
  let text = `🗂 Kategori aktif:\n\n`;
  if (!cats.length) text += "(belum ada)\n";
  for (const c of cats) text += `• ${c}\n`;

  text +=
    `\nPerintah:\n` +
    `• /addcategory NAMA\n` +
    `• /editcategory LAMA|BARU\n` +
    `• /delcategory NAMA (hapus dari list, tab tidak dihapus)\n`;

  await tg("sendMessage", { chat_id: chatId, text });
}

async function adminTxHistory(chatId) {
  const values = await readRange(`${TAB_TX}!A:H`);
  if (values.length <= 1) {
    await tg("sendMessage", { chat_id: chatId, text: "Belum ada transaksi." });
    return;
  }
  const rows = values.slice(-10);
  let text = "🧾 10 Transaksi terakhir:\n\n";
  for (const r of rows) {
    const inv = r[5];
    const prod = r[3];
    const status = r[7];
    text += `• ${inv} | ${prod} | ${status}\n`;
  }
  await tg("sendMessage", { chat_id: chatId, text });
}

async function adminDashboard(chatId) {
  const ok = await readRange(`${TAB_SUCCESS}!A:H`);
  const fail = await readRange(`${TAB_FAIL}!A:H`);
  const all = await readRange(`${TAB_TX}!A:H`);

  const totalOk = Math.max(0, ok.length - 1);
  const totalFail = Math.max(0, fail.length - 1);
  const totalAll = Math.max(0, all.length - 1);

  // revenue (success)
  let revenue = 0;
  for (const r of ok.slice(1)) revenue += Number(r[6] || 0);

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `📊 Dashboard ${BRAND_NAME}\n\n` +
      `🧾 Total transaksi: ${totalAll}\n` +
      `✅ Berhasil: ${totalOk}\n` +
      `❌ Gagal/CANCEL: ${totalFail}\n` +
      `💰 Omzet (berhasil): ${rupiah(revenue)}`
  });
}

async function adminStockOverview(chatId) {
  const cats = await getCategories();
  if (!cats.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Kategori belum ada." });
    return;
  }
  const buttons = cats.map((c) => [{ text: `📁 ${c}`, callback_data: `AD:STOCKCAT:${c}` }]);
  buttons.push([{ text: "⬅️ Kembali", callback_data: "AD:HOME" }]);
  await tg("sendMessage", {
    chat_id: chatId,
    text: "📦 Kelola Stock\nPilih kategori:",
    reply_markup: { inline_keyboard: buttons }
  });
}

async function adminPriceOverview(chatId) {
  const cats = await getCategories();
  if (!cats.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Kategori belum ada." });
    return;
  }
  const buttons = cats.map((c) => [{ text: `📁 ${c}`, callback_data: `AD:PRICECAT:${c}` }]);
  buttons.push([{ text: "⬅️ Kembali", callback_data: "AD:HOME" }]);
  await tg("sendMessage", {
    chat_id: chatId,
    text: "💰 Kelola Harga\nPilih kategori:",
    reply_markup: { inline_keyboard: buttons }
  });
}

async function adminListProductsForStock(chatId, category) {
  const products = await getProducts(category);
  if (!products.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Kategori ini kosong." });
    return;
  }
  const buttons = products.map((p) => [
    { text: `${p.id}. ${p.name}`, callback_data: `AD:STOCKPROD:${category}:${p.id}` }
  ]);
  buttons.push([{ text: "⬅️ Kembali", callback_data: "AD:STOCK" }]);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `📦 Kelola Stock\nKategori: ${category}\nPilih produk:`,
    reply_markup: { inline_keyboard: buttons }
  });
}

async function adminListProductsForPrice(chatId, category) {
  const products = await getProducts(category);
  if (!products.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Kategori ini kosong." });
    return;
  }
  const buttons = products.map((p) => [
    { text: `${p.id}. ${p.name}`, callback_data: `AD:PRICEPROD:${category}:${p.id}` }
  ]);
  buttons.push([{ text: "⬅️ Kembali", callback_data: "AD:PRICE" }]);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `💰 Kelola Harga\nKategori: ${category}\nPilih produk:`,
    reply_markup: { inline_keyboard: buttons }
  });
}

async function adminStockProductMenu(chatId, category, productId) {
  const p = await findProduct(category, productId);
  if (!p) {
    await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
    return;
  }
  const cur = p.stock === "UNLIMITED" ? "UNLIMITED" : String(p.stock);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `📦 Kelola Stock\n\nKategori: ${category}\nProduk: ${p.name}\nStock sekarang: ${cur}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "+1", callback_data: `AD:STOCKDELTA:${category}:${p.id}:1` },
          { text: "-1", callback_data: `AD:STOCKDELTA:${category}:${p.id}:-1` }
        ],
        [
          { text: "Set UNLIMITED", callback_data: `AD:STOCKSET:${category}:${p.id}:UNLIMITED` },
          { text: "Set 0", callback_data: `AD:STOCKSET:${category}:${p.id}:0` }
        ],
        [{ text: "Set angka (ketik)", callback_data: `AD:STOCKASK:${category}:${p.id}` }],
        [{ text: "⬅️ Kembali", callback_data: `AD:STOCKCAT:${category}` }]
      ]
    }
  });
}

async function adminPriceProductMenu(chatId, category, productId) {
  const p = await findProduct(category, productId);
  if (!p) {
    await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
    return;
  }
  await tg("sendMessage", {
    chat_id: chatId,
    text: `💰 Kelola Harga\n\nKategori: ${category}\nProduk: ${p.name}\nHarga sekarang: ${rupiah(p.price)}\n\nPilih aksi:`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "Set harga (ketik)", callback_data: `AD:PRICEASK:${category}:${p.id}` }],
        [{ text: "⬅️ Kembali", callback_data: `AD:PRICECAT:${category}` }]
      ]
    }
  });
}

async function adminBanMenu(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `🚫 Ban/Unban User\n\n` +
      `Perintah:\n` +
      `• /ban CHAT_ID|ALASAN\n` +
      `• /unban CHAT_ID\n\n` +
      `Tips: chat_id bisa kamu lihat dari transaksi (kolom pembeli) atau forward pesan user.`,
    reply_markup: { inline_keyboard: [[{ text: "⬅️ Kembali", callback_data: "AD:HOME" }]] }
  });
}

function toCSV(rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

async function adminExportCSV(chatId) {
  const values = await readRange(`${TAB_TX}!A:H`);
  if (!values.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Sheet kosong." });
    return;
  }
  const csv = toCSV(values);
  const buf = Buffer.from(csv, "utf-8");

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("document", buf, { filename: "transaksi.csv", contentType: "text/csv" });
  form.append("caption", "📤 Export transaksi (CSV)");

  await tg("sendDocument", form);
}

/**
 * =========================
 * ADMIN INPUT STATE (set angka via chat)
 * =========================
 */
const adminState = new Map(); // chatId -> { mode, category, productId }

function setAdminState(chatId, state) {
  adminState.set(String(chatId), state);
}
function getAdminState(chatId) {
  return adminState.get(String(chatId)) || null;
}
function clearAdminState(chatId) {
  adminState.delete(String(chatId));
}

/**
 * =========================
 * ROUTES: TELEGRAM WEBHOOK
 * =========================
 */
app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    // CALLBACK QUERY
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const data = cq.data || "";
      const username = cq.from?.username || "";

      await tg("answerCallbackQuery", { callback_query_id: cq.id });

      // user callbacks
      if (data === "BACK:CATS") await sendCategories(chatId);
      else if (data.startsWith("CAT:")) await sendCategoryProducts(chatId, data.slice(4));
      else if (data.startsWith("PROD:")) {
        const [, cat, pid] = data.split(":");
        await sendProductDetail(chatId, cat, pid);
      } else if (data.startsWith("BUY:")) {
        const [, cat, pid] = data.split(":");
        await startCheckout(chatId, username, cat, pid);
      } else if (data.startsWith("COPY:")) {
        const inv = data.slice(5);
        await tg("sendMessage", { chat_id: chatId, text: `ID Transaksi:\n\`${inv}\``, parse_mode: "Markdown" });
      } else if (data.startsWith("CHECK:")) await checkStatus(chatId, data.slice(6));
      else if (data.startsWith("CANCEL:")) await cancelInvoice(chatId, data.slice(7));
      else if (data === "HELP") {
        await tg("sendMessage", {
          chat_id: chatId,
          text: helpText(),
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard(isAdmin(chatId))
        });
      }

      // admin callbacks
      if (isAdmin(chatId)) {
        if (data === "AD:HOME") await sendAdminPanel(chatId);
        if (data === "AD:BROADCAST") await adminAskBroadcast(chatId);
        if (data === "AD:TXHIST") await adminTxHistory(chatId);
        if (data === "AD:DASH") await adminDashboard(chatId);
        if (data === "AD:CATS") await adminShowCategories(chatId);
        if (data === "AD:STOCK") await adminStockOverview(chatId);
        if (data === "AD:PRICE") await adminPriceOverview(chatId);
        if (data === "AD:BANMENU") await adminBanMenu(chatId);
        if (data === "AD:EXPORTCSV") await adminExportCSV(chatId);

        if (data.startsWith("AD:STOCKCAT:")) {
          const cat = data.replace("AD:STOCKCAT:", "");
          await adminListProductsForStock(chatId, cat);
        }
        if (data.startsWith("AD:PRICECAT:")) {
          const cat = data.replace("AD:PRICECAT:", "");
          await adminListProductsForPrice(chatId, cat);
        }

        if (data.startsWith("AD:STOCKPROD:")) {
          const [, , cat, pid] = data.split(":");
          await adminStockProductMenu(chatId, cat, pid);
        }
        if (data.startsWith("AD:PRICEPROD:")) {
          const [, , cat, pid] = data.split(":");
          await adminPriceProductMenu(chatId, cat, pid);
        }

        if (data.startsWith("AD:STOCKDELTA:")) {
          const [, , cat, pid, deltaStr] = data.split(":");
          const delta = Number(deltaStr || 0);
          const p = await findProduct(cat, pid);
          if (!p) return res.sendStatus(200);
          if (p.stock === "UNLIMITED") {
            await tg("sendMessage", { chat_id: chatId, text: "Stock UNLIMITED, tidak perlu +/−." });
            return res.sendStatus(200);
          }
          const next = Math.max(0, Number(p.stock || 0) + delta);
          await setProductStock(cat, p.rowIndex, String(next));
          await tg("sendMessage", { chat_id: chatId, text: `✅ Stock ${p.name} sekarang: ${next}` });
        }

        if (data.startsWith("AD:STOCKSET:")) {
          const [, , cat, pid, value] = data.split(":");
          const p = await findProduct(cat, pid);
          if (!p) return res.sendStatus(200);
          await setProductStock(cat, p.rowIndex, String(value));
          await tg("sendMessage", { chat_id: chatId, text: `✅ Stock ${p.name} di-set: ${value}` });
        }

        if (data.startsWith("AD:STOCKASK:")) {
          const [, , cat, pid] = data.split(":");
          setAdminState(chatId, { mode: "STOCK", category: cat, productId: pid });
          await tg("sendMessage", {
            chat_id: chatId,
            text: `Ketik stock baru (angka) untuk ${cat} | ${pid}\nContoh: 25\n\nKetik /cancel untuk batal.`
          });
        }

        if (data.startsWith("AD:PRICEASK:")) {
          const [, , cat, pid] = data.split(":");
          setAdminState(chatId, { mode: "PRICE", category: cat, productId: pid });
          await tg("sendMessage", {
            chat_id: chatId,
            text: `Ketik harga baru (angka) untuk ${cat} | ${pid}\nContoh: 15000\n\nKetik /cancel untuk batal.`
          });
        }
      }

      return res.sendStatus(200);
    }

    // MESSAGE
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = String(update.message.text || "").trim();
      const username = update.message.from?.username || "";
      const admin = isAdmin(chatId);

      // banned gate for non-admin
      if (!admin && (await isBanned(chatId))) {
        await tg("sendMessage", { chat_id: chatId, text: "❌ Kamu tidak bisa menggunakan bot ini." });
        return res.sendStatus(200);
      }

      // ensure member (for broadcast)
      if (text === "/start") {
        await ensureMember(chatId);
        await sendWelcome(chatId, admin);
        return res.sendStatus(200);
      }

      // admin state input (set stock/price via message)
      if (admin) {
        if (text === "/cancel") {
          clearAdminState(chatId);
          await tg("sendMessage", { chat_id: chatId, text: "✅ Dibatalkan." });
          return res.sendStatus(200);
        }

        const st = getAdminState(chatId);
        if (st && st.mode === "STOCK") {
          const n = Number(text);
          if (!Number.isFinite(n) || n < 0) {
            await tg("sendMessage", { chat_id: chatId, text: "Masukkan angka stock yang valid (>=0) atau /cancel." });
            return res.sendStatus(200);
          }
          const p = await findProduct(st.category, st.productId);
          if (!p) {
            clearAdminState(chatId);
            await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
            return res.sendStatus(200);
          }
          await setProductStock(st.category, p.rowIndex, String(n));
          clearAdminState(chatId);
          await tg("sendMessage", { chat_id: chatId, text: `✅ Stock ${p.name} sekarang: ${n}` });
          return res.sendStatus(200);
        }

        if (st && st.mode === "PRICE") {
          const n = Number(text);
          if (!Number.isFinite(n) || n <= 0) {
            await tg("sendMessage", { chat_id: chatId, text: "Masukkan angka harga yang valid (>0) atau /cancel." });
            return res.sendStatus(200);
          }
          const p = await findProduct(st.category, st.productId);
          if (!p) {
            clearAdminState(chatId);
            await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
            return res.sendStatus(200);
          }
          await setProductPrice(st.category, p.rowIndex, String(n));
          clearAdminState(chatId);
          await tg("sendMessage", { chat_id: chatId, text: `✅ Harga ${p.name} sekarang: ${rupiah(n)}` });
          return res.sendStatus(200);
        }
      }

      // menu buttons
      if (text === "🗂 Kategori") {
        await sendCategories(chatId);
        return res.sendStatus(200);
      }

      if (text === "🧾 Cek Pesanan") {
        await tg("sendMessage", { chat_id: chatId, text: "Ketik:\n/cek TX....\nContoh:\n/cek TX123456...." });
        return res.sendStatus(200);
      }

      if (text === "📌 Cara Order") {
        await tg("sendMessage", {
          chat_id: chatId,
          text: howToText(),
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard(admin)
        });
        return res.sendStatus(200);
      }

      if (text === "👨‍💻 Bantuan") {
        await tg("sendMessage", {
          chat_id: chatId,
          text: helpText(),
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard(admin)
        });
        return res.sendStatus(200);
      }

      if (text === "🏓 Ping" || text === "/ping") {
        await tg("sendMessage", { chat_id: chatId, text: "✅ Bot aktif." });
        return res.sendStatus(200);
      }

      // /cek invoice
      if (text.toLowerCase().startsWith("/cek")) {
        const inv = text.replace(/\/cek/i, "").trim();
        if (!inv) await tg("sendMessage", { chat_id: chatId, text: "Format: /cek TX..." });
        else await checkStatus(chatId, inv);
        return res.sendStatus(200);
      }

      // admin panel
      if (admin && (text === "/admin" || text.includes("Panel Admin"))) {
        await sendAdminPanel(chatId);
        return res.sendStatus(200);
      }

      /**
       * =========================
       * ADMIN COMMANDS (FULL)
       * =========================
       */
      if (admin && text === "/init") {
        await ensureBaseTabs();
        await tg("sendMessage", { chat_id: chatId, text: "✅ Init selesai. Tabs base sudah dicek/dibuat." });
        return res.sendStatus(200);
      }

      if (text.startsWith("/broadcast")) {
        if (!admin) {
          await tg("sendMessage", { chat_id: chatId, text: "❌ Khusus admin." });
          return res.sendStatus(200);
        }
        const msg = text.replace("/broadcast", "").trim();
        if (!msg) {
          await tg("sendMessage", { chat_id: chatId, text: "Format:\n/broadcast pesan kamu" });
          return res.sendStatus(200);
        }
        await adminDoBroadcast(chatId, msg);
        return res.sendStatus(200);
      }

      if (admin && text.startsWith("/addcategory")) {
        const name = text.replace("/addcategory", "").trim();
        if (!name) {
          await tg("sendMessage", { chat_id: chatId, text: "Format: /addcategory NAMA" });
          return res.sendStatus(200);
        }
        try {
          await addCategory(name);
          await tg("sendMessage", { chat_id: chatId, text: `✅ Kategori ditambahkan: ${name}` });
        } catch (e) {
          await tg("sendMessage", { chat_id: chatId, text: `❌ Gagal: ${e.message}` });
        }
        return res.sendStatus(200);
      }

      if (admin && text.startsWith("/editcategory")) {
        const raw = text.replace("/editcategory", "").trim();
        const [oldName, newName] = raw.split("|").map((s) => s.trim());
        if (!oldName || !newName) {
          await tg("sendMessage", { chat_id: chatId, text: "Format: /editcategory LAMA|BARU" });
          return res.sendStatus(200);
        }
        try {
          await editCategory(oldName, newName);
          await tg("sendMessage", { chat_id: chatId, text: `✅ Kategori diubah: ${oldName} → ${newName}` });
        } catch (e) {
          await tg("sendMessage", { chat_id: chatId, text: `❌ Gagal: ${e.message}` });
        }
        return res.sendStatus(200);
      }

      if (admin && text.startsWith("/delcategory")) {
        const name = text.replace("/delcategory", "").trim();
        if (!name) {
          await tg("sendMessage", { chat_id: chatId, text: "Format: /delcategory NAMA" });
          return res.sendStatus(200);
        }
        try {
          await delCategory(name);
          await tg("sendMessage", { chat_id: chatId, text: `✅ Kategori dihapus dari list: ${name}\n(tab sheet tidak dihapus)` });
        } catch (e) {
          await tg("sendMessage", { chat_id: chatId, text: `❌ Gagal: ${e.message}` });
        }
        return res.sendStatus(200);
      }

      // /addproduct KATEGORI|ID|NAMA|LINK|HARGA|STOCK|DESK
      if (admin && text.startsWith("/addproduct")) {
        const raw = text.replace("/addproduct", "").trim();
        const parts = raw.split("|").map((s) => s.trim());
        const [cat, id, name, link, price, stock, desc] = parts;

        if (!cat || !id || !name || !link || !price) {
          await tg("sendMessage", {
            chat_id: chatId,
            text:
              "Format:\n/addproduct KATEGORI|ID|NAMA|LINK|HARGA|STOCK|DESK\nContoh:\n/addproduct APK NONTON|1|APK DRAKOR ID|https://...|15000|UNLIMITED|Deskripsi..."
          });
          return res.sendStatus(200);
        }

        try {
          await addCategory(cat); // auto ensure category exists + tab created
          await addProduct(cat, {
            id,
            name,
            link,
            desc: desc || "",
            stock: stock || "0",
            price: Number(price || 0)
          });
          await tg("sendMessage", { chat_id: chatId, text: `✅ Produk ditambahkan ke ${cat}.` });
        } catch (e) {
          await tg("sendMessage", { chat_id: chatId, text: `❌ Gagal: ${e.message}` });
        }
        return res.sendStatus(200);
      }

      // /setprice KATEGORI|ID|HARGA
      if (admin && text.startsWith("/setprice")) {
        const raw = text.replace("/setprice", "").trim();
        const [cat, id, priceStr] = raw.split("|").map((s) => s.trim());
        const price = Number(priceStr || 0);
        if (!cat || !id || !Number.isFinite(price) || price <= 0) {
          await tg("sendMessage", { chat_id: chatId, text: "Format:\n/setprice KATEGORI|ID|HARGA\nContoh:\n/setprice APK NONTON|1|15000" });
          return res.sendStatus(200);
        }
        const p = await findProduct(cat, id);
        if (!p) {
          await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
          return res.sendStatus(200);
        }
        await setProductPrice(cat, p.rowIndex, String(price));
        await tg("sendMessage", { chat_id: chatId, text: `✅ Harga ${p.name} sekarang: ${rupiah(price)}` });
        return res.sendStatus(200);
      }

      // /setstock KATEGORI|ID|STOCK(angka/UNLIMITED)
      if (admin && text.startsWith("/setstock")) {
        const raw = text.replace("/setstock", "").trim();
        const [cat, id, stockStr] = raw.split("|").map((s) => s.trim());
        if (!cat || !id || !stockStr) {
          await tg("sendMessage", { chat_id: chatId, text: "Format:\n/setstock KATEGORI|ID|STOCK\nContoh:\n/setstock APK NONTON|1|10\natau:\n/setstock APK NONTON|1|UNLIMITED" });
          return res.sendStatus(200);
        }
        const p = await findProduct(cat, id);
        if (!p) {
          await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
          return res.sendStatus(200);
        }
        const up = stockStr.toUpperCase();
        if (up === "UNLIMITED" || up === "UNLIMIT") {
          await setProductStock(cat, p.rowIndex, "UNLIMITED");
          await tg("sendMessage", { chat_id: chatId, text: `✅ Stock ${p.name} di-set: UNLIMITED` });
          return res.sendStatus(200);
        }
        const n = Number(stockStr);
        if (!Number.isFinite(n) || n < 0) {
          await tg("sendMessage", { chat_id: chatId, text: "Stock harus angka >=0 atau UNLIMITED." });
          return res.sendStatus(200);
        }
        await setProductStock(cat, p.rowIndex, String(n));
        await tg("sendMessage", { chat_id: chatId, text: `✅ Stock ${p.name} sekarang: ${n}` });
        return res.sendStatus(200);
      }

      // /ban CHAT_ID|ALASAN
      if (admin && text.startsWith("/ban")) {
        const raw = text.replace("/ban", "").trim();
        const [id, reason] = raw.split("|").map((s) => s.trim());
        if (!id) {
          await tg("sendMessage", { chat_id: chatId, text: "Format:\n/ban CHAT_ID|ALASAN" });
          return res.sendStatus(200);
        }
        try {
          await banUser(id, reason || "");
          await tg("sendMessage", { chat_id: chatId, text: `✅ User diban: ${id}` });
        } catch (e) {
          await tg("sendMessage", { chat_id: chatId, text: `❌ Gagal: ${e.message}` });
        }
        return res.sendStatus(200);
      }

      // /unban CHAT_ID
      if (admin && text.startsWith("/unban")) {
        const id = text.replace("/unban", "").trim();
        if (!id) {
          await tg("sendMessage", { chat_id: chatId, text: "Format:\n/unban CHAT_ID" });
          return res.sendStatus(200);
        }
        await unbanUser(id);
        await tg("sendMessage", { chat_id: chatId, text: `✅ User di-unban: ${id}` });
        return res.sendStatus(200);
      }

      // default
      await tg("sendMessage", {
        chat_id: chatId,
        text: "Pilih menu di bawah ya 🙂",
        reply_markup: mainMenuKeyboard(admin)
      });
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Telegram webhook error:", err);
    return res.sendStatus(200);
  }
});

/**
 * =========================
 * PAYMENT WEBHOOK (NO BRAND)
 * - dashboard payment harus diarahkan ke:
 *   https://<service>.onrender.com/payment/webhook/<PAYMENT_WEBHOOK_SECRET>
 * =========================
 */
app.post(`/payment/webhook/${PAYMENT_WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const body = req.body || {};
    const { amount, order_id } = body;

    res.status(200).json({ ok: true });

    if (!order_id || !amount) return;

    const detail = await transactionDetail(amount, order_id);
    const t = detail?.transaction;
    if (!t) return;

    const finalStatus = String(t.status || "").toLowerCase();
    if (finalStatus !== "completed") return;

    await deliverPaid(order_id, amount);
  } catch (err) {
    console.error("Payment webhook error:", err);
  }
});

/**
 * =========================
 * START SERVER
 * =========================
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
