import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import crypto from "crypto";

const app = express();
app.use(express.json());

/* ================= ENV ================= */
const REQUIRED_ENVS = [
  "BOT_TOKEN",
  "ADMIN_CHAT_ID",
  "SHEET_ID",
  "WEBHOOK_SECRET",
  "PAYMENT_PROJECT_SLUG",
  "PAYMENT_API_KEY",
];

const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!SA_JSON) {
  console.error("Missing ENV: GOOGLE_SERVICE_ACCOUNT_JSON");
  process.exit(1);
}

for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error("Missing ENV:", k);
    process.exit(1);
  }
}

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID);
const SHEET_ID = process.env.SHEET_ID;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const PAYMENT_PROJECT_SLUG = process.env.PAYMENT_PROJECT_SLUG;
const PAYMENT_API_KEY = process.env.PAYMENT_API_KEY;

const PAYMENT_PROJECT_SLUG = process.env.PAYMENT_PROJECT_SLUG;
const PAYMENT_API_KEY = process.env.PAYMENT_API_KEY;

const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!SA_JSON) {
  console.error("Missing ENV: GOOGLE_SERVICE_ACCOUNT_JSON");
  process.exit(1);
}

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

async function tgSafeSendMessage(chatId, text, extra) {
  try {
    const payload = Object.assign({ chat_id: chatId, text: text }, extra || {});
    return await tg("sendMessage", payload);
  } catch (e) {
    console.log("TG sendMessage error:", e && e.message ? e.message : e);
  }
}

async function tgSafeSendPhoto(chatId, photo, caption, extra) {
  try {
    const payload = Object.assign({ chat_id: chatId, photo: photo, caption: caption }, extra || {});
    return await tg("sendPhoto", payload);
  } catch (e) {
    console.log("TG sendPhoto error:", e && e.message ? e.message : e);
  }
}

async function tgAnswerCallback(cbId, text, showAlert) {
  try {
    return await tg("answerCallbackQuery", {
      callback_query_id: cbId,
      text: text || "",
      show_alert: !!showAlert,
    });
  } catch (e) {}
}

/* ================= GOOGLE ================= */
const sa = JSON.parse(SA_JSON);

const auth = new google.auth.JWT(
  sa.client_email,
  null,
  sa.private_key,
  ["https://www.googleapis.com/auth/spreadsheets"]
);

const sheets = google.sheets({ version: "v4", auth });

// Quote helper: turn "TAB!A:B" into "'TAB'!A:B" to support spaces safely
function qSheet(range) {
  if (String(range || "").startsWith("'")) return range;
  const idx = String(range || "").indexOf("!");
  if (idx === -1) return range;
  const tab = String(range).slice(0, idx);
  const rest = String(range).slice(idx);
  return "'" + tab + "'" + rest;
}

async function read(range) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: qSheet(range),
  });
  return (r.data && r.data.values) ? r.data.values : [];
}

async function append(range, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: qSheet(range),
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

async function updateCell(range, value) {
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

function rupiah(n) {
  const num = Number(n || 0);
  return "Rp " + num.toLocaleString("id-ID");
}

function displayUser(username, chatId) {
  const u = username ? ("@" + username) : "-";
  return u + " | " + String(chatId);
}

function parseChatIdFromDisplay(display) {
  const parts = String(display || "").split("|").map(function (s) { return String(s).trim(); }).filter(Boolean);
  if (!parts.length) return null;
  const maybe = parts[parts.length - 1];
  const n = Number(maybe);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

function normalizeStatus(s) {
  return String(s || "").trim().toUpperCase();
}

/* ================= REPLY KEYBOARD MENU ================= */
function mainMenuKeyboard(isAdmin) {
  const base = [
    [{ text: "🗂️ Kategori" }, { text: "🧾 Cek Pesanan" }],
    [{ text: "📌 Cara Order" }, { text: "🆘 Bantuan" }],
    [{ text: "📍 Ping" }],
  ];
  if (isAdmin) base.push([{ text: "🛠️ Panel Admin" }]);
  return { keyboard: base, resize_keyboard: true, one_time_keyboard: false };
}

/* ================= ANTI SPAM + AUTO BAN ================= */
// Tidak nulis ke sheet terus2an. Hanya nulis saat benar2 ban.
const spamState = new Map();
// config
const SPAM_WINDOW_MS = 8000;    // 8 detik
const SPAM_MAX_MSG = 10;        // max 10 event per window
const SPAM_STRIKES_TO_BAN = 3;  // 3x pelanggaran -> ban

function spamKey(chatId) {
  return String(chatId);
}

function recordSpam(chatId) {
  const key = spamKey(chatId);
  const now = Date.now();

  let st = spamState.get(key);
  if (!st) st = { ts: [], strikes: 0, bannedAt: 0, lastWarnAt: 0 };
  // cleanup old
  st.ts = st.ts.filter(function (t) { return now - t <= SPAM_WINDOW_MS; });
  st.ts.push(now);

  // check
  const tooMany = st.ts.length > SPAM_MAX_MSG;
  if (tooMany) {
    st.strikes += 1;
    st.ts = []; // reset window after strike
  }
  spamState.set(key, st);
  return { tooMany: tooMany, strikes: st.strikes };
}

async function maybeAutoBan(chatId, reason) {
  const key = spamKey(chatId);
  const st = spamState.get(key);
  if (!st) return false;
  if (st.strikes >= SPAM_STRIKES_TO_BAN) {
    // already banned in memory?
    if (st.bannedAt && Date.now() - st.bannedAt < 24 * 3600 * 1000) return true;
    st.bannedAt = Date.now();
    spamState.set(key, st);

    // write to sheet once
    await banUser(chatId, reason || "AUTO BAN: SPAM");
    await tgSafeSendMessage(chatId, "❌ Kamu diblokir otomatis karena spam. Hubungi admin jika salah.", {});
    await tgSafeSendMessage(ADMIN_CHAT_ID, "⚠️ AUTO BAN\nChatID: " + chatId + "\nReason: " + (reason || "SPAM"), {});
    return true;
  }
  return false;
}

/* ================= MEMBER SYSTEM ================= */
async function addMember(chatId, username) {
  const rows = await read(TAB_MEMBER + "!A:C");
  // Kolom C berisi username/id
  const exists = rows.some(function (r) {
    return String(r && r[2] ? r[2] : "").indexOf(String(chatId)) !== -1;
  });
  if (exists) return;

  const nomor = rows.length; // simpel
  await append(TAB_MEMBER + "!A:C", [
    nomor,
    nowISO(),
    username ? ("@" + username) : String(chatId),
  ]);
}

async function isBanned(chatId) {
  const rows = await read(TAB_BANNED + "!A:C");
  return rows.some(function (r) { return String(r && r[0]) === String(chatId); });
}

async function banUser(chatId, reason) {
  await append(TAB_BANNED + "!A:C", [
    String(chatId),
    reason || "No reason",
    nowISO(),
  ]);
}

async function unbanUser(chatId) {
  const rows = await read(TAB_BANNED + "!A:C");
  let index = -1;
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === String(chatId)) { index = i; break; }
  }
  if (index >= 0) {
    // clear that row (A:C)
    await clearRow(TAB_BANNED, index + 1, "C");
  }
}

/* ================= CATEGORY + PRODUCT ================= */
async function getCategories() {
  const rows = await read(TAB_CATEGORY + "!A:A");
  // Tidak pakai header. Semua baris non-kosong dianggap kategori.
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i] && rows[i][0] ? String(rows[i][0]).trim() : "";
    if (v) out.push(v);
  }
  return out;
}

async function getProducts(category) {
  const rows = await read(category + "!A:F");
  // rows[0] header
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const id = r[0];
    const name = r[1];
    const link = r[2];
    const desc = r[3];
    const stock = r[4];
    const price = r[5];
    if (!id || !name) continue;
    out.push({
      id: String(id).trim(),
      name: String(name || "").trim(),
      link: String(link || "").trim(),
      desc: String(desc || "").trim(),
      stock: String(stock || "").trim(),
      price: String(price || "").trim(),
      rowIndex: i + 1, // real row in sheet
      tab: category,
    });
  }
  return out;
}

function isOutOfStock(stockVal) {
  const s = String(stockVal || "").trim().toUpperCase();
  if (!s) return false;
  if (s === "UNLIMITED") return false;
  const n = Number(s);
  if (!Number.isFinite(n)) return false;
  return n <= 0;
}

/* ================= PAYMENT (PAKASIR) ================= */
async function getPaymentDetail(amount, invoice) {
  const url =
    "https://app.pakasir.com/api/transactiondetail" +
    "?project=" + encodeURIComponent(PAYMENT_PROJECT_SLUG) +
    "&amount=" + encodeURIComponent(String(amount)) +
    "&order_id=" + encodeURIComponent(String(invoice)) +
    "&api_key=" + encodeURIComponent(PAYMENT_API_KEY);

  const res = await fetch(url);
  return res.json();
}

function extractQRUrl(pay) {
  if (!pay) return null;
  if (pay.transaction && pay.transaction.qr_url) return pay.transaction.qr_url;
  if (pay.transaction && pay.transaction.qris_url) return pay.transaction.qris_url;
  if (pay.qr_url) return pay.qr_url;
  if (pay.qris_url) return pay.qris_url;
  return null;
}

function extractStatus(pay) {
  const s =
    (pay && pay.transaction && pay.transaction.status) ? pay.transaction.status :
    (pay && pay.status) ? pay.status :
    "";
  return normalizeStatus(s);
}

/* ================= TRANSAKSI ================= */
// Format TRANSAKSI sheet (A..G):
// A TANGGAL | B ID PRODUK | C NAMA PRODUK | D USERNAME/ID PEMBELI | E INVOICE | F HARGA | G STATUS

async function createTransaction(product, chatId, username) {
  const invoice = "INV-" + Date.now() + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();

  await append(TAB_TX + "!A:G", [
    nowISO(),
    product.id,
    product.name,
    displayUser(username, chatId),
    invoice,
    String(product.price || "0"),
    "PENDING",
  ]);

  return invoice;
}

async function findTransaction(invoice) {
  const rows = await read(TAB_TX + "!A:G");
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    if (String(r[4]) === String(invoice)) {
      return { rowIndex: i + 1, data: r };
    }
  }
  return null;
}

async function markSuccess(rowIndex, rowData) {
  // update status in place first (G)
  await updateCell(TAB_TX + "!G" + rowIndex, "SUCCESS");
  // append to success log
  await append(TAB_TX_SUCCESS + "!A:G", rowData);
  // clear from active transaksi
  await clearRow(TAB_TX, rowIndex, "G");
}

async function markFailed(rowIndex, rowData, statusText) {
  await updateCell(TAB_TX + "!G" + rowIndex, statusText || "FAILED");
  await append(TAB_TX_FAIL + "!A:G", rowData);
  await clearRow(TAB_TX, rowIndex, "G");
}

/* ================= QRIS SEND ================= */
async function sendQRIS(chatId, product, invoice) {
  const pay = await getPaymentDetail(product.price, invoice);
  const qr = extractQRUrl(pay);

  if (!qr) {
    await tgSafeSendMessage(chatId, "⚠️ QRIS belum tersedia. Coba klik Cek Status beberapa saat lagi.", {});
    return;
  }

  const caption =
    "🧾 Invoice: " + invoice + "\n" +
    "📦 Produk: " + product.name + "\n" +
    "💰 Total: " + rupiah(product.price) + "\n\n" +
    "Silakan scan QRIS di atas.\n" +
    "Setelah bayar, klik tombol Cek Status.";

  await tgSafeSendPhoto(chatId, qr, caption, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Cek Status", callback_data: "CEK_" + invoice }],
      ],
    },
  });
}

/* ================= DELIVER ================= */
async function checkAndDeliver(chatId, invoice) {
  const tx = await findTransaction(invoice);
  if (!tx) {
    await tgSafeSendMessage(chatId, "Invoice tidak ditemukan di TRANSAKSI.", {});
    return;
  }

  const row = tx.data;
  const statusNow = normalizeStatus(row[6]);

  if (statusNow === "SUCCESS") {
    await tgSafeSendMessage(chatId, "Transaksi ini sudah SUCCESS sebelumnya.", {});
    return;
  }

  const amount = row[5];
  const detail = await getPaymentDetail(amount, invoice);
  const st = extractStatus(detail);

  if (st === "COMPLETED" || st === "PAID" || st === "SUCCESS") {
    // cari produk berdasarkan ID (B)
    const productId = String(row[1] || "").trim();
    const categories = await getCategories();

    let product = null;
    for (let i = 0; i < categories.length; i++) {
      const cat = categories[i];
      const prods = await getProducts(cat);
      for (let j = 0; j < prods.length; j++) {
        if (String(prods[j].id) === productId) { product = prods[j]; break; }
      }
      if (product) break;
    }

    if (!product) {
      await tgSafeSendMessage(ADMIN_CHAT_ID, "⚠️ Produk tidak ditemukan untuk invoice " + invoice + " (ID=" + productId + ")", {});
      await tgSafeSendMessage(chatId, "✅ Pembayaran terdeteksi, tapi produk tidak ditemukan. Admin sudah diberi tahu.", {});
      return;
    }

    // Cek stok
    if (isOutOfStock(product.stock)) {
      await tgSafeSendMessage(ADMIN_CHAT_ID, "⚠️ STOK HABIS: " + product.name + " | invoice " + invoice, {});
      await tgSafeSendMessage(chatId, "✅ Pembayaran berhasil, tapi stok produk habis. Admin akan proses manual.", {});
      return;
    }

    // Kurangi stok jika bukan UNLIMITED
    const s = String(product.stock || "").trim().toUpperCase();
    if (s && s !== "UNLIMITED") {
      const n = Number(s);
      if (Number.isFinite(n) && n > 0) {
        await updateCell(product.tab + "!E" + product.rowIndex, String(n - 1));
      }
    }

    // Mark success (pindah ke sheet sukses + hapus dari transaksi)
    await markSuccess(tx.rowIndex, row);

    // kirim produk
    const buyerChatId = parseChatIdFromDisplay(row[3]) || String(chatId);
    const msg =
      "✅ Pembayaran Berhasil!\n\n" +
      "📦 " + product.name + "\n\n" +
      (product.desc ? ("📝 " + product.desc + "\n\n") : "") +
      "🔗 Link Download:\n" + (product.link || "-");

    await tgSafeSendMessage(buyerChatId, msg, { reply_markup: mainMenuKeyboard(String(buyerChatId) === ADMIN_CHAT_ID) });
    return;
  }

  if (st === "EXPIRED" || st === "FAILED" || st === "CANCELLED") {
    await markFailed(tx.rowIndex, row, st || "FAILED");
    await tgSafeSendMessage(chatId, "❌ Transaksi " + (st || "GAGAL/EXPIRED") + ".", {});
    return;
  }

  await tgSafeSendMessage(chatId, "Status: " + (st || "MENUNGGU PEMBAYARAN"), {});
}

/* ================= UI: KATEGORI & PRODUK ================= */
async function sendCategoryList(chatId) {
  const cats = await getCategories();
  if (!cats.length) {
    await tgSafeSendMessage(chatId, "Kategori kosong. Cek sheet CATEGORIES kolom A.", {});
    return;
  }

  const buttons = [];
  for (let i = 0; i < cats.length; i++) {
    buttons.push([{ text: cats[i], callback_data: "CAT_" + cats[i] }]);
  }

  await tgSafeSendMessage(chatId, "🗂️ Pilih kategori:", {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function sendProductList(chatId, category) {
  const prods = await getProducts(category);
  if (!prods.length) {
    await tgSafeSendMessage(chatId, "Produk kosong di kategori: " + category, {});
    return;
  }

  const buttons = [];
  for (let i = 0; i < prods.length; i++) {
    const p = prods[i];
    const priceTxt = rupiah(p.price);
    const stokTxt = (String(p.stock || "").toUpperCase() === "UNLIMITED") ? "∞" : String(p.stock || "0");
    const title = p.name + " • " + priceTxt + " • stok " + stokTxt;
    buttons.push([{ text: title, callback_data: "BUY_" + category + "_" + p.id }]);
  }

  await tgSafeSendMessage(chatId, "📦 Produk " + category + "\nPilih produk:", {
    reply_markup: { inline_keyboard: buttons },
  });
}

/* ================= CEK PESANAN (LIST PENDING USER) ================= */
async function listMyPending(chatId) {
  const rows = await read(TAB_TX + "!A:G");
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const buyer = String(r[3] || "");
    if (buyer.indexOf(String(chatId)) !== -1) {
      const st = normalizeStatus(r[6]);
      if (st === "PENDING") out.push(r);
    }
  }

  if (!out.length) {
    await tgSafeSendMessage(chatId, "Tidak ada pesanan PENDING.", {});
    return;
  }

  const buttons = [];
  for (let i = 0; i < out.length; i++) {
    const inv = String(out[i][4] || "");
    const nm = String(out[i][2] || "");
    buttons.push([{ text: "🔄 " + nm + " (" + inv + ")", callback_data: "CEK_" + inv }]);
  }

  await tgSafeSendMessage(chatId, "🧾 Pesanan PENDING kamu:\nKlik untuk cek status:", {
    reply_markup: { inline_keyboard: buttons },
  });
}

/* ================= ADMIN PANEL (BASIC) ================= */
const adminState = new Map(); // adminChatId -> { mode, data }

function isAdminChat(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID);
}

function setAdminMode(chatId, mode, data) {
  adminState.set(String(chatId), { mode: mode || "", data: data || {} });
}

function getAdminMode(chatId) {
  return adminState.get(String(chatId)) || { mode: "", data: {} };
}

async function sendAdminPanel(chatId) {
  await tgSafeSendMessage(chatId, "🛠️ Panel Admin\nPilih menu:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📊 Dashboard", callback_data: "ADMIN_DASH" }],
        [{ text: "🚫 Ban User", callback_data: "ADMIN_BAN" }, { text: "✅ Unban User", callback_data: "ADMIN_UNBAN" }],
        [{ text: "📦 Set Stock", callback_data: "ADMIN_STOCK" }, { text: "💰 Set Harga", callback_data: "ADMIN_PRICE" }],
        [{ text: "📣 Broadcast", callback_data: "ADMIN_BC" }],
      ],
    },
  });
}

async function adminDashboard(chatId) {
  const success = await read(TAB_TX_SUCCESS + "!A:G");
  const fail = await read(TAB_TX_FAIL + "!A:G");
  const sCount = Math.max(success.length, 0);
  const fCount = Math.max(fail.length, 0);

  await tgSafeSendMessage(chatId, "📊 Dashboard\n\n✅ Berhasil: " + (sCount) + "\n❌ Gagal: " + (fCount), {});
}

// format input admin: "KATEGORI | ID_PRODUK | NILAI"
function parseAdminTriple(text) {
  const parts = String(text || "").split("|").map(function (s) { return String(s).trim(); }).filter(Boolean);
  if (parts.length < 3) return null;
  return { cat: parts[0], id: parts[1], val: parts[2] };
}

async function adminSetStock(chatId, text) {
  const t = parseAdminTriple(text);
  if (!t) {
    await tgSafeSendMessage(chatId, "Format salah.\nContoh:\nAPK NONTON | 1 | 10\n(untuk UNLIMITED tulis UNLIMITED)", {});
    return;
  }
  const prods = await getProducts(t.cat);
  const p = prods.find(function (x) { return String(x.id) === String(t.id); });
  if (!p) {
    await tgSafeSendMessage(chatId, "Produk tidak ditemukan di " + t.cat + " dengan ID " + t.id, {});
    return;
  }
  await updateCell(p.tab + "!E" + p.rowIndex, String(t.val));
  await tgSafeSendMessage(chatId, "✅ Stock diupdate: " + p.name + " = " + String(t.val), {});
}

async function adminSetPrice(chatId, text) {
  const t = parseAdminTriple(text);
  if (!t) {
    await tgSafeSendMessage(chatId, "Format salah.\nContoh:\nAPK NONTON | 1 | 15000", {});
    return;
  }
  const prods = await getProducts(t.cat);
  const p = prods.find(function (x) { return String(x.id) === String(t.id); });
  if (!p) {
    await tgSafeSendMessage(chatId, "Produk tidak ditemukan di " + t.cat + " dengan ID " + t.id, {});
    return;
  }
  await updateCell(p.tab + "!F" + p.rowIndex, String(t.val));
  await tgSafeSendMessage(chatId, "✅ Harga diupdate: " + p.name + " = " + rupiah(t.val), {});
}

async function adminBan(chatId, text) {
  const id = String(text || "").trim();
  if (!id) {
    await tgSafeSendMessage(chatId, "Kirim Chat ID yang mau diban.", {});
    return;
  }
  await banUser(id, "Admin ban");
  await tgSafeSendMessage(chatId, "✅ User diban: " + id, {});
}

async function adminUnban(chatId, text) {
  const id = String(text || "").trim();
  if (!id) {
    await tgSafeSendMessage(chatId, "Kirim Chat ID yang mau di-unban.", {});
    return;
  }
  await unbanUser(id);
  await tgSafeSendMessage(chatId, "✅ User di-unban: " + id, {});
}

async function adminBroadcast(chatId, text) {
  const msg = String(text || "").trim();
  if (!msg) {
    await tgSafeSendMessage(chatId, "Kirim teks broadcast-nya.", {});
    return;
  }

  const members = await read(TAB_MEMBER + "!A:C");
  let sent = 0;
  for (let i = 0; i < members.length; i++) {
    const r = members[i] || [];
    const col = r[2] ? String(r[2]) : "";
    // jika format @username, tidak ada chatId -> skip
    // kalau angka -> gunakan
    const n = Number(col.replace("@", "").trim());
    if (!Number.isFinite(n)) continue;
    await tgSafeSendMessage(String(n), "📣 Broadcast:\n\n" + msg, {});
    sent += 1;
  }

  await tgSafeSendMessage(chatId, "✅ Broadcast dikirim ke " + sent + " member (yang punya chatId).", {});
}

/* ================= TELEGRAM WEBHOOK HANDLER ================= */
async function handleUpdate(req, res) {
  try {
    const update = req.body || {};
    const msg = update.message;
    const cb = update.callback_query;

    // ===== CALLBACKS =====
    if (cb) {
      const cbId = cb.id;
      const chatId = String(cb.message && cb.message.chat && cb.message.chat.id ? cb.message.chat.id : "");
      const data = String(cb.data || "");

      // spam check (callback counted too)
      const sp = recordSpam(chatId);
      if (sp.tooMany) {
        await tgAnswerCallback(cbId, "Terlalu cepat. Pelan-pelan ya.", false);
        await maybeAutoBan(chatId, "AUTO BAN: SPAM CALLBACK");
        return res.sendStatus(200);
      }

      if (await isBanned(chatId)) {
        await tgAnswerCallback(cbId, "Kamu diblokir.", true);
        return res.sendStatus(200);
      }

      // CATEGORY
      if (data.indexOf("CAT_") === 0) {
        const cat = data.replace("CAT_", "");
        await tgAnswerCallback(cbId, "Membuka " + cat, false);
        await sendProductList(chatId, cat);
        return res.sendStatus(200);
      }

      // BUY
      if (data.indexOf("BUY_") === 0) {
        const parts = data.split("_");
        const cat = parts[1];
        const id = parts[2];

        const prods = await getProducts(cat);
        const product = prods.find(function (p) { return String(p.id) === String(id); });

        if (!product) {
          await tgAnswerCallback(cbId, "Produk tidak ditemukan.", true);
          return res.sendStatus(200);
        }

        // check stok
        if (isOutOfStock(product.stock)) {
          await tgAnswerCallback(cbId, "Stok habis.", true);
          await tgSafeSendMessage(chatId, "❌ Stok produk habis.", {});
          return res.sendStatus(200);
        }

        const invoice = await createTransaction(product, chatId, cb.from && cb.from.username ? cb.from.username : "");
        await tgAnswerCallback(cbId, "Invoice dibuat. Mengambil QRIS...", false);
        await sendQRIS(chatId, product, invoice);
        return res.sendStatus(200);
      }

      // CEK
      if (data.indexOf("CEK_") === 0) {
        const invoice = data.replace("CEK_", "");
        await tgAnswerCallback(cbId, "Mengecek...", false);
        await checkAndDeliver(chatId, invoice);
        return res.sendStatus(200);
      }

      // ADMIN CALLBACKS
      if (data === "ADMIN_DASH" && isAdminChat(chatId)) {
        await tgAnswerCallback(cbId, "Dashboard", false);
        await adminDashboard(chatId);
        return res.sendStatus(200);
      }
      if (data === "ADMIN_BAN" && isAdminChat(chatId)) {
        setAdminMode(chatId, "BAN", {});
        await tgAnswerCallback(cbId, "Kirim Chat ID yang mau diban", true);
        await tgSafeSendMessage(chatId, "Kirim Chat ID yang mau diban (contoh: 123456789).", {});
        return res.sendStatus(200);
      }
      if (data === "ADMIN_UNBAN" && isAdminChat(chatId)) {
        setAdminMode(chatId, "UNBAN", {});
        await tgAnswerCallback(cbId, "Kirim Chat ID yang mau di-unban", true);
        await tgSafeSendMessage(chatId, "Kirim Chat ID yang mau di-unban (contoh: 123456789).", {});
        return res.sendStatus(200);
      }
      if (data === "ADMIN_STOCK" && isAdminChat(chatId)) {
        setAdminMode(chatId, "STOCK", {});
        await tgAnswerCallback(cbId, "Kirim: KATEGORI | ID | STOCK", true);
        await tgSafeSendMessage(chatId, "Format:\nKATEGORI | ID_PRODUK | STOCK\nContoh:\nAPK NONTON | 1 | 10\natau:\nAPK NONTON | 1 | UNLIMITED", {});
        return res.sendStatus(200);
      }
      if (data === "ADMIN_PRICE" && isAdminChat(chatId)) {
        setAdminMode(chatId, "PRICE", {});
        await tgAnswerCallback(cbId, "Kirim: KATEGORI | ID | HARGA", true);
        await tgSafeSendMessage(chatId, "Format:\nKATEGORI | ID_PRODUK | HARGA\nContoh:\nAPK NONTON | 1 | 15000", {});
        return res.sendStatus(200);
      }
      if (data === "ADMIN_BC" && isAdminChat(chatId)) {
        setAdminMode(chatId, "BC", {});
        await tgAnswerCallback(cbId, "Kirim teks broadcast", true);
        await tgSafeSendMessage(chatId, "Kirim teks broadcast yang mau dikirim ke member.", {});
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    // ===== MESSAGE =====
    if (!msg) return res.sendStatus(200);

    const chatId = String(msg.chat && msg.chat.id ? msg.chat.id : "");
    const text = msg.text ? String(msg.text) : "";
    const username = msg.from && msg.from.username ? msg.from.username : "";

    // anti spam
    const sp = recordSpam(chatId);
    if (sp.tooMany) {
      // warning jarang2
      const st = spamState.get(spamKey(chatId));
      const now = Date.now();
      if (st && (!st.lastWarnAt || now - st.lastWarnAt > 6000)) {
        st.lastWarnAt = now;
        spamState.set(spamKey(chatId), st);
        await tgSafeSendMessage(chatId, "⚠️ Terlalu cepat. Pelan-pelan ya.", {});
      }
      await maybeAutoBan(chatId, "AUTO BAN: SPAM MESSAGE");
      return res.sendStatus(200);
    }

    if (await isBanned(chatId)) {
      await tgSafeSendMessage(chatId, "❌ Kamu diblokir.", {});
      return res.sendStatus(200);
    }

    const admin = isAdminChat(chatId);

    // jika admin sedang mode input
    if (admin) {
      const st = getAdminMode(chatId);
      if (st.mode === "BAN") {
        setAdminMode(chatId, "", {});
        await adminBan(chatId, text);
        return res.sendStatus(200);
      }
      if (st.mode === "UNBAN") {
        setAdminMode(chatId, "", {});
        await adminUnban(chatId, text);
        return res.sendStatus(200);
      }
      if (st.mode === "STOCK") {
        setAdminMode(chatId, "", {});
        await adminSetStock(chatId, text);
        return res.sendStatus(200);
      }
      if (st.mode === "PRICE") {
        setAdminMode(chatId, "", {});
        await adminSetPrice(chatId, text);
        return res.sendStatus(200);
      }
      if (st.mode === "BC") {
        setAdminMode(chatId, "", {});
        await adminBroadcast(chatId, text);
        return res.sendStatus(200);
      }
    }

    // commands / start
    if (text === "/start") {
      await addMember(chatId, username);
      await tgSafeSendMessage(chatId, "Selamat datang 👋\nGunakan menu di bawah.", {
        reply_markup: mainMenuKeyboard(admin),
      });
      return res.sendStatus(200);
    }

    // menu buttons
    if (text === "📍 Ping") {
      await tgSafeSendMessage(chatId, "✅ Pong!", { reply_markup: mainMenuKeyboard(admin) });
      return res.sendStatus(200);
    }

    if (text === "🗂️ Kategori") {
      await sendCategoryList(chatId);
      return res.sendStatus(200);
    }

    if (text === "🧾 Cek Pesanan") {
      await listMyPending(chatId);
      return res.sendStatus(200);
    }

    if (text === "📌 Cara Order") {
      const how =
        "📌 Cara Order:\n\n" +
        "1) Klik 🗂️ Kategori\n" +
        "2) Pilih produk\n" +
        "3) Scan QRIS\n" +
        "4) Setelah bayar, klik 🔄 Cek Status\n\n" +
        "Jika sudah COMPLETED, bot kirim link otomatis.";
      await tgSafeSendMessage(chatId, how, { reply_markup: mainMenuKeyboard(admin) });
      return res.sendStatus(200);
    }

    if (text === "🆘 Bantuan") {
      const help =
        "🆘 Bantuan:\n\n" +
        "- Jika sudah bayar tapi belum dapat produk:\n" +
        "  gunakan 🧾 Cek Pesanan lalu klik Cek Status.\n\n" +
        "- Jika error, hubungi admin.";
      await tgSafeSendMessage(chatId, help, { reply_markup: mainMenuKeyboard(admin) });
      return res.sendStatus(200);
    }

    if (text === "🛠️ Panel Admin" && admin) {
      await sendAdminPanel(chatId);
      return res.sendStatus(200);
    }

    // fallback: jika user kirim invoice manual
    if (text.indexOf("INV-") === 0 || text.indexOf("TX") === 0) {
      await checkAndDeliver(chatId, text.trim());
      return res.sendStatus(200);
    }

    // default show menu
    await tgSafeSendMessage(chatId, "Pilih menu ya 🙂", { reply_markup: mainMenuKeyboard(admin) });
    return res.sendStatus(200);

  } catch (err) {
    console.log("ERROR:", err && err.message ? err.message : err);
    return res.sendStatus(200);
  }
}

/* ================= ROUTES ================= */
// Telegram webhook (secret path)
app.post("/telegram/webhook/" + WEBHOOK_SECRET, handleUpdate);

// Optional: fallback root webhook
app.post("/", handleUpdate);

// Health
app.get("/", function (req, res) { res.send("BOT RUNNING"); });

/* ================= SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log("Server started on port", PORT);
});
