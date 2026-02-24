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

async function tgAnswerCallback(cbId, text, showAlert = false) {
  try {
    return await tg("answerCallbackQuery", {
      callback_query_id: cbId,
      text: text || "",
      show_alert: !!showAlert,
    });
  } catch (e) {}
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
  // range example: "MEMBER LIST!A:C" -> "'MEMBER LIST'!A:C"
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
    "🏠 Cari NoKos Tele 👉 <a href=\"https://t.me/gomstele24jam_bot\">@gomstele24jam_bot</a>",
    "🔥 Butuh akun UBOT? Gas 👉 <a href=\"https://t.me/gomstele24jam_bot\">Beli Disini</a>",
    "💎 Join Channel NoKos Premium 👉 <a href=\"https://t.me/gomstele24jam_bot\">Klik Masuk</a>",
    "🚀 Auto Order NoKos 24 Jam 👉 <a href=\"https://t.me/gomstele24jam_bot\">Langsung Chat</a>"
  ];

  return adsList[Math.floor(Math.random() * adsList.length)];
}

function marketingMemberFallback() {
  const base = 120; // angka minimal member palsu biar “jualan keras”
  const days = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const growth = days % 200;
  const randomBoost = Math.floor(Math.random() * 30);
  return base + growth + randomBoost;
}

function marketingSuccessFallback() {
  const base = 150; // angka minimal transaksi sukses palsu
  const days = Math.floor(Date.now() / (1000 * 60 * 60 * 24));
  const growth = days % 300;
  const randomBoost = Math.floor(Math.random() * 20);
  return base + growth + randomBoost;
}

function mainMenuKeyboard(isAdmin) {
  const base = [
    [{ text: "📦 Kategori" }, { text: "🧾 Cek Pesanan" }],
    [{ text: "📌 Cara Order" }, { text: "🆘 Bantuan" }],
    [{ text: "📍 Ping" }],
  ];
  if (isAdmin) base.push([{ text: "🛠 Panel Admin" }]);
  return { keyboard: base, resize_keyboard: true, one_time_keyboard: false };
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

    // temporary block 60s
    st.bannedUntil = now + 60_000;

    spamState.set(chatId, st);
    return { blocked: true, reason: "spam", strike: st.strike };
  }

  spamState.set(chatId, st);
  return { blocked: false };
}

/* ================= MEMBER SYSTEM ================= */
async function addMember(chatId, username) {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  const exists = rows.some((r) => String(r[2] || "") === String(username ? `@${username}` : chatId));
  if (exists) return;

  const nomor = rows.length; // simple numbering
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
  await append(`${TAB_BANNED}!A:C`, [
    String(chatId),
    reason || "No reason",
    nowISO(),
  ]);
}

async function unbanUser(chatId) {
  const rows = await read(`${TAB_BANNED}!A:C`);
  const idx = rows.findIndex((r) => String(r[0]) === String(chatId));
  if (idx >= 0) {
    // +1 row header offset
    await clearRow(TAB_BANNED, idx + 1, "C");
  }
}

/* ================= CATEGORY & PRODUCTS ================= */
// CATEGORIES: column A only (A:A). Row1 header optional.
async function getCategories() {
  const rows = await read(`${TAB_CATEGORY}!A:A`);
  const cats = rows
    .map((r) => (r[0] || "").trim())
    .filter(Boolean);

  // if first row is "CATEGORIES" or "CATEGORY" ignore it
  if (cats.length && cats[0].toUpperCase().includes("CATEG")) return cats.slice(1);
  return cats;
}

async function getProducts(category) {
  // each category tab: A:F
  const rows = await read(`${category}!A:F`);
  const data = rows.slice(1); // skip header
  return data.map((r, i) => ({
    id: String(r[0] || "").trim(),
    name: String(r[1] || "").trim(),
    link: String(r[2] || "").trim(),
    desc: String(r[3] || "").trim(),
    stock: String(r[4] || "").trim(),
    price: String(r[5] || "").trim(),
    rowIndex: i + 2,
    tab: category,
  })).filter(p => p.id && p.name);
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
  console.log("PAKASIR CREATE STATUS:", res.status);
  console.log("PAKASIR CREATE BODY:", text);

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

  await append(`${TAB_TX}!A:G`, [
    nowISO(),              // A TANGGAL
    product.id,            // B ID PRODUK
    product.name,          // C NAMA
    username ? `@${username}` : String(chatId), // D USER/ID
    invoice,               // E INVOICE
    product.price,         // F HARGA
    "PENDING",             // G STATUS
  ]);

  return invoice;
}

async function findTransaction(invoice) {
  const rows = await read(`${TAB_TX}!A:G`);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][4]) === String(invoice)) {
      return { rowIndex: i + 1, data: rows[i] };
    }
  }
  return null;
}

async function markSuccess(rowIndex, rowData) {
  // update status first
  await updateCell(`${TAB_TX}!G${rowIndex}`, "SUCCESS");
  // move to success sheet
  await append(`${TAB_TX_SUCCESS}!A:G`, rowData);
  // clear from transaksi
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
    // WAJIB: buat transaksi QRIS dulu
    pay = await createPakasirQRIS(product.price, invoice);
  } catch (e) {
    console.log("PAKASIR CREATE ERROR:", e?.message || e);
    await tgSendMessage(chatId, "⚠️ QRIS gagal dibuat. Coba lagi sebentar ya.");
    return;
  }

  // Pakasir ngasih QR string di payment_number
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

  // Ubah QR string jadi gambar biar bisa dikirim Telegram
  const qrImageUrl =
    "https://api.qrserver.com/v1/create-qr-code/?size=600x600&data=" +
    encodeURIComponent(qrString);

  await tgSendPhoto(
    chatId,
    qrImageUrl,
    "🧾 <b>Invoice</b>: <code>" + invoice + "</code>\n" +
      "📦 <b>Produk</b>: " + product.name + "\n" +
      "💰 <b>Total</b>: <b>" + rupiah(product.price) + "</b>\n\n" +
      "Silakan scan QRIS di atas.\n" +
      "Setelah bayar, klik tombol <b>🔄 Cek Status</b>.",
    {
      reply_markup: {
        inline_keyboard: [[{ text: "🔄 Cek Status", callback_data: `CEK_${invoice}` }]],
      },
    }
  );
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

  const status = String(
    detail?.transaction?.status || detail?.status || ""
  ).toUpperCase();

  if (status === "COMPLETED" || status === "SUCCESS" || status === "PAID") {
    // find product by scanning categories
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
async function showCategories(chatId) {
  const categories = await getCategories();
  if (!categories.length) {
    await tgSendMessage(chatId, "⚠️ Kategori kosong. Isi dulu di sheet tab <b>CATEGORIES</b> kolom A.");
    return;
  }

  const buttons = categories.map((c) => [{ text: c, callback_data: `CAT_${c}` }]);

  await tgSendMessage(chatId, "📦 <b>Pilih Kategori:</b>", {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function showProducts(chatId, cat) {
  const products = await getProducts(cat);
  if (!products.length) {
    await tgSendMessage(chatId, `⚠️ Produk di <b>${cat}</b> masih kosong.`);
    return;
  }

  const buttons = products.map((p) => [
    {
      text: `${p.name} — ${rupiah(p.price)}`,
      callback_data: `BUY_${cat}_${p.id}`,
    },
  ]);

  await tgSendMessage(chatId, `📦 <b>Produk ${cat}</b>\nPilih salah satu:`, {
    reply_markup: { inline_keyboard: buttons },
  });
}

/* ================= UPDATE HANDLER ================= */
async function handleUpdate(update) {
  const msg = update.message;
  const cb = update.callback_query;

  // callback
  if (cb) {
    const chatId = cb.message?.chat?.id;
    const data = cb.data || "";

    if (!chatId) return;

    // anti spam callback
    const sp = checkSpam(String(chatId));
    if (sp.blocked) {
      await tgAnswerCallback(cb.id, "Terlalu cepat. Tunggu sebentar ya.", false);
      // auto ban sheet if repeated strikes
      if (sp.reason === "spam" && sp.strike >= SPAM_STRIKE_BAN) {
        if (!(await isBanned(chatId))) {
          await banUser(chatId, "AUTO BAN: SPAM (callback)");
          await tgSendMessage(chatId, "❌ Kamu diblokir otomatis karena spam.");
        }
      }
      return;
    }

    // CAT
    if (data.startsWith("CAT_")) {
      const cat = data.replace("CAT_", "");
      await tgAnswerCallback(cb.id, "Membuka produk...", false);
      await showProducts(chatId, cat);
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

    await tgAnswerCallback(cb.id, "OK", false);
    return;
  }

  // message
  if (!msg) return;

  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  const username = msg.from?.username;

  // spam guard message
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

  const isAdmin = String(chatId) === String(ADMIN_CHAT_ID);

  // /start
  if (text === "/start") {
    await addMember(chatId, username);

    let totalMember = await countMembers();

if (totalMember < 50) {
  totalMember = marketingMemberFallback();
}
    let totalSuccess = await countSuccessTx();

if (totalSuccess < 20) {
  totalSuccess = marketingSuccessFallback();
}
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
  `${testimoni}\n\n` +
"📌 <b>PILIH KATEGORI DI MENU</b> 👇\n" +
"━━━━━━━━━━━━━━━━━━━━\n" +
"📣 <b>IKLAN SPONSOR</b>\n" +
randomAds;

    await tgSendMessage(chatId, welcome, {
      reply_markup: mainMenuKeyboard(isAdmin),
    });
    return;
  }

  // menu text buttons
  if (text === "📦 Kategori") {
    await showCategories(chatId);
    return;
  }

  if (text === "📍 Ping") {
    await tgSendMessage(chatId, "✅ Pong! Bot aktif & siap jualan 🔥");
    return;
  }

  if (text === "📌 Cara Order") {
    await tgSendMessage(
      chatId,
      `📌 <b>CARA ORDER</b>\n` +
        `1) Klik <b>📦 Kategori</b>\n` +
        `2) Pilih produk\n` +
        `3) Scan QRIS & bayar\n` +
        `4) Klik <b>🔄 Cek Status</b>\n\n` +
        `✅ Setelah sukses, link otomatis dikirim.`
    );
    return;
  }

  if (text === "🆘 Bantuan") {
    await tgSendMessage(
      chatId,
      `🆘 <b>BANTUAN</b>\n\n` +
        `Kalau QRIS belum muncul, tunggu 10-30 detik lalu coba lagi.\n` +
        `Kalau sudah bayar tapi belum terkirim, klik <b>🔄 Cek Status</b>.\n\n` +
        `Admin: <code>${ADMIN_CHAT_ID}</code>`
    );
    return;
  }

  if (text === "🧾 Cek Pesanan") {
    await tgSendMessage(
      chatId,
      `🧾 <b>Cek Pesanan</b>\n` +
        `Kirim invoice kamu (contoh: <code>TX1700000000abcd</code>)\n` +
        `Nanti aku cek statusnya.`
    );
    return;
  }

  // if user sends invoice manually
  if (/^TX\d+[a-f0-9]{4}$/i.test(text)) {
    await checkAndDeliver(chatId, text);
    return;
  }

  // admin panel minimal
  if (text === "🛠 Panel Admin" && isAdmin) {
    const totalMember = await countMembers();
    const totalSuccess = await countSuccessTx();
    await tgSendMessage(
      chatId,
      `🛠 <b>PANEL ADMIN</b>\n\n` +
        `👥 Member: <b>${totalMember}</b>\n` +
        `✅ Sukses: <b>${totalSuccess}</b>\n\n` +
        `Perintah:\n` +
        `<code>/ban CHAT_ID</code>\n` +
        `<code>/unban CHAT_ID</code>\n` +
        `<code>/dashboard</code>`
    );
    return;
  }

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

  if (isAdmin && text === "/dashboard") {
    const totalMember = await countMembers();
    const totalSuccess = await countSuccessTx();
    const failRows = await read(`${TAB_TX_FAIL}!A:G`);
    const totalFail = Math.max(failRows.length - 1, 0);

    await tgSendMessage(
      chatId,
      `📊 <b>DASHBOARD</b>\n\n` +
        `👥 Member: <b>${totalMember}</b>\n` +
        `✅ Berhasil: <b>${totalSuccess}</b>\n` +
        `❌ Gagal: <b>${totalFail}</b>`
    );
    return;
  }

  // fallback
  await tgSendMessage(chatId, "Pilih menu di bawah ya 👇", {
    reply_markup: mainMenuKeyboard(isAdmin),
  });
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
