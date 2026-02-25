// service.js (ESM)
// Pastikan package.json: { "type": "module" }

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
  const payload = Object.assign(
    {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    },
    extra || {}
  );
  return tg("sendMessage", payload);
}

async function tgEditMessage(chatId, messageId, text, extra = {}) {
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
  return tg("editMessageText", payload);
}

async function tgAnswerCallback(cbId, text, showAlert = false) {
  return tg("answerCallbackQuery", {
    callback_query_id: cbId,
    text: text || "",
    show_alert: !!showAlert,
  });
}

async function tgDeleteMessage(chatId, messageId) {
  return tg("deleteMessage", { chat_id: chatId, message_id: messageId });
}

async function removeReplyKeyboard(chatId) {
  // supaya tombol bawah (reply keyboard) hilang
  return tgSendMessage(chatId, "✅ Menu diperbarui.", {
    reply_markup: { remove_keyboard: true },
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

function isAdminChat(chatId) {
  return String(chatId) === String(ADMIN_CHAT_ID);
}

/* ================= ONE MAIN MESSAGE (NO STACK) ================= */
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
      // fallback kirim baru
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
    st.blockedUntil = now + 60_000; // 60 detik block
    spamState.set(chatId, st);
    return { blocked: true, strike: st.strike, reason: "spam" };
  }

  spamState.set(chatId, st);
  return { blocked: false, strike: st.strike };
}

/* ================= MEMBER / BANNED ================= */
async function addMember(chatId, username) {
  const rows = await read(`${TAB_MEMBER}!A:E`);
  const exists = rows.some((r) => String(r[2] || "") === String(chatId));
  if (exists) return;

  const nomor = rows.length; // nomor simple
  await append(`${TAB_MEMBER}!A:E`, [
    nomor,
    nowISO(),
    String(chatId),
    username ? `@${username}` : "",
    "", // E = SUB flag
  ]);
}

async function setSub(chatId, enabled) {
  const rows = await read(`${TAB_MEMBER}!A:E`);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][2] || "") === String(chatId)) {
      await updateCell(`${TAB_MEMBER}!E${i + 1}`, enabled ? "SUB" : "");
      return true;
    }
  }
  return false;
}

async function getSubChatIds() {
  const rows = await read(`${TAB_MEMBER}!A:E`);
  const ids = [];
  for (let i = 1; i < rows.length; i++) {
    const chatId = String(rows[i][2] || "").trim();
    const flag = String(rows[i][4] || "").trim().toUpperCase();
    if (/^\d+$/.test(chatId) && flag === "SUB") ids.push(chatId);
  }
  return ids;
}

async function countMembers() {
  const rows = await read(`${TAB_MEMBER}!A:E`);
  return Math.max(rows.length - 1, 0);
}

async function isBanned(chatId) {
  const rows = await read(`${TAB_BANNED}!A:C`);
  return rows.some((r) => String(r[0]) === String(chatId));
}

async function banUser(chatId, reason) {
  await append(`${TAB_BANNED}!A:C`, [String(chatId), reason || "AUTO BAN", nowISO()]);
}

/* ================= CATEGORIES / PRODUCTS ================= */
async function getCategories() {
  const rows = await read(`${TAB_CATEGORY}!A:A`);
  const cats = rows.map((r) => (r[0] || "").trim()).filter(Boolean);
  if (cats.length && cats[0].toUpperCase().includes("CATEG")) return cats.slice(1);
  return cats;
}

async function getProducts(category) {
  const rows = await read(`${category}!A:F`);
  const data = rows.slice(1); // skip header
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

async function findProductRow(category, productId) {
  const products = await getProducts(category);
  return products.find((p) => String(p.id) === String(productId)) || null;
}

async function setProductField(category, productId, colLetter, value) {
  const p = await findProductRow(category, productId);
  if (!p) throw new Error("Produk tidak ditemukan");
  await updateCell(`${p.tab}!${colLetter}${p.rowIndex}`, String(value));
  return p;
}

/* ================= TRANSAKSI (A:I) =================
A time
B category
C product_id
D product_name
E chat_id
F username
G invoice
H amount
I status
J qr_msg_id (optional, kalau sheet punya kolom J)
*/
function makeInvoice() {
  return "TX" + Date.now() + crypto.randomBytes(2).toString("hex");
}

async function createTransaction(cat, product, chatId, username) {
  const invoice = makeInvoice();
  await append(`${TAB_TX}!A:J`, [
    nowISO(),
    cat,
    product.id,
    product.name,
    String(chatId),
    username ? `@${username}` : "",
    invoice,
    String(product.price || ""),
    "PENDING",
    "", // J qr_msg_id
  ]);
  return invoice;
}

async function findTransaction(invoice) {
  const rows = await read(`${TAB_TX}!A:J`);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][6] || "") === String(invoice)) {
      return { rowIndex: i + 1, data: rows[i] };
    }
  }
  return null;
}

async function setTxStatus(rowIndex, status) {
  await updateCell(`${TAB_TX}!I${rowIndex}`, status);
}

async function setTxQrMsgId(rowIndex, msgId) {
  await updateCell(`${TAB_TX}!J${rowIndex}`, String(msgId || ""));
}

async function moveTx(rowIndex, rowData, toTab) {
  // copy
  await append(`${toTab}!A:J`, rowData);
  // clear transaksi row
  await clearRow(TAB_TX, rowIndex, "J");
}

/* ================= UI BUILDERS ================= */
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
    [{ text: "📣 Subscribe Promo", callback_data: "NAV_SUB" }],
  ];
  if (isAdmin) rows.push([{ text: "🛠 Panel Admin", callback_data: "NAV_ADMIN" }]);
  return { inline_keyboard: rows };
}

function adminMenuInline() {
  return {
    inline_keyboard: [
      [
        { text: "📁 Kategori", callback_data: "ADM_CAT_MENU" },
        { text: "📦 Produk", callback_data: "ADM_PROD_MENU" },
      ],
      [
        { text: "💰 Edit Harga", callback_data: "ADM_EDIT_PRICE" },
        { text: "📦 Edit Stock", callback_data: "ADM_EDIT_STOCK" },
      ],
      [{ text: "📣 Broadcast (subscriber)", callback_data: "ADM_BROADCAST" }],
      [{ text: "🏠 Home", callback_data: "NAV_HOME" }],
    ],
  };
}

async function buildWelcomeText(chatId) {
  const totalMember = await countMembers();
  const adminLine = ADMIN_USERNAME
    ? `\n👤 Admin: <a href="https://t.me/${ADMIN_USERNAME}">@${ADMIN_USERNAME}</a>`
    : "";
  return (
    `👋 <b>Selamat datang!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    `👥 Member: <b>${totalMember}</b>` +
    `${adminLine}\n\n` +
    `📌 Pilih menu di bawah 👇`
  );
}

/* ================= PAGES ================= */
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
    {
      text: `${p.name} — ${rupiah(p.price)} (${p.stock || "?"})`,
      callback_data: `PROD_${cat}_${p.id}_${page}`,
    },
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

async function showProductDetail(chatId, cat, productId, messageId, backPage = 1) {
  const p = await findProductRow(cat, productId);
  if (!p) {
    await tgEditMessage(chatId, messageId, "❌ Produk tidak ditemukan.", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "⬅️ Kembali", callback_data: `PROD_PAGE_${cat}_${backPage}` }],
          [{ text: "🏠 Home", callback_data: "NAV_HOME" }],
        ],
      },
    });
    return;
  }

  const text =
    `📦 <b>${escHtml(p.name)}</b>\n\n` +
    `💰 Harga: <b>${rupiah(p.price)}</b>\n` +
    `📦 Stock: <b>${escHtml(p.stock || "-")}</b>\n\n` +
    (p.desc ? `📝 ${escHtml(p.desc)}\n\n` : "") +
    (p.link ? `🔗 Link: ${escHtml(p.link)}\n\n` : "") +
    `Jika kamu ingin lanjut order, klik <b>✅ Buat Invoice</b>.`;

  await tgEditMessage(chatId, messageId, text, {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✅ Buat Invoice", callback_data: `BUY_${cat}_${p.id}` }],
        [{ text: "⬅️ Kembali", callback_data: `PROD_PAGE_${cat}_${backPage}` }],
        [{ text: "🏠 Home", callback_data: "NAV_HOME" }],
      ],
    },
  });
}

/* ================= ADMIN STATE ================= */
const adminState = new Map(); // chatId -> { action, ts }

function setAdminState(chatId, action) {
  adminState.set(String(chatId), { action, ts: Date.now() });
}
function getAdminState(chatId) {
  const st = adminState.get(String(chatId));
  if (!st) return null;
  if (Date.now() - st.ts > 10 * 60 * 1000) {
    adminState.delete(String(chatId));
    return null;
  }
  return st;
}
function clearAdminState(chatId) {
  adminState.delete(String(chatId));
}

/* ================= BROADCAST (subscriber only) ================= */
async function runBroadcast(text) {
  const ids = await getSubChatIds();
  let ok = 0;
  let fail = 0;

  for (const id of ids) {
    try {
      const r = await tgSendMessage(id, text);
      if (r?.ok) ok++;
      else fail++;
    } catch {
      fail++;
    }
    await new Promise((r) => setTimeout(r, 120)); // throttle
  }

  return { total: ids.length, ok, fail };
}

/* ================= HANDLE UPDATE ================= */
async function handleUpdate(update) {
  const msg = update.message;
  const cb = update.callback_query;

  const from = msg?.from || cb?.from;
  const chat = msg?.chat || cb?.message?.chat;

  const chatIdGlobal = chat?.id;
  const usernameGlobal = from?.username || "";
  const isAdmin = isAdminChat(chatIdGlobal);

  /* ===== CALLBACK ===== */
  if (cb) {
    const chatIdCb = cb.message?.chat?.id;
    const data = cb.data || "";
    if (!chatIdCb) return;

    const sp = checkSpam(String(chatIdCb));
    if (sp.blocked) {
      await tgAnswerCallback(cb.id, "Terlalu cepat. Tunggu sebentar ya.", false);

      if (sp.reason === "spam" && sp.strike >= SPAM_STRIKE_BAN) {
        if (!(await isBanned(chatIdCb))) {
          await banUser(chatIdCb, "AUTO BAN: SPAM (callback)");
          await tgSendMessage(chatIdCb, "❌ Kamu diblokir otomatis karena spam.");
        }
      }
      return;
    }

    if (data === "NOOP") {
      await tgAnswerCallback(cb.id, "", false);
      return;
    }

    // NAV_HOME
    if (data === "NAV_HOME") {
      await tgAnswerCallback(cb.id, "OK", false);
      const welcome = await buildWelcomeText(chatIdCb);
      await renderMain(chatIdCb, welcome, mainMenuInline(isAdminChat(chatIdCb)));
      return;
    }

    // NAV_CAT
    if (data === "NAV_CAT") {
      await tgAnswerCallback(cb.id, "OK", false);
      await showCategoriesEdit(chatIdCb, cb.message.message_id);
      return;
    }

    // NAV_CEK
    if (data === "NAV_CEK") {
      await tgAnswerCallback(cb.id, "OK", false);
      await tgEditMessage(
        chatIdCb,
        cb.message.message_id,
        `🧾 <b>Cek Pesanan</b>\n\nKirim invoice kamu (contoh: <code>TX1700000000abcd</code>)\nNanti aku cek statusnya.`,
        { reply_markup: mainMenuInline(isAdminChat(chatIdCb)) }
      );
      return;
    }

    // NAV_ORDER
    if (data === "NAV_ORDER") {
      await tgAnswerCallback(cb.id, "OK", false);
      await tgEditMessage(
        chatIdCb,
        cb.message.message_id,
        `📌 <b>CARA ORDER</b>\n` +
          `1) Klik <b>📦 Kategori</b>\n` +
          `2) Pilih produk\n` +
          `3) Klik <b>✅ Buat Invoice</b>\n` +
          `4) Ikuti instruksi pembayaran kamu (jika ada)\n\n` +
          `🧾 Kamu bisa cek invoice kapan saja.`,
        { reply_markup: mainMenuInline(isAdminChat(chatIdCb)) }
      );
      return;
    }

    // NAV_HELP
    if (data === "NAV_HELP") {
      await tgAnswerCallback(cb.id, "OK", false);
      const adminLine = ADMIN_USERNAME
        ? `Admin: <a href="https://t.me/${ADMIN_USERNAME}">@${ADMIN_USERNAME}</a>`
        : "Admin: (set ADMIN_USERNAME untuk link)";
      await tgEditMessage(
        chatIdCb,
        cb.message.message_id,
        `🆘 <b>BANTUAN</b>\n\n` +
          `Kalau ada kendala, kirim invoice kamu.\n\n` +
          `${adminLine}`,
        { reply_markup: mainMenuInline(isAdminChat(chatIdCb)) }
      );
      return;
    }

    // NAV_SUB
    if (data === "NAV_SUB") {
      await tgAnswerCallback(cb.id, "OK", false);
      await setSub(chatIdCb, true);
      await tgEditMessage(
        chatIdCb,
        cb.message.message_id,
        `✅ Kamu <b>subscribe</b> promo.\n\nUntuk berhenti: kirim <code>/unsubscribe</code>`,
        { reply_markup: mainMenuInline(isAdminChat(chatIdCb)) }
      );
      return;
    }

    // NAV_ADMIN
    if (data === "NAV_ADMIN") {
      if (!isAdminChat(chatIdCb)) {
        await tgAnswerCallback(cb.id, "Bukan admin.", true);
        return;
      }
      await tgAnswerCallback(cb.id, "OK", false);
      await tgEditMessage(chatIdCb, cb.message.message_id, "🛠 <b>Panel Admin</b>\nPilih:", {
        reply_markup: adminMenuInline(),
      });
      return;
    }

    // Admin menus
    if (data === "ADM_CAT_MENU") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(chatIdCb, "📁 <b>Kategori</b>\nPilih:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Tambah Kategori", callback_data: "ADM_ADD_CAT" }],
            [{ text: "🗑 Hapus Kategori", callback_data: "ADM_DEL_CAT" }],
            [{ text: "⬅️ Back", callback_data: "NAV_ADMIN" }],
          ],
        },
      });
      return;
    }

    if (data === "ADM_PROD_MENU") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(chatIdCb, "📦 <b>Produk</b>\nPilih:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "➕ Tambah Produk", callback_data: "ADM_ADD_PROD" }],
            [{ text: "🗑 Hapus Produk", callback_data: "ADM_DEL_PROD" }],
            [{ text: "✏️ Edit Nama", callback_data: "ADM_EDIT_NAME" }],
            [{ text: "✏️ Edit Link", callback_data: "ADM_EDIT_LINK" }],
            [{ text: "⬅️ Back", callback_data: "NAV_ADMIN" }],
          ],
        },
      });
      return;
    }

    if (data === "ADM_EDIT_PRICE") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      setAdminState(chatIdCb, "EDIT_PRICE");
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(chatIdCb, "💰 Kirim format:\n<code>KATEGORI|PRODUCT_ID|HARGA_BARU</code>");
      return;
    }

    if (data === "ADM_EDIT_STOCK") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      setAdminState(chatIdCb, "EDIT_STOCK");
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(chatIdCb, "📦 Kirim format:\n<code>KATEGORI|PRODUCT_ID|STOCK_BARU</code>");
      return;
    }

    if (data === "ADM_BROADCAST") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      setAdminState(chatIdCb, "BROADCAST");
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(chatIdCb, "📣 Broadcast ke subscriber.\nKirim pesan broadcast sekarang:");
      return;
    }

    if (data === "ADM_ADD_CAT") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      setAdminState(chatIdCb, "ADD_CAT");
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(chatIdCb, "➕ Kirim <b>nama kategori</b>.\nContoh: <code>APK NONTON</code>");
      return;
    }

    if (data === "ADM_DEL_CAT") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      setAdminState(chatIdCb, "DEL_CAT");
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(chatIdCb, "🗑 Kirim <b>nama kategori</b> yang mau dihapus.");
      return;
    }

    if (data === "ADM_ADD_PROD") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      setAdminState(chatIdCb, "ADD_PROD");
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(
        chatIdCb,
        "➕ Tambah produk, kirim format:\n" +
          "<code>KATEGORI|ID|NAMA|LINK|DESC|STOCK|HARGA</code>\n" +
          "Contoh:\n<code>APK NONTON|12|Produk A|https://...|desc|10|20000</code>"
      );
      return;
    }

    if (data === "ADM_DEL_PROD") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      setAdminState(chatIdCb, "DEL_PROD");
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(chatIdCb, "🗑 Hapus produk, kirim:\n<code>KATEGORI|PRODUCT_ID</code>");
      return;
    }

    if (data === "ADM_EDIT_NAME") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      setAdminState(chatIdCb, "EDIT_NAME");
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(chatIdCb, "✏️ Edit nama, kirim:\n<code>KATEGORI|PRODUCT_ID|NAMA_BARU</code>");
      return;
    }

    if (data === "ADM_EDIT_LINK") {
      if (!isAdminChat(chatIdCb)) return tgAnswerCallback(cb.id, "Bukan admin.", true);
      setAdminState(chatIdCb, "EDIT_LINK");
      await tgAnswerCallback(cb.id, "OK", false);
      await tgSendMessage(chatIdCb, "✏️ Edit link, kirim:\n<code>KATEGORI|PRODUCT_ID|LINK_BARU</code>");
      return;
    }

    // Category click
    if (data.startsWith("CAT_")) {
      const cat = data.replace("CAT_", "");
      await tgAnswerCallback(cb.id, "OK", false);
      await showProducts(chatIdCb, cat, cb.message.message_id, 1);
      return;
    }

    // Pagination
    if (data.startsWith("PROD_PAGE_")) {
      const parts = data.split("_"); // PROD_PAGE_{cat}_{page}
      const cat = parts[2];
      const page = Number(parts[3] || 1);
      await tgAnswerCallback(cb.id, "OK", false);
      await showProducts(chatIdCb, cat, cb.message.message_id, page);
      return;
    }

    // Back to categories
    if (data === "BACK_CAT") {
      await tgAnswerCallback(cb.id, "OK", false);
      await showCategoriesEdit(chatIdCb, cb.message.message_id);
      return;
    }

    // Product detail
    if (data.startsWith("PROD_")) {
      const parts = data.split("_"); // PROD_{cat}_{id}_{page}
      const cat = parts[1];
      const pid = parts[2];
      const backPage = Number(parts[3] || 1);
      await tgAnswerCallback(cb.id, "OK", false);
      await showProductDetail(chatIdCb, cat, pid, cb.message.message_id, backPage);
      return;
    }

    // BUY -> buat invoice (tanpa payment otomatis di sini)
    if (data.startsWith("BUY_")) {
      const parts = data.split("_");
      const cat = parts[1];
      const id = parts[2];

      const p = await findProductRow(cat, id);
      if (!p) {
        await tgAnswerCallback(cb.id, "Produk tidak ditemukan.", true);
        return;
      }

      await tgAnswerCallback(cb.id, "Membuat invoice...", false);
      const invoice = await createTransaction(cat, p, chatIdCb, cb.from?.username);

      // tampilkan invoice + tombol cek / batalkan
      const sent = await tgSendMessage(
        chatIdCb,
        `🧾 <b>Invoice dibuat</b>\n\n` +
          `Invoice: <code>${invoice}</code>\n` +
          `Produk: <b>${escHtml(p.name)}</b>\n` +
          `Total: <b>${rupiah(p.price)}</b>\n\n` +
          `📌 Lakukan pembayaran sesuai instruksi kamu.\n` +
          `Setelah bayar, klik <b>🧾 Cek Status</b>.`,
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

      // simpan message_id invoice (kalau mau dipakai delete saat success)
      const mid = sent?.result?.message_id || sent?.message_id;
      const tx = await findTransaction(invoice);
      if (tx && mid) await setTxQrMsgId(tx.rowIndex, mid);

      return;
    }

    // CEK status (placeholder)
    if (data.startsWith("CEK_")) {
      const invoice = data.replace("CEK_", "");
      await tgAnswerCallback(cb.id, "Cek status...", false);

      const tx = await findTransaction(invoice);
      if (!tx) {
        await tgSendMessage(chatIdCb, "❌ Invoice tidak ditemukan.");
        return;
      }

      const status = String(tx.data[8] || "PENDING");
      await tgSendMessage(chatIdCb, `⏳ Status invoice <code>${invoice}</code>: <b>${escHtml(status)}</b>`);
      return;
    }

    // CANCEL
    if (data.startsWith("CANCEL_")) {
  const invoice = data.replace("CANCEL_", "");
  await tgAnswerCallback(cb.id, "Membatalkan...", false);

  const tx = await findTransaction(invoice);
  if (!tx) {
    await tgAnswerCallback(cb.id, "Transaksi tidak ditemukan.", true);
    return;
  }

  const row = tx.data;

  // 1️⃣ Hapus pesan QR yang tersimpan di kolom H
  const qrMsgId = row[7]; // kolom H
  if (qrMsgId) {
    try {
      await tgDeleteMessage(chatIdCb, Number(qrMsgId));
    } catch {}
    try {
      await updateCell(`${TAB_TX}!H${tx.rowIndex}`, "");
    } catch {}
  }

  // 2️⃣ Update status jadi CANCELLED (kolom G)
  await updateCell(`${TAB_TX}!G${tx.rowIndex}`, "CANCELLED");

  // 3️⃣ Hapus pesan yang sedang diklik (invoice message)
  try {
    await tgDeleteMessage(chatIdCb, cb.message.message_id);
  } catch {}

  // 4️⃣ Balik ke menu utama biar rapi
  const welcome = await buildWelcomeText(chatIdCb);
  await renderMain(chatIdCb, welcome, mainMenuInline(isAdminChat(chatIdCb)));

  return;
    }

      // edit pesan yang diklik (biar keliatan berubah)
      await tgEditMessage(
        chatIdCb,
        cb.message.message_id,
        "❌ <b>Transaksi dibatalkan.</b>\n\nKembali ke menu:",
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

  /* ===== MESSAGE ===== */
  if (!msg) return;

  const chatIdMsg = msg.chat.id;
  const text = (msg.text || "").trim();
  const username = msg.from?.username || "";

  const sp = checkSpam(String(chatIdMsg));
  if (sp.blocked) {
    await tgSendMessage(chatIdMsg, "⚠️ Terlalu cepat. Tunggu sebentar ya.");
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

  // /start
  if (text === "/start") {
    await addMember(chatIdMsg, username);
    await removeReplyKeyboard(chatIdMsg);
    const welcome = await buildWelcomeText(chatIdMsg);
    await renderMain(chatIdMsg, welcome, mainMenuInline(isAdminChat(chatIdMsg)));
    return;
  }

  // unsubscribe
  if (text === "/unsubscribe") {
    await setSub(chatIdMsg, false);
    await tgSendMessage(chatIdMsg, "✅ Kamu sudah <b>unsubscribe</b> promo.");
    return;
  }

  // manual invoice check
  if (/^TX\d+[a-f0-9]{4}$/i.test(text)) {
    const tx = await findTransaction(text);
    if (!tx) {
      await tgSendMessage(chatIdMsg, "❌ Invoice tidak ditemukan.");
      return;
    }
    await tgSendMessage(chatIdMsg, `🧾 Status invoice <code>${escHtml(text)}</code>: <b>${escHtml(tx.data[8] || "PENDING")}</b>`);
    return;
  }

  // admin state handling
  if (isAdminChat(chatIdMsg)) {
    const st = getAdminState(chatIdMsg);
    if (st) {
      try {
        if (st.action === "ADD_CAT") {
          const name = text.trim();
          if (!name) throw new Error("Nama kategori kosong.");
          await append(`${TAB_CATEGORY}!A:A`, [name]);
          clearAdminState(chatIdMsg);
          await tgSendMessage(chatIdMsg, "✅ Kategori ditambahkan di list (pastikan sheet kategori sudah ada).");
          return;
        }

        if (st.action === "DEL_CAT") {
          const name = text.trim().toLowerCase();
          const rows = await read(`${TAB_CATEGORY}!A:A`);
          let ok = false;
          for (let i = 0; i < rows.length; i++) {
            const v = String(rows[i][0] || "").trim().toLowerCase();
            if (v && v === name) {
              await clearRow(TAB_CATEGORY, i + 1, "A");
              ok = true;
              break;
            }
          }
          clearAdminState(chatIdMsg);
          await tgSendMessage(chatIdMsg, ok ? "✅ Kategori dihapus dari list." : "❌ Kategori tidak ditemukan.");
          return;
        }

        if (st.action === "ADD_PROD") {
          const parts = text.split("|").map((s) => s.trim());
          if (parts.length !== 7) throw new Error("Format: KATEGORI|ID|NAMA|LINK|DESC|STOCK|HARGA");
          const [cat, id, name, link, desc, stock, price] = parts;
          if (!cat || !id || !name) throw new Error("Kategori/ID/Nama wajib ada.");
          await append(`${cat}!A:F`, [id, name, link, desc, stock, price]);
          clearAdminState(chatIdMsg);
          await tgSendMessage(chatIdMsg, `✅ Produk ditambahkan ke <b>${escHtml(cat)}</b>: <b>${escHtml(name)}</b>`);
          return;
        }

        if (st.action === "DEL_PROD") {
          const [cat, pid] = text.split("|").map((s) => s.trim());
          if (!cat || !pid) throw new Error("Format: KATEGORI|PRODUCT_ID");
          const p = await findProductRow(cat, pid);
          if (!p) throw new Error("Produk tidak ditemukan.");
          await clearRow(p.tab, p.rowIndex, "F");
          clearAdminState(chatIdMsg);
          await tgSendMessage(chatIdMsg, `✅ Produk dihapus: <b>${escHtml(p.name)}</b>`);
          return;
        }

        if (st.action === "EDIT_NAME") {
          const [cat, pid, name] = text.split("|").map((s) => s.trim());
          if (!cat || !pid || !name) throw new Error("Format: KATEGORI|PRODUCT_ID|NAMA_BARU");
          const p = await setProductField(cat, pid, "B", name);
          clearAdminState(chatIdMsg);
          await tgSendMessage(chatIdMsg, `✅ Nama diupdate: <b>${escHtml(p.name)}</b> → <b>${escHtml(name)}</b>`);
          return;
        }

        if (st.action === "EDIT_LINK") {
          const [cat, pid, link] = text.split("|").map((s) => s.trim());
          if (!cat || !pid || !link) throw new Error("Format: KATEGORI|PRODUCT_ID|LINK_BARU");
          const p = await setProductField(cat, pid, "C", link);
          clearAdminState(chatIdMsg);
          await tgSendMessage(chatIdMsg, `✅ Link diupdate untuk: <b>${escHtml(p.name)}</b>`);
          return;
        }

        if (st.action === "EDIT_PRICE") {
          const [cat, pid, priceStr] = text.split("|").map((s) => s.trim());
          const price = Number(priceStr);
          if (!cat || !pid || Number.isNaN(price) || price <= 0) throw new Error("Harga harus angka > 0");
          const p = await setProductField(cat, pid, "F", price);
          clearAdminState(chatIdMsg);
          await tgSendMessage(chatIdMsg, `✅ Harga diupdate: <b>${escHtml(p.name)}</b> → <b>${rupiah(price)}</b>`);
          return;
        }

        if (st.action === "EDIT_STOCK") {
          const [cat, pid, stockStr] = text.split("|").map((s) => s.trim());
          const stock = Number(stockStr);
          if (!cat || !pid || Number.isNaN(stock) || stock < 0) throw new Error("Stock harus angka >= 0");
          const p = await setProductField(cat, pid, "E", stock);
          clearAdminState(chatIdMsg);
          await tgSendMessage(chatIdMsg, `✅ Stock diupdate: <b>${escHtml(p.name)}</b> → <b>${stock}</b>`);
          return;
        }

        if (st.action === "BROADCAST") {
          clearAdminState(chatIdMsg);
          await tgSendMessage(chatIdMsg, "⏳ Mengirim broadcast ke subscriber...");
          const r = await runBroadcast(text);
          await tgSendMessage(chatIdMsg, `✅ Broadcast selesai\nTotal: <b>${r.total}</b>\nTerkirim: <b>${r.ok}</b>\nGagal: <b>${r.fail}</b>`);
          return;
        }

        clearAdminState(chatIdMsg);
      } catch (e) {
        clearAdminState(chatIdMsg);
        await tgSendMessage(chatIdMsg, "❌ " + (e?.message || String(e)));
        return;
      }
    }
  }

  await tgSendMessage(chatIdMsg, "Ketik /start untuk buka menu.");
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
