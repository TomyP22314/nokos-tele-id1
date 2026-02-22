// service.js
import express from "express";
import { google } from "googleapis";
import crypto from "crypto";
import fetch from "node-fetch";
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
  "PAKASIR_SLUG",
  "PAKASIR_API_KEY",
  "PAKASIR_WEBHOOK_SECRET"
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

const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const PAKASIR_WEBHOOK_SECRET = process.env.PAKASIR_WEBHOOK_SECRET;

// Optional
const BANNER_URL = process.env.BANNER_URL || ""; // kalau mau banner /start
const WELCOME_ANIM_FILE_ID = process.env.WELCOME_ANIM_FILE_ID || ""; // anim telegram file_id
const REQUIRE_MEMBERSHIP = String(process.env.REQUIRE_MEMBERSHIP || "0") === "1";

// Tab names (sesuai screenshot kamu)
const TAB_PRODUCTS = "APK NONTON";
const TAB_TX = "TRANSAKSI";
const TAB_TX_OK = "TRANSAKSI BERHASIL";
const TAB_TX_FAIL = "TRANSAKSI GAGAL";
const TAB_MEMBERS = "MEMBER LIST";

/**
 * =========================
 * APP
 * =========================
 */
const app = express();
app.use(express.json({ verify: (req, res, buf) => (req.rawBody = buf) }));
app.use(express.urlencoded({ extended: true }));

/**
 * =========================
 * Google Sheets
 * =========================
 */
function getGoogleAuth() {
  let sa;
  try {
    sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON bukan JSON valid. Paste isi file service account utuh.");
  }
  return new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}

const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });

async function readRange(rangeA1) {
  const resp = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: rangeA1 });
  return resp.data.values || [];
}

async function appendRow(tabName, rowValues) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [rowValues] }
  });
}

async function updateCell(tabName, a1, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tabName}!${a1}`,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] }
  });
}

/**
 * =========================
 * Telegram helpers
 * =========================
 */
async function tg(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: body instanceof FormData ? undefined : { "Content-Type": "application/json" },
    body: body instanceof FormData ? body : JSON.stringify(body)
  });
  const data = await resp.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
  return data.result;
}

function rupiah(n) {
  return "Rp " + Number(n || 0).toLocaleString("id-ID");
}

function makeInvoice(prefix = "INV") {
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  const ts = Date.now();
  return `${prefix}-${ts}-${rand}`;
}

function mainMenuKeyboard(isAdmin = false) {
  const base = [
    [{ text: "📦 Produk" }, { text: "ℹ️ Info" }, { text: "📌 Cara Order" }],
    [{ text: "🏓 Ping" }]
  ];
  if (isAdmin) base.push([{ text: "🛠 Admin Panel" }]);
  return { keyboard: base, resize_keyboard: true };
}

/**
 * =========================
 * Pakasir helpers (UI: jangan sebut pakasir di user)
 * =========================
 */
function payUrl(amount, invoice) {
  return `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_SLUG)}/${encodeURIComponent(
    amount
  )}?order_id=${encodeURIComponent(invoice)}`;
}

async function transactionDetail(amount, invoice) {
  const url =
    `https://app.pakasir.com/api/transactiondetail` +
    `?project=${encodeURIComponent(PAKASIR_SLUG)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&order_id=${encodeURIComponent(invoice)}` +
    `&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;

  const resp = await fetch(url);
  const json = await resp.json().catch(() => ({}));
  return json;
}

/**
 * =========================
 * Products (TAB: APK NONTON)
 * Header: A ID | B NAMA | C LINK | D DESK | E STOCK | F HARGA
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
  return stock > 0 ? `${stock} Ready` : "0 (Habis)";
}

async function getProducts() {
  const values = await readRange(`${TAB_PRODUCTS}!A:F`);
  if (values.length <= 1) return [];

  const rows = values.slice(1);
  const out = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const id = (r[0] || "").toString().trim();
    if (!id) continue;

    const name = (r[1] || "").toString().trim() || id;
    const link = (r[2] || "").toString().trim();
    const desc = (r[3] || "").toString().trim();
    const stock = parseStock(r[4]);
    const price = Number((r[5] || "").toString().trim() || 0);

    out.push({
      rowIndex: i + 2,
      id,
      name,
      link,
      desc,
      stock,
      price
    });
  }

  return out;
}

async function updateProductStock(rowIndex, newStock) {
  // E = stock
  await updateCell(TAB_PRODUCTS, `E${rowIndex}`, newStock);
}

async function addProduct({ id, name, link, desc, stock, price }) {
  await appendRow(TAB_PRODUCTS, [id, name, link, desc, stock, price]);
}

/**
 * =========================
 * Membership (TAB: MEMBER LIST)
 * Header: A NOMOR | B TANGGAL GABUNG | C USERNAME/ID MEMBER
 * =========================
 */
async function ensureMember(chatId, username) {
  const values = await readRange(`${TAB_MEMBERS}!A:C`);
  const key = username ? `@${username}` : String(chatId);

  if (values.length > 1) {
    const rows = values.slice(1);
    for (const r of rows) {
      if (String(r[2] || "").trim() === key) return true;
    }
  }

  const nomor = Math.max(1, (values.length || 1)); // simple numbering
  await appendRow(TAB_MEMBERS, [String(nomor), new Date().toISOString().slice(0, 10), key]);
  return true;
}

async function isMember(chatId, username) {
  const values = await readRange(`${TAB_MEMBERS}!A:C`);
  const key1 = username ? `@${username}` : "";
  const key2 = String(chatId);

  if (values.length <= 1) return false;
  for (const r of values.slice(1)) {
    const k = String(r[2] || "").trim();
    if (k && (k === key1 || k === key2)) return true;
  }
  return false;
}

async function getAllMembersKeys() {
  const values = await readRange(`${TAB_MEMBERS}!A:C`);
  if (values.length <= 1) return [];
  return values
    .slice(1)
    .map((r) => String(r[2] || "").trim())
    .filter(Boolean);
}

/**
 * =========================
 * Transactions
 * TAB: TRANSAKSI
 * Header: A TANGGAL | B ID PRODUK | C NAMA PRODUK | D USERNAME/ID PEMBELI | E INVOICE | F HARGA | G STATUS
 * =========================
 */
async function createTx({ product, chatId, username, invoice }) {
  const buyer = `${username ? "@" + username : "-"} | ${chatId}`;
  await appendRow(TAB_TX, [
    new Date().toISOString(),
    product.id,
    product.name,
    buyer,
    invoice,
    String(product.price),
    "PENDING"
  ]);
}

async function findTxByInvoice(invoice) {
  const values = await readRange(`${TAB_TX}!A:G`);
  if (values.length <= 1) return null;

  const rows = values.slice(1);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (String(r[4] || "").trim() === String(invoice).trim()) {
      const buyer = String(r[3] || "");
      const chatIdMatch = buyer.match(/\|\s*(\d+)\s*$/);
      return {
        rowIndex: i + 2,
        tanggal: r[0],
        product_id: r[1],
        product_name: r[2],
        buyer: r[3],
        invoice: r[4],
        price: Number(r[5] || 0),
        status: String(r[6] || ""),
        chat_id: chatIdMatch ? chatIdMatch[1] : ""
      };
    }
  }
  return null;
}

async function setTxStatus(rowIndex, status) {
  // G = status
  await updateCell(TAB_TX, `G${rowIndex}`, status);
}

async function copyTxTo(tabName, txRow) {
  await appendRow(tabName, [
    txRow.tanggal || new Date().toISOString(),
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
 * UI text
 * =========================
 */
function welcomeText() {
  return (
    `Selamat datang di *GOMS APK MOD* 😎\n\n` +
    `✅ Produk siap dikirim otomatis\n` +
    `💳 Pembayaran via *QR*\n\n` +
    `Pilih menu di bawah ya 👇`
  );
}

function infoText() {
  return (
    `ℹ️ *Info*\n\n` +
    `• Pembayaran via QR\n` +
    `• Setelah pembayaran sukses, link produk dikirim otomatis\n` +
    `• Kalau ada kendala, chat admin`
  );
}

function howToText() {
  return (
    `📌 *Cara Order*\n\n` +
    `1) Klik *📦 Produk*\n` +
    `2) Pilih produk yang mau dibeli\n` +
    `3) Bot kirim QR pembayaran\n` +
    `4) Setelah sukses, link dikirim otomatis`
  );
}

/**
 * =========================
 * User flow
 * =========================
 */
async function sendWelcome(chatId, isAdmin) {
  const text = welcomeText();

  if (BANNER_URL) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: BANNER_URL,
      caption: text,
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(isAdmin)
    });
    return;
  }

  if (WELCOME_ANIM_FILE_ID) {
    await tg("sendAnimation", {
      chat_id: chatId,
      animation: WELCOME_ANIM_FILE_ID,
      caption: text,
      parse_mode: "Markdown",
      reply_markup: mainMenuKeyboard(isAdmin)
    });
    return;
  }

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: mainMenuKeyboard(isAdmin)
  });
}

async function sendProducts(chatId) {
  const products = await getProducts();

  if (!products.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Belum ada produk di sheet." });
    return;
  }

  let text = `📦 *List Produk:*\n\n`;
  const buttons = [];

  for (const p of products) {
    text += `• *${p.name}* — ${rupiah(p.price)} — ${stockText(p.stock)}\n`;
    buttons.push([{ text: `Beli ${p.name}`, callback_data: `BUY:${p.id}` }]);
  }

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: buttons }
  });
}

async function sendPing(chatId) {
  const t0 = Date.now();
  await tg("sendMessage", { chat_id: chatId, text: "🏓 Pong..." });
  const ms = Date.now() - t0;
  await tg("sendMessage", { chat_id: chatId, text: `✅ Bot aktif. (${ms}ms)` });
}

/**
 * =========================
 * Checkout
 * =========================
 */
async function startCheckout(chatId, username, productId) {
  const products = await getProducts();
  const product = products.find((x) => x.id === productId);

  if (!product) {
    await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
    return;
  }

  // membership gate (optional)
  if (REQUIRE_MEMBERSHIP) {
    const ok = await isMember(chatId, username);
    if (!ok) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "❌ Khusus member. Ketik /start dulu untuk daftar."
      });
      return;
    }
  }

  // stok
  if (product.stock !== "UNLIMITED" && Number(product.stock) <= 0) {
    await tg("sendMessage", { chat_id: chatId, text: `❌ ${product.name} sedang habis.` });
    return;
  }

  const invoice = makeInvoice("INV");
  await createTx({ product, chatId, username, invoice });

  // ambil detail biar bisa cari QR image/url kalau tersedia
  const detail = await transactionDetail(product.price, invoice);
  const t = detail?.transaction || {};
  const maybeQrUrl =
    t.qr_url || t.qris_url || t.qrcode_url || t.qr_image || detail.qr_url || detail.qris_url || "";

  const pay = payUrl(product.price, invoice);

  const caption =
    `🧾 *Invoice dibuat*\n\n` +
    `• Produk: *${product.name}*\n` +
    `• Total: *${rupiah(product.price)}*\n` +
    `• Invoice: \`${invoice}\`\n\n` +
    `Silakan bayar via QR di bawah.\n` +
    `Setelah sukses, link dikirim otomatis.`;

  if (maybeQrUrl) {
    await tg("sendPhoto", {
      chat_id: chatId,
      photo: maybeQrUrl,
      caption,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "🔎 Buka QR (Web)", url: pay }],
          [{ text: "🔄 Cek Status", callback_data: `CHECK:${invoice}` }],
          [{ text: "❌ Batalkan", callback_data: `CANCEL:${invoice}` }]
        ]
      }
    });
  } else {
    // fallback kalau API tidak kasih image url
    await tg("sendMessage", {
      chat_id: chatId,
      text: caption,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 Buka QR Pembayaran", url: pay }],
          [{ text: "🔄 Cek Status", callback_data: `CHECK:${invoice}` }],
          [{ text: "❌ Batalkan", callback_data: `CANCEL:${invoice}` }]
        ]
      }
    });
  }

  // notif admin (order baru)
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
  const status = (detail?.transaction?.status || detail?.status || "unknown").toString();

  await tg("sendMessage", { chat_id: chatId, text: `Status ${invoice}: ${status}` });
}

async function cancelInvoice(chatId, invoice) {
  const tx = await findTxByInvoice(invoice);
  if (!tx) {
    await tg("sendMessage", { chat_id: chatId, text: "Invoice tidak ditemukan." });
    return;
  }

  // hanya pemilik invoice
  if (String(tx.chat_id) !== String(chatId)) {
    await tg("sendMessage", { chat_id: chatId, text: "Invoice ini bukan milik kamu." });
    return;
  }

  if (String(tx.status).toUpperCase() === "SUCCESS" || String(tx.status).toUpperCase() === "PAID") {
    await tg("sendMessage", { chat_id: chatId, text: "Invoice sudah berhasil, tidak bisa dibatalkan." });
    return;
  }

  tx.status = "CANCELLED";
  await setTxStatus(tx.rowIndex, "CANCELLED");
  await copyTxTo(TAB_TX_FAIL, tx);

  await tg("sendMessage", { chat_id: chatId, text: `✅ Invoice ${invoice} dibatalkan.` });
}

/**
 * =========================
 * Delivery after PAID
 * - stok: jika UNLIMITED -> tidak dikurangi
 * - jika angka -> dikurangi 1
 * - kirim link produk
 * =========================
 */
async function deliverPaid(invoice, amount) {
  const tx = await findTxByInvoice(invoice);
  if (!tx) {
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ PAID tapi invoice tidak ada di sheet TRANSAKSI\nInvoice: ${invoice}\nAmount: ${amount}`
    });
    return;
  }

  if (String(tx.status).toUpperCase() === "SUCCESS") return; // sudah diproses

  // ambil produk terbaru dari sheet
  const products = await getProducts();
  const product = products.find((p) => p.id === tx.product_id);

  if (!product) {
    tx.status = "SUCCESS";
    await setTxStatus(tx.rowIndex, "SUCCESS");
    await copyTxTo(TAB_TX_OK, tx);

    await tg("sendMessage", {
      chat_id: tx.chat_id,
      text: `✅ Pembayaran sukses.\nNamun produk tidak ditemukan di sheet. Hubungi admin.\nInvoice: ${invoice}`
    });

    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Produk tidak ada di sheet\nInvoice: ${invoice}\nProduk ID: ${tx.product_id}`
    });
    return;
  }

  // pastikan amount cocok
  if (Number(product.price) !== Number(amount)) {
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Amount mismatch\nInvoice: ${invoice}\nSheet price: ${product.price}\nWebhook amount: ${amount}`
    });
    return;
  }

  // kurangi stok jika bukan unlimited
  if (product.stock !== "UNLIMITED") {
    const current = Number(product.stock || 0);
    if (current <= 0) {
      await tg("sendMessage", {
        chat_id: tx.chat_id,
        text: `✅ Pembayaran sukses.\nNamun stok ${product.name} habis saat diproses. Hubungi admin.\nInvoice: ${invoice}`
      });
      await tg("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text: `⚠️ PAID tapi stok habis\nProduk: ${product.name}\nInvoice: ${invoice}`
      });
    } else {
      await updateProductStock(product.rowIndex, String(current - 1));
    }
  }

  // set sukses
  tx.status = "SUCCESS";
  await setTxStatus(tx.rowIndex, "SUCCESS");
  await copyTxTo(TAB_TX_OK, tx);

  // kirim link
  const msg =
    `✅ *Transaksi berhasil!*\n\n` +
    `📦 Produk: *${product.name}*\n` +
    `🧾 Invoice: \`${invoice}\`\n\n` +
    `🔗 Link Download:\n${product.link || "(link kosong di sheet)"}\n\n` +
    `Terima kasih 🙏`;

  await tg("sendMessage", { chat_id: tx.chat_id, text: msg, parse_mode: "Markdown" });

  // notif admin sukses
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
 * Admin Panel
 * =========================
 */
function isAdmin(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID);
}

async function sendAdminPanel(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "🛠 Admin Panel\nPilih menu:",
    reply_markup: {
      inline_keyboard: [
        [{ text: "📦 Cek Stok", callback_data: "AD:STOCK" }],
        [{ text: "✏️ Edit Stok", callback_data: "AD:EDITSTOCK" }],
        [{ text: "📣 Broadcast", callback_data: "AD:BROADCAST" }],
        [{ text: "📤 Export Transaksi CSV", callback_data: "AD:EXPORTCSV" }],
        [{ text: "👤 Cek Member", callback_data: "AD:MEMBERS" }],
        [{ text: "📊 Grafik Harian", callback_data: "AD:CHART" }]
      ]
    }
  });
}

async function adminStockList(chatId, mode = "VIEW") {
  const products = await getProducts();
  if (!products.length) {
    await tg("sendMessage", { chat_id: chatId, text: "Belum ada produk." });
    return;
  }

  let text = `📦 Stok Produk:\n\n`;
  const buttons = [];

  for (const p of products) {
    text += `• ${p.name} — ${stockText(p.stock)} — ${rupiah(p.price)}\n`;
    if (mode === "EDIT") {
      buttons.push([{ text: `Edit: ${p.name}`, callback_data: `AD:EDIT:${p.id}` }]);
    }
  }

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: mode === "EDIT" ? { inline_keyboard: buttons } : undefined
  });
}

async function adminEditStockMenu(chatId, productId) {
  const products = await getProducts();
  const p = products.find((x) => x.id === productId);
  if (!p) {
    await tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
    return;
  }

  const cur = p.stock === "UNLIMITED" ? "UNLIMITED" : String(p.stock);

  await tg("sendMessage", {
    chat_id: chatId,
    text: `✏️ Edit Stok\n\nProduk: ${p.name}\nStok sekarang: ${cur}\n\nPilih aksi:`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "+1", callback_data: `AD:STOCKADD:${p.id}:1` },
          { text: "-1", callback_data: `AD:STOCKADD:${p.id}:-1` }
        ],
        [
          { text: "Set UNLIMITED", callback_data: `AD:SET:${p.id}:UNLIMITED` },
          { text: "Set 0", callback_data: `AD:SET:${p.id}:0` }
        ],
        [{ text: "⬅️ Kembali", callback_data: "AD:EDITSTOCK" }]
      ]
    }
  });
}

async function adminApplyStockDelta(chatId, productId, delta) {
  const products = await getProducts();
  const p = products.find((x) => x.id === productId);
  if (!p) return;

  if (p.stock === "UNLIMITED") {
    await tg("sendMessage", { chat_id: chatId, text: "Stok UNLIMITED, tidak perlu +/−." });
    return;
  }

  const next = Math.max(0, Number(p.stock || 0) + Number(delta || 0));
  await updateProductStock(p.rowIndex, String(next));
  await tg("sendMessage", { chat_id: chatId, text: `✅ Stok ${p.name} sekarang: ${next}` });
}

async function adminSetStock(chatId, productId, value) {
  const products = await getProducts();
  const p = products.find((x) => x.id === productId);
  if (!p) return;

  await updateProductStock(p.rowIndex, String(value));
  await tg("sendMessage", { chat_id: chatId, text: `✅ Stok ${p.name} di-set: ${value}` });
}

async function adminMembers(chatId) {
  const keys = await getAllMembersKeys();
  await tg("sendMessage", {
    chat_id: chatId,
    text: `👤 Total member terdaftar: ${keys.length}`
  });
}

async function adminDailyChart(chatId) {
  // chart teks dari TRANSAKSI BERHASIL (kolom A tanggal ISO)
  const values = await readRange(`${TAB_TX_OK}!A:G`);
  if (values.length <= 1) {
    await tg("sendMessage", { chat_id: chatId, text: "Belum ada transaksi berhasil." });
    return;
  }

  const rows = values.slice(1);
  const map = new Map(); // yyyy-mm-dd -> count
  for (const r of rows) {
    const dt = String(r[0] || "");
    const day = dt.slice(0, 10) || "unknown";
    map.set(day, (map.get(day) || 0) + 1);
  }

  const days = Array.from(map.keys()).sort().slice(-14);
  let text = "📊 Grafik penjualan (14 hari terakhir)\n\n";
  for (const d of days) {
    const c = map.get(d) || 0;
    text += `${d}  ${"█".repeat(Math.min(20, c))} ${c}\n`;
  }

  await tg("sendMessage", { chat_id: chatId, text });
}

async function adminAskBroadcast(chatId) {
  await tg("sendMessage", {
    chat_id: chatId,
    text: "📣 Broadcast\nKetik:\n/broadcast pesan kamu"
  });
}

async function adminDoBroadcast(chatId, message) {
  const keys = await getAllMembersKeys();
  let sent = 0;

  // kita hanya bisa kirim ke chatId angka.
  // kalau member disimpan @username, itu tidak bisa dipush tanpa chat_id.
  // jadi kalau mau broadcast full, pastikan MEMBER LIST isinya chat_id (angka).
  for (const k of keys) {
    if (!/^\d+$/.test(k)) continue;
    try {
      await tg("sendMessage", { chat_id: k, text: message });
      sent++;
    } catch {}
  }

  await tg("sendMessage", { chat_id: chatId, text: `✅ Broadcast terkirim ke ${sent} user (yang tersimpan chat_id).` });
}

function toCSV(rows) {
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return rows.map((r) => r.map(esc).join(",")).join("\n");
}

async function adminExportCSV(chatId) {
  const values = await readRange(`${TAB_TX}!A:G`);
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
 * ROUTES
 * =========================
 */
app.get("/", (req, res) => res.status(200).send("OK"));

/**
 * Telegram webhook
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

      // user buttons
      if (data.startsWith("BUY:")) {
        const productId = data.split(":")[1];
        await startCheckout(chatId, username, productId);
      } else if (data.startsWith("CHECK:")) {
        const invoice = data.split(":")[1];
        await checkStatus(chatId, invoice);
      } else if (data.startsWith("CANCEL:")) {
        const invoice = data.split(":")[1];
        await cancelInvoice(chatId, invoice);
      }

      // admin buttons
      if (isAdmin(chatId)) {
        if (data === "AD:STOCK") await adminStockList(chatId, "VIEW");
        if (data === "AD:EDITSTOCK") await adminStockList(chatId, "EDIT");
        if (data.startsWith("AD:EDIT:")) await adminEditStockMenu(chatId, data.split(":")[2]);
        if (data.startsWith("AD:STOCKADD:")) {
          const [, , pid, delta] = data.split(":");
          await adminApplyStockDelta(chatId, pid, Number(delta));
        }
        if (data.startsWith("AD:SET:")) {
          const [, , pid, val] = data.split(":");
          await adminSetStock(chatId, pid, val);
        }
        if (data === "AD:MEMBERS") await adminMembers(chatId);
        if (data === "AD:CHART") await adminDailyChart(chatId);
        if (data === "AD:BROADCAST") await adminAskBroadcast(chatId);
        if (data === "AD:EXPORTCSV") await adminExportCSV(chatId);
      }

      return res.sendStatus(200);
    }

    // message
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = String(update.message.text || "").trim();
      const username = update.message.from?.username || "";
      const admin = isAdmin(chatId);

      // simpan member saat start (atau kapan pun)
      if (text === "/start") {
        await ensureMember(chatId, username);
        await sendWelcome(chatId, admin);
      } else if (text === "📦 Produk") {
        await sendProducts(chatId);
      } else if (text === "ℹ️ Info") {
        await tg("sendMessage", { chat_id: chatId, text: infoText(), parse_mode: "Markdown", reply_markup: mainMenuKeyboard(admin) });
      } else if (text === "📌 Cara Order") {
        await tg("sendMessage", { chat_id: chatId, text: howToText(), parse_mode: "Markdown", reply_markup: mainMenuKeyboard(admin) });
      } else if (text === "🏓 Ping" || text === "/ping") {
        await sendPing(chatId);
      } else if (admin && (text === "🛠 Admin Panel" || text === "/admin")) {
        await sendAdminPanel(chatId);
      } else if (admin && text.startsWith("/broadcast ")) {
        const msg = text.replace("/broadcast", "").trim();
        if (!msg) {
          await tg("sendMessage", { chat_id: chatId, text: "Contoh: /broadcast Halo semua" });
        } else {
          await adminDoBroadcast(chatId, msg);
        }
      } else if (admin && text.startsWith("/addproduct ")) {
        // format: /addproduct ID|NAMA|LINK|HARGA|STOK|DESK
        const raw = text.replace("/addproduct", "").trim();
        const parts = raw.split("|").map((s) => s.trim());
        const [id, name, link, price, stock, desc] = parts;

        if (!id || !name || !link || !price) {
          await tg("sendMessage", {
            chat_id: chatId,
            text: "Format:\n/addproduct ID|NAMA|LINK|HARGA|STOK|DESK\nContoh:\n/addproduct APKDRAKOR|APK DRAKOR ID|https://...|15000|UNLIMITED|Deskripsi..."
          });
        } else {
          await addProduct({
            id,
            name,
            link,
            desc: desc || "",
            stock: stock || "0",
            price: Number(price || 0)
          });
          await tg("sendMessage", { chat_id: chatId, text: "✅ Produk ditambahkan." });
        }
      } else {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "Pilih menu di bawah ya 🙂",
          reply_markup: mainMenuKeyboard(admin)
        });
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Telegram webhook error:", err);
    return res.sendStatus(200);
  }
});

/**
 * Pakasir webhook
 * URL di dashboard:
 * https://<domain>/pakasir/webhook/<PAKASIR_WEBHOOK_SECRET>
 */
app.post(`/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const body = req.body || {};
    const { amount, order_id } = body;

    res.status(200).json({ ok: true });

    if (!order_id || !amount) return;

    // validasi pakai transactiondetail
    const detail = await transactionDetail(amount, order_id);
    const t = detail?.transaction;
    if (!t) return;

    const finalStatus = String(t.status || "").toLowerCase();
    if (finalStatus !== "completed") return;

    await deliverPaid(order_id, amount);
  } catch (err) {
    console.error("Pakasir webhook error:", err);
  }
});

/**
 * Start server
 */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
