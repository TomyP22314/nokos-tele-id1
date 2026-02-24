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
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "SHEET_ID",
  "WEBHOOK_SECRET",
  "PAYMENT_PROJECT_SLUG",
  "PAYMENT_API_KEY",
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
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

const PAYMENT_PROJECT_SLUG = process.env.PAYMENT_PROJECT_SLUG;
const PAYMENT_API_KEY = process.env.PAYMENT_API_KEY;

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

async function tgSendMessage(chatId, text, extra) {
  const payload = Object.assign({ chat_id: chatId, text: text }, extra || {});
  return tg("sendMessage", payload);
}

async function tgSendPhoto(chatId, photo, caption, extra) {
  const payload = Object.assign({ chat_id: chatId, photo: photo, caption: caption }, extra || {});
  return tg("sendPhoto", payload);
}

async function tgAnswerCallback(cbId, text, showAlert) {
  return tg("answerCallbackQuery", {
    callback_query_id: cbId,
    text: text || "",
    show_alert: !!showAlert,
  });
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

// Quote helper: "TAB!A:B" => "'TAB'!A:B" (biar tab ada spasi aman)
function qSheet(range) {
  range = String(range || "");
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
  return (r.data && r.data.values) ? r.data.values : [];
}

async function appendRow(range, row) {
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

function getRandomTestimoni() {
  const list = [
    "⭐⭐⭐⭐⭐ Cepet banget prosesnya, baru bayar langsung dikirim!",
    "⭐⭐⭐⭐⭐ Trusted parah, udah order 3x aman semua 🔥",
    "⭐⭐⭐⭐⭐ Admin fast respon & ramah banget!",
    "⭐⭐⭐⭐⭐ Harga murah tapi kualitas premium 💎",
    "⭐⭐⭐⭐⭐ Auto kirim beneran, gak pake lama!",
    "⭐⭐⭐⭐⭐ Recommended seller, gak tipu-tipu!",
    "⭐⭐⭐⭐⭐ Udah langganan disini, aman terus!",
    "⭐⭐⭐⭐⭐ Proses cuma hitungan detik ⚡"
  ];

  return list[Math.floor(Math.random() * list.length)];
}

function displayUser(username, chatId) {
  const u = username ? ("@" + username) : "-";
  return u + " | " + String(chatId);
}

function parseChatIdFromDisplay(display) {
  const parts = String(display || "")
    .split("|")
    .map(function (s) { return String(s).trim(); })
    .filter(Boolean);
  if (!parts.length) return null;
  const maybe = parts[parts.length - 1];
  const n = Number(maybe);
  if (!Number.isFinite(n)) return null;
  return String(n);
}

function normalizeStatus(s) {
  return String(s || "").trim().toUpperCase();
}

function isOutOfStock(stockVal) {
  const s = String(stockVal || "").trim().toUpperCase();
  if (!s) return false;
  if (s === "UNLIMITED") return false;
  const n = Number(s);
  if (!Number.isFinite(n)) return false;
  return n <= 0;
}

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
const spamState = new Map();
const SPAM_WINDOW_MS = 8000;
const SPAM_MAX_MSG = 10;
const SPAM_STRIKES_TO_BAN = 3;

function recordSpam(chatId) {
  const key = String(chatId);
  const now = Date.now();

  let st = spamState.get(key);
  if (!st) st = { ts: [], strikes: 0, lastWarnAt: 0, lastBanAt: 0 };

  st.ts = st.ts.filter(function (t) { return now - t <= SPAM_WINDOW_MS; });
  st.ts.push(now);

  let tooMany = false;
  if (st.ts.length > SPAM_MAX_MSG) {
    st.strikes += 1;
    st.ts = [];
    tooMany = true;
  }

  spamState.set(key, st);
  return { tooMany: tooMany, strikes: st.strikes };
}

/* ================= MEMBER + BAN SHEET ================= */
async function addMember(chatId, username) {
  const rows = await read(TAB_MEMBER + "!A:C");
  const exists = rows.some(function (r) {
    return String(r && r[2] ? r[2] : "").indexOf(String(chatId)) !== -1;
  });
  if (exists) return;

  const nomor = rows.length;
  await appendRow(TAB_MEMBER + "!A:C", [
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
  await appendRow(TAB_BANNED + "!A:C", [
    String(chatId),
    reason || "AUTO BAN",
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
    await clearRow(TAB_BANNED, index + 1, "C");
  }
}

async function maybeAutoBan(chatId, reason) {
  const key = String(chatId);
  const st = spamState.get(key);
  if (!st) return false;
  if (st.strikes >= SPAM_STRIKES_TO_BAN) {
    const now = Date.now();
    if (st.lastBanAt && (now - st.lastBanAt < 3600 * 1000)) return true;
    st.lastBanAt = now;
    spamState.set(key, st);

    await banUser(chatId, reason || "AUTO BAN: SPAM");
    await tgSendMessage(chatId, "❌ Kamu diblokir otomatis karena spam. Hubungi admin jika salah.", {});
    await tgSendMessage(ADMIN_CHAT_ID, "⚠️ AUTO BAN\nChatID: " + chatId + "\nReason: " + (reason || "SPAM"), {});
    return true;
  }
  return false;
}

/* ================= CATEGORY + PRODUCT ================= */
// CATEGORIES harus vertikal di kolom A
async function getCategories() {
  const rows = await read(TAB_CATEGORY + "!A:A");
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const v = rows[i] && rows[i][0] ? String(rows[i][0]).trim() : "";
    if (v) out.push(v);
  }
  return out;
}

// Produk sheet: A:ID B:Nama C:Link D:Desk E:Stock F:Harga (row 1 header)
async function getProducts(category) {
  const rows = await read(category + "!A:F");
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
      rowIndex: i + 1,
      tab: category,
    });
  }
  return out;
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
// TRANSAKSI: A TGL | B ID | C NAMA | D USER | E INVOICE | F HARGA | G STATUS
async function createTransaction(product, chatId, username) {
  const invoice = "INV-" + Date.now() + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();

  await appendRow(TAB_TX + "!A:G", [
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
  await updateCell(TAB_TX + "!G" + rowIndex, "SUCCESS");
  await appendRow(TAB_TX_SUCCESS + "!A:G", rowData);
  await clearRow(TAB_TX, rowIndex, "G");
}

async function markFailed(rowIndex, rowData, statusText) {
  await updateCell(TAB_TX + "!G" + rowIndex, statusText || "FAILED");
  await appendRow(TAB_TX_FAIL + "!A:G", rowData);
  await clearRow(TAB_TX, rowIndex, "G");
}

/* ================= QRIS SEND ================= */
async function sendQRIS(chatId, product, invoice) {
  const pay = await getPaymentDetail(product.price, invoice);
  const qr = extractQRUrl(pay);

  if (!qr) {
    await tgSendMessage(chatId, "⚠️ QRIS belum tersedia. Coba klik Cek Status beberapa saat lagi.", {});
    return;
  }

  const caption =
    "🧾 Invoice: " + invoice + "\n" +
    "📦 Produk: " + product.name + "\n" +
    "💰 Total: " + rupiah(product.price) + "\n\n" +
    "Silakan scan QRIS di atas.\n" +
    "Setelah bayar, klik tombol Cek Status.";

  await tgSendPhoto(chatId, qr, caption, {
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
    await tgSendMessage(chatId, "Invoice tidak ditemukan di TRANSAKSI.", {});
    return;
  }

  const row = tx.data;
  const statusNow = normalizeStatus(row[6]);

  if (statusNow === "SUCCESS") {
    await tgSendMessage(chatId, "Transaksi ini sudah SUCCESS sebelumnya.", {});
    return;
  }

  const amount = row[5];
  const detail = await getPaymentDetail(amount, invoice);
  const st = extractStatus(detail);

  if (st === "COMPLETED" || st === "PAID" || st === "SUCCESS") {
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
      await tgSendMessage(ADMIN_CHAT_ID, "⚠️ Produk tidak ditemukan untuk invoice " + invoice + " (ID=" + productId + ")", {});
      await tgSendMessage(chatId, "✅ Pembayaran terdeteksi, tapi produk tidak ditemukan. Admin sudah diberi tahu.", {});
      return;
    }

    if (isOutOfStock(product.stock)) {
      await tgSendMessage(ADMIN_CHAT_ID, "⚠️ STOK HABIS: " + product.name + " | invoice " + invoice, {});
      await tgSendMessage(chatId, "✅ Pembayaran berhasil, tapi stok produk habis. Admin akan proses manual.", {});
      return;
    }

    const s = String(product.stock || "").trim().toUpperCase();
    if (s && s !== "UNLIMITED") {
      const n = Number(s);
      if (Number.isFinite(n) && n > 0) {
        await updateCell(product.tab + "!E" + product.rowIndex, String(n - 1));
      }
    }

    await markSuccess(tx.rowIndex, row);

    const buyerChatId = parseChatIdFromDisplay(row[3]) || String(chatId);

    let msg = "✅ Pembayaran Berhasil!\n\n";
    msg += "📦 " + product.name + "\n\n";
    if (product.desc) msg += "📝 " + product.desc + "\n\n";
    msg += "🔗 Link Download:\n" + (product.link || "-");

    await tgSendMessage(buyerChatId, msg, { reply_markup: mainMenuKeyboard(String(buyerChatId) === ADMIN_CHAT_ID) });
    return;
  }

  if (st === "EXPIRED" || st === "FAILED" || st === "CANCELLED") {
    await markFailed(tx.rowIndex, row, st || "FAILED");
    await tgSendMessage(chatId, "❌ Transaksi " + (st || "GAGAL/EXPIRED") + ".", {});
    return;
  }

  await tgSendMessage(chatId, "Status: " + (st || "MENUNGGU PEMBAYARAN"), {});
}

/* ================= UI: KATEGORI & PRODUK ================= */
async function sendCategoryList(chatId) {
  const cats = await getCategories();
  if (!cats.length) {
    await tgSendMessage(chatId, "Kategori kosong. Cek sheet CATEGORIES kolom A.", {});
    return;
  }

  const buttons = [];
  for (let i = 0; i < cats.length; i++) {
    buttons.push([{ text: cats[i], callback_data: "CAT_" + cats[i] }]);
  }

  await tgSendMessage(chatId, "🗂️ Pilih kategori:", {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function sendProductList(chatId, category) {
  const prods = await getProducts(category);
  if (!prods.length) {
    await tgSendMessage(chatId, "Produk kosong di kategori: " + category, {});
    return;
  }

  const buttons = [];
  for (let i = 0; i < prods.length; i++) {
    const p = prods[i];
    const stokTxt = (String(p.stock || "").toUpperCase() === "UNLIMITED") ? "∞" : String(p.stock || "0");
    const title = p.name + " • " + rupiah(p.price) + " • stok " + stokTxt;
    buttons.push([{ text: title, callback_data: "BUY_" + category + "_" + p.id }]);
  }

  await tgSendMessage(chatId, "📦 Produk " + category + "\nPilih produk:", {
    reply_markup: { inline_keyboard: buttons },
  });
}

/* ================= CEK PESANAN ================= */
async function listMyPending(chatId) {
  const rows = await read(TAB_TX + "!A:G");
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const buyer = String(r[3] || "");
    const st = normalizeStatus(r[6]);
    if (buyer.indexOf(String(chatId)) !== -1 && st === "PENDING") out.push(r);
  }

  if (!out.length) {
    await tgSendMessage(chatId, "Tidak ada pesanan PENDING.", {});
    return;
  }

  const buttons = [];
  for (let i = 0; i < out.length; i++) {
    const inv = String(out[i][4] || "");
    const nm = String(out[i][2] || "");
    buttons.push([{ text: "🔄 " + nm + " (" + inv + ")", callback_data: "CEK_" + inv }]);
  }

  await tgSendMessage(chatId, "🧾 Pesanan PENDING kamu:\nKlik untuk cek status:", {
    reply_markup: { inline_keyboard: buttons },
  });
}

/* ================= ADMIN BASIC ================= */
function isAdminChat(chatId) {
  return String(chatId) === ADMIN_CHAT_ID;
}

async function sendAdminPanel(chatId) {
  await tgSendMessage(chatId, "🛠️ Panel Admin (Basic)\n\nCommands:\n/ban <chatid>\n/unban <chatid>\n/dashboard", {});
}

async function adminDashboard(chatId) {
  const success = await read(TAB_TX_SUCCESS + "!A:G");
  const fail = await read(TAB_TX_FAIL + "!A:G");
  await tgSendMessage(chatId, "📊 Dashboard\n\n✅ Berhasil: " + String(Math.max(success.length - 0, 0)) + "\n❌ Gagal: " + String(Math.max(fail.length - 0, 0)), {});
}

/* ================= TELEGRAM HANDLER ================= */
async function handleUpdate(req, res) {
  try {
    const update = req.body || {};
    const msg = update.message;
    const cb = update.callback_query;

    if (cb) {
      const cbId = cb.id;
      const chatId = String(cb.message && cb.message.chat && cb.message.chat.id ? cb.message.chat.id : "");
      const data = String(cb.data || "");

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

      if (data.indexOf("CAT_") === 0) {
        const cat = data.replace("CAT_", "");
        await tgAnswerCallback(cbId, "Membuka " + cat, false);
        await sendProductList(chatId, cat);
        return res.sendStatus(200);
      }

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

        if (isOutOfStock(product.stock)) {
          await tgAnswerCallback(cbId, "Stok habis.", true);
          await tgSendMessage(chatId, "❌ Stok produk habis.", {});
          return res.sendStatus(200);
        }

        const invoice = await createTransaction(product, chatId, cb.from && cb.from.username ? cb.from.username : "");
        await tgAnswerCallback(cbId, "Invoice dibuat. Mengambil QRIS...", false);
        await sendQRIS(chatId, product, invoice);
        return res.sendStatus(200);
      }

      if (data.indexOf("CEK_") === 0) {
        const invoice = data.replace("CEK_", "");
        await tgAnswerCallback(cbId, "Mengecek...", false);
        await checkAndDeliver(chatId, invoice);
        return res.sendStatus(200);
      }

      return res.sendStatus(200);
    }

    if (!msg) return res.sendStatus(200);

    const chatId = String(msg.chat && msg.chat.id ? msg.chat.id : "");
    const text = msg.text ? String(msg.text) : "";
    const username = msg.from && msg.from.username ? msg.from.username : "";
    const admin = isAdminChat(chatId);

    const sp = recordSpam(chatId);
    if (sp.tooMany) {
      await tgSendMessage(chatId, "⚠️ Terlalu cepat. Pelan-pelan ya.", {});
      await maybeAutoBan(chatId, "AUTO BAN: SPAM MESSAGE");
      return res.sendStatus(200);
    }

    if (await isBanned(chatId)) {
      await tgSendMessage(chatId, "❌ Kamu diblokir.", {});
      return res.sendStatus(200);
    }

  if (text === "/start") {
  await addMember(chatId, username);

  const memberRows = await read(TAB_MEMBER + "!A:C");
  const successRows = await read(TAB_TX_SUCCESS + "!A:G");

  const totalMember = memberRows.length;
  const totalSuccess = successRows.length;

  const testimoni = getRandomTestimoni();

  const welcome =
    "🚨 GOMS APK MOD🚨\n\n" +
    "📲 APK KHUSUS ANDROID\n"
    "🔥 APK MOD & PREMIUM TERLENGKAP\n\n" +
    "⚡ Auto kirim • Cepat • Aman\n" +
    "📊 Statistik Kami:\n\n" +
    "👥 Member: " + totalMember + "\n" +
    "✅ Transaksi Sukses: " + totalSuccess + "\n\n" +
    "💬 Testimoni Pembeli:\n" +
    testimoni + "\n\n" +
    "👇 PILIH KATEGORI & GAS SEKARANG 👇";

  await tgSendMessage(chatId, welcome, {
    reply_markup: mainMenuKeyboard(admin),
  });

  return res.sendStatus(200);
}

    if (text === "📍 Ping") {
      await tgSendMessage(chatId, "✅ Pong!", { reply_markup: mainMenuKeyboard(admin) });
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
      await tgSendMessage(chatId, how, { reply_markup: mainMenuKeyboard(admin) });
      return res.sendStatus(200);
    }

    if (text === "🆘 Bantuan") {
      const help =
        "🆘 Bantuan:\n\n" +
        "- Jika sudah bayar tapi belum dapat produk:\n" +
        "  gunakan 🧾 Cek Pesanan lalu klik Cek Status.\n\n" +
        "- Jika error, hubungi admin.";
      await tgSendMessage(chatId, help, { reply_markup: mainMenuKeyboard(admin) });
      return res.sendStatus(200);
    }

    if (text === "🛠️ Panel Admin" && admin) {
      await sendAdminPanel(chatId);
      return res.sendStatus(200);
    }

    // Admin commands
    if (admin) {
      if (text.indexOf("/ban") === 0) {
        const id = String(text.split(" ")[1] || "").trim();
        if (id) {
          await banUser(id, "Admin ban");
          await tgSendMessage(chatId, "✅ User diban: " + id, {});
        } else {
          await tgSendMessage(chatId, "Format: /ban <chatid>", {});
        }
        return res.sendStatus(200);
      }

      if (text.indexOf("/unban") === 0) {
        const id = String(text.split(" ")[1] || "").trim();
        if (id) {
          await unbanUser(id);
          await tgSendMessage(chatId, "✅ User di-unban: " + id, {});
        } else {
          await tgSendMessage(chatId, "Format: /unban <chatid>", {});
        }
        return res.sendStatus(200);
      }

      if (text === "/dashboard") {
        await adminDashboard(chatId);
        return res.sendStatus(200);
      }
    }

    // invoice manual
    if (text.indexOf("INV-") === 0 || text.indexOf("TX") === 0) {
      await checkAndDeliver(chatId, text.trim());
      return res.sendStatus(200);
    }

    // default
    await tgSendMessage(chatId, "Pilih menu ya 🙂", { reply_markup: mainMenuKeyboard(admin) });
    return res.sendStatus(200);

  } catch (err) {
    console.log("ERROR:", err && err.message ? err.message : err);
    return res.sendStatus(200);
  }
}

/* ================= ROUTES ================= */
app.post("/telegram/webhook/" + WEBHOOK_SECRET, handleUpdate);
app.post("/", handleUpdate);
app.get("/", function (req, res) { res.send("BOT RUNNING"); });

/* ================= SERVER ================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, function () {
  console.log("Server started on port", PORT);
});
