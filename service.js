import express from "express";
import { google } from "googleapis";
import fetch from "node-fetch";
import crypto from "crypto";

/**
 * =========================
 * ENV
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
  "PAYMENT_WEBHOOK_SECRET",
  "CATEGORY_TABS"
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

// Payment gateway (JANGAN disebut di UI)
const PAYMENT_PROJECT_SLUG = process.env.PAYMENT_PROJECT_SLUG;
const PAYMENT_API_KEY = process.env.PAYMENT_API_KEY;
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET;

const CATEGORY_TABS = process.env.CATEGORY_TABS;

// Tabs fixed
const TAB_TX = "TRANSAKSI";
const TAB_SUCCESS = "TRANSAKSI BERHASIL";
const TAB_FAIL = "TRANSAKSI GAGAL";
const TAB_MEMBER = "MEMBER LIST";

// Categories
let CATEGORIES = CATEGORY_TABS.split(",").map((s) => s.trim()).filter(Boolean);

/**
 * =========================
 * EXPRESS
 * =========================
 */
const app = express();
app.use(express.json());

/**
 * =========================
 * GOOGLE SHEETS
 * =========================
 */
function getGoogleAuth() {
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}

const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });

async function readRange(rangeA1) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: rangeA1
  });
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

/**
 * =========================
 * TELEGRAM
 * =========================
 */
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
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

function formatIDDateTime(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = String(d.getFullYear()).slice(-2);
  const hour = pad(d.getHours());
  const min = pad(d.getMinutes());
  return `${day}/${month}/${year} ${hour}.${min}`;
}

function formatIDDateTimeLong(d = new Date()) {
  const months = [
    "Januari","Februari","Maret","April","Mei","Juni",
    "Juli","Agustus","September","Oktober","November","Desember"
  ];
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getDate()} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * =========================
 * UI (GOMS APK)
 * =========================
 */
function welcomeText() {
  return (
    `🔥 *Selamat Datang di GOMS APK* 🔥\n\n` +
    `⚡ Produk dikirim otomatis setelah pembayaran sukses\n` +
    `💳 Pembayaran via QR\n` +
    `🚀 Fast respon & Auto System\n\n` +
    `Klik *🗂 Kategori* untuk mulai belanja 👇`
  );
}

function howToText() {
  return (
    `📌 *Cara Order*\n\n` +
    `1) Klik *🗂 Kategori*\n` +
    `2) Pilih kategori → pilih produk\n` +
    `3) Klik *Beli*\n` +
    `4) Scan QR & bayar\n` +
    `5) Produk otomatis dikirim ✅\n\n` +
    `Cek status: \`/cek TX...\``
  );
}

function helpText() {
  return (
    `👨‍💻 *Bantuan*\n\n` +
    `Jika pembayaran sukses tapi produk belum masuk:\n` +
    `1) Klik *Cek Status*\n` +
    `2) Tunggu 1-2 menit\n` +
    `3) Kirim ID transaksi ke admin\n\n` +
    `Cek status: \`/cek TX...\``
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
 * CATEGORY + PRODUCTS
 * Sheet format per category tab:
 * A ID | B NAMA | C LINK | D DESK | E STOCK | F HARGA
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

async function findProductById(productId) {
  for (const tab of CATEGORIES) {
    const products = await getProducts(tab);
    const p = products.find((x) => String(x.id) === String(productId));
    if (p) return p;
  }
  return null;
}

/**
 * =========================
 * MEMBER (broadcast)
 * MEMBER LIST: simpan chat_id di kolom C (sesuai sheet kamu)
 * Header: A NOMOR | B TANGGAL GABUNG | C USERNAME/ID MEMBER
 * =========================
 */
async function ensureMember(chatId) {
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
  const values = await readRange(`${TAB_MEMBER}!A:C`);
  if (values.length <= 1) return [];
  return values
    .slice(1)
    .map((r) => String(r[2] || "").trim())
    .filter((x) => /^\d+$/.test(x));
}

/**
 * =========================
 * TRANSAKSI
 * TRANSAKSI columns:
 * A TANGGAL | B KATEGORI | C ID PRODUK | D NAMA | E USER | F INVOICE | G HARGA | H STATUS
 * =========================
 */
async function createTx({ product, chatId, username, invoice }) {
  const buyer = `${username ? "@" + username : "-"} | ${chatId}`;
  await appendRow(TAB_TX, [
    new Date().toISOString(),
    product.tabName,
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
    txRow.tanggal || new Date().toISOString(),
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
 * PAYMENT DETAIL (NO BRAND)
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
 * FLOWS
 * =========================
 */
async function sendCategories(chatId) {
  const buttons = CATEGORIES.map((c) => [{ text: `📁 ${c}`, callback_data: `CAT:${c}` }]);
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
    buttons.push([{ text: `🛒 ${p.name}`, callback_data: `PROD:${p.id}` }]);
  }

  buttons.push([{ text: "⬅️ Kembali", callback_data: "BACK:CATS" }]);

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons }
  });
}

async function sendProductDetail(chatId, productId) {
  const p = await findProductById(productId);
  if (!p) {
    await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
    return;
  }

  const text =
    `📦 *${p.name}*\n\n` +
    `💰 Harga: *${rupiah(p.price)}*\n` +
    `📌 Stok: *${stockText(p.stock)}*\n\n` +
    `📝 Deskripsi:\n${p.desc || "-"}\n\n` +
    `Klik *Beli* untuk buat invoice & QR pembayaran.`;

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Beli", callback_data: `BUY:${p.id}` }],
        [{ text: "⬅️ Kembali", callback_data: `CAT:${p.tabName}` }]
      ]
    }
  });
}

async function startCheckout(chatId, username, productId) {
  const product = await findProductById(productId);
  if (!product) {
    await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
    return;
  }

  if (REQUIRE_MEMBERSHIP) {
    const ok = await isMember(chatId);
    if (!ok) {
      await tg("sendMessage", { chat_id: chatId, text: "❌ Khusus member. Ketik /start dulu." });
      return;
    }
  }

  if (product.stock !== "UNLIMITED" && Number(product.stock) <= 0) {
    await tg("sendMessage", { chat_id: chatId, text: `❌ ${product.name} sedang habis.` });
    return;
  }

  const invoice = makeInvoice();
  await createTx({ product, chatId, username, invoice });

  const createdAt = new Date();
  const expiredAt = new Date(Date.now() + 60 * 60 * 1000);

  const detail = await transactionDetail(product.price, invoice);
  const qrUrl = extractQrUrl(detail);

  const caption =
    `Sedang memuat pembayaranmu, harap tunggu sebentar...\n\n` +
    `🧾 *Invoice Berhasil Dibuat*\n\n` +
    `salin\n` +
    `\`${invoice}\`\n\n` +
    `*Informasi Item:*\n` +
    `— Item Price Total: *${rupiah(product.price)}*\n` +
    `— Jumlah Item: *1x*\n` +
    `— List Yang Dibeli:\n` +
    `1. *${product.name}* x1 = *${rupiah(product.price)}*\n\n` +
    `*Informasi Pembayaran:*\n` +
    `— ID Transaksi: *${invoice}*\n` +
    `— Tanggal Dibuat: *${formatIDDateTime(createdAt)}*\n` +
    `— Total Dibayar: *${rupiah(product.price)}*\n` +
    `— Expired In: *${formatIDDateTimeLong(expiredAt)}*`;

  const markup = {
    inline_keyboard: [
      [{ text: "Salin", callback_data: `COPY:${invoice}` }],
      [{ text: "🔄 Cek Status", callback_data: `CHECK:${invoice}` }],
      [{ text: "Batalkan Pembelian", callback_data: `CANCEL:${invoice}` }],
      [{ text: "👨‍💻 Bantuan", callback_data: `HELP` }]
    ]
  };

  // Kirim QR langsung (tanpa web)
  if (qrUrl) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: qrUrl,
      caption,
      parse_mode: "Markdown",
      reply_markup: markup
    });
  } else {
    // fallback kalau API tidak kasih qr url image
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        caption +
        `\n\n⚠️ QR belum tersedia. Klik *Cek Status* beberapa saat lagi.`,
      parse_mode: "Markdown",
      reply_markup: markup
    });
  }

  // notify admin
  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `🆕 Order baru\n` +
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

  const product = await findProductById(tx.product_id);

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

  if (Number(product.price) !== Number(amount)) {
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Amount mismatch\nInvoice: ${invoice}\nPrice: ${product.price}\nWebhook: ${amount}`
    });
    return;
  }

  // Kurangi stok jika numeric
  if (product.stock !== "UNLIMITED") {
    const current = Number(product.stock || 0);
    if (current > 0) {
      await updateCell(product.tabName, `E${product.rowIndex}`, String(current - 1));
    }
  }

  tx.status = "SUCCESS";
  await setTxStatus(tx.rowIndex, "SUCCESS");
  await copyTxTo(TAB_SUCCESS, tx);

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

  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `✅ Transaksi berhasil\n` +
      `Produk: ${product.name}\n` +
      `Invoice: ${invoice}\n` +
      `Pembeli: ${tx.buyer}\n` +
      `Total: ${rupiah(product.price)}`
  });
}

/**
 * =========================
 * ADMIN PANEL + COMMANDS
 * =========================
 */
async function sendAdminPanel(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "🛠 *Panel Admin GOMS APK*\nPilih menu:",
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [
        [{ text: "💰 Kelola Harga", callback_data: "AD:PRICE" }],
        [{ text: "📦 Kelola Stock", callback_data: "AD:STOCK" }],
        [{ text: "📣 Broadcast", callback_data: "AD:BROADCAST" }],
        [{ text: "🧾 Riwayat Transaksi", callback_data: "AD:TXHIST" }],
        [{ text: "📊 Dashboard", callback_data: "AD:DASH" }],
        [{ text: "🗂 Data Category", callback_data: "AD:CATS" }]
      ]
    }
  });
}

async function adminShowCategories(chatId) {
  let text = `🗂 Data Category:\n\n`;
  for (const c of CATEGORIES) text += `• ${c}\n`;
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
    text += `• ${r[5]} | ${r[3]} | ${r[7]}\n`;
  }
  await tg("sendMessage", { chat_id: chatId, text });
}

async function adminDashboard(chatId) {
  const ok = await readRange(`${TAB_SUCCESS}!A:H`);
  const fail = await readRange(`${TAB_FAIL}!A:H`);
  const totalOk = Math.max(0, ok.length - 1);
  const totalFail = Math.max(0, fail.length - 1);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `📊 Dashboard\n\n✅ Berhasil: ${totalOk}\n❌ Gagal/CANCEL: ${totalFail}`
  });
}

async function adminAskBroadcast(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "📣 Broadcast\nKetik:\n/broadcast pesan kamu"
  });
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

/**
 * /addcategory NAME
 * NOTE: ini hanya update list runtime, untuk permanen kamu ubah ENV CATEGORY_TABS
 */
async function adminAddCategory(chatId, name) {
  if (!name) {
    await tg("sendMessage", { chat_id: chatId, text: "Format: /addcategory NAMA" });
    return;
  }
  if (!CATEGORIES.includes(name)) CATEGORIES.push(name);
  await tg("sendMessage", {
    chat_id: chatId,
    text: `✅ Kategori ditambahkan: ${name}\n\nCatatan: untuk permanen, tambahkan juga ke ENV CATEGORY_TABS`
  });
}

/**
 * /addproduct CATEGORY|ID|NAMA|LINK|HARGA|STOCK|DESK
 */
async function adminAddProductCmd(chatId, raw) {
  const parts = raw.split("|").map((s) => s.trim());
  const [cat, id, name, link, price, stock, desc] = parts;
  if (!cat || !id || !name || !link || !price) {
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        "Format:\n/addproduct CATEGORY|ID|NAMA|LINK|HARGA|STOCK|DESK\nContoh:\n/addproduct APK NONTON|1|APK DRAKOR ID|https://...|15000|UNLIMITED|Deskripsi..."
    });
    return;
  }
  await appendRow(cat, [id, name, link, desc || "", stock || "0", String(price)]);
  await tg("sendMessage", { chat_id: chatId, text: "✅ Produk ditambahkan." });
}

/**
 * /addstock CATEGORY|ID|JUMLAH
 * /delstock CATEGORY|ID|JUMLAH
 */
async function adminChangeStockCmd(chatId, raw, delta) {
  const parts = raw.split("|").map((s) => s.trim());
  const [cat, id, qtyStr] = parts;
  const qty = Number(qtyStr || 0);

  if (!cat || !id || !Number.isFinite(qty) || qty <= 0) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `Format:\n/${delta > 0 ? "addstock" : "delstock"} CATEGORY|ID|JUMLAH\nContoh:\n/${delta > 0 ? "addstock" : "delstock"} APK NONTON|1|5`
    });
    return;
  }

  const products = await getProducts(cat);
  const p = products.find((x) => String(x.id) === String(id));
  if (!p) {
    await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
    return;
  }

  if (p.stock === "UNLIMITED") {
    await tg("sendMessage", { chat_id: chatId, text: "Stock UNLIMITED, tidak perlu diubah." });
    return;
  }

  const next = Math.max(0, Number(p.stock || 0) + delta * qty);
  await updateCell(cat, `E${p.rowIndex}`, String(next));
  await tg("sendMessage", { chat_id: chatId, text: `✅ Stock ${p.name} sekarang: ${next}` });
}

/**
 * =========================
 * ROUTES
 * =========================
 */
app.get("/", (req, res) => res.status(200).send("OK"));

/**
 * Telegram Webhook
 */
app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    // callback query
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const data = cq.data || "";
      const username = cq.from?.username || "";

      await tg("answerCallbackQuery", { callback_query_id: cq.id });

      if (data === "BACK:CATS") await sendCategories(chatId);
      else if (data.startsWith("CAT:")) await sendCategoryProducts(chatId, data.slice(4));
      else if (data.startsWith("PROD:")) await sendProductDetail(chatId, data.slice(5));
      else if (data.startsWith("BUY:")) await startCheckout(chatId, username, data.slice(4));
      else if (data.startsWith("COPY:")) {
        const inv = data.slice(5);
        await tg("sendMessage", { chat_id: chatId, text: `ID Transaksi:\n\`${inv}\``, parse_mode: "Markdown" });
      } else if (data.startsWith("CHECK:")) await checkStatus(chatId, data.slice(6));
      else if (data.startsWith("CANCEL:")) await cancelInvoice(chatId, data.slice(7));
      else if (data === "HELP") {
        await tg("sendMessage", { chat_id: chatId, text: helpText(), parse_mode: "Markdown", reply_markup: mainMenuKeyboard(isAdmin(chatId)) });
      }

      // admin callbacks
      if (isAdmin(chatId)) {
        if (data === "AD:BROADCAST") await adminAskBroadcast(chatId);
        if (data === "AD:TXHIST") await adminTxHistory(chatId);
        if (data === "AD:DASH") await adminDashboard(chatId);
        if (data === "AD:CATS") await adminShowCategories(chatId);
        // PRICE / STOCK menu bisa dikembangkan lagi kalau kamu mau versi klik-klik
      }

      return res.sendStatus(200);
    }

    // message
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = String(update.message.text || "").trim();
      const username = update.message.from?.username || "";
      const admin = isAdmin(chatId);

      // /start
      if (text === "/start") {
        await ensureMember(chatId);
        await tg("sendMessage", {
          chat_id: chatId,
          text: welcomeText(),
          parse_mode: "Markdown",
          reply_markup: mainMenuKeyboard(admin)
        });
        return res.sendStatus(200);
      }

      // menu buttons
      if (text === "🗂 Kategori") {
        await sendCategories(chatId);
        return res.sendStatus(200);
      }

      if (text === "🧾 Cek Pesanan") {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "Ketik:\n/cek TX....\nContoh:\n/cek TX123456...."
        });
        return res.sendStatus(200);
      }

      if (text === "📌 Cara Order") {
        await tg("sendMessage", { chat_id: chatId, text: howToText(), parse_mode: "Markdown", reply_markup: mainMenuKeyboard(admin) });
        return res.sendStatus(200);
      }

      if (text === "👨‍💻 Bantuan") {
        await tg("sendMessage", { chat_id: chatId, text: helpText(), parse_mode: "Markdown", reply_markup: mainMenuKeyboard(admin) });
        return res.sendStatus(200);
      }

      if (text === "🏓 Ping" || text === "/ping") {
        await tg("sendMessage", { chat_id: chatId, text: "✅ Bot aktif." });
        return res.sendStatus(200);
      }

      // /cek invoice
      if (text.toLowerCase().startsWith("/cek")) {
        const inv = text.replace(/\/cek/i, "").trim();
        if (!inv) {
          await tg("sendMessage", { chat_id: chatId, text: "Format: /cek TX..." });
        } else {
          await checkStatus(chatId, inv);
        }
        return res.sendStatus(200);
      }

      // admin panel
      if (admin && (text === "🛠 Panel Admin" || text === "/admin")) {
        await sendAdminPanel(chatId);
        return res.sendStatus(200);
      }

      // admin /broadcast
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

      // admin /addcategory
      if (admin && text.startsWith("/addcategory")) {
        const name = text.replace("/addcategory", "").trim();
        await adminAddCategory(chatId, name);
        return res.sendStatus(200);
      }

      // admin /addproduct
      if (admin && text.startsWith("/addproduct")) {
        const raw = text.replace("/addproduct", "").trim();
        await adminAddProductCmd(chatId, raw);
        return res.sendStatus(200);
      }

      // admin /addstock
      if (admin && text.startsWith("/addstock")) {
        const raw = text.replace("/addstock", "").trim();
        await adminChangeStockCmd(chatId, raw, +1);
        return res.sendStatus(200);
      }

      // admin /delstock
      if (admin && text.startsWith("/delstock")) {
        const raw = text.replace("/delstock", "").trim();
        await adminChangeStockCmd(chatId, raw, -1);
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
 * Payment webhook (JANGAN sebut nama gateway)
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
 * Start server
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
