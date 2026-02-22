import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import crypto from "crypto";

const app = express();

// Pakasir webhook biasanya JSON
app.use(express.json({ verify: (req, res, buf) => (req.rawBody = buf) }));
app.use(express.urlencoded({ extended: true }));

/** =========================
 * ENV WAJIB
 * ========================= */
const REQUIRED_ENVS = [
  "BOT_TOKEN",
  "WEBHOOK_SECRET",
  "ADMIN_CHAT_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "SHEET_ID",
  "SHEET_ORDERS_TAB",
  "PAKASIR_SLUG",
  "PAKASIR_API_KEY",
  "PAKASIR_WEBHOOK_SECRET"
];

function assertEnv() {
  const missing = REQUIRED_ENVS.filter(
    (k) => !process.env[k] || String(process.env[k]).trim() === ""
  );
  if (missing.length) throw new Error("Missing ENV: " + missing.join(", "));
}
assertEnv();

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID);

const SHEET_ID = process.env.SHEET_ID;
const SHEET_ORDERS_TAB = process.env.SHEET_ORDERS_TAB;

const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const PAKASIR_WEBHOOK_SECRET = process.env.PAKASIR_WEBHOOK_SECRET;

// optional: anim file_id dari Telegram (boleh kosong)
const WELCOME_ANIM_FILE_ID = process.env.WELCOME_ANIM_FILE_ID || "";

// kategori/tab katalog
const CATEGORY_TABS = (process.env.CATEGORY_TABS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// kalau CATEGORY_TABS kosong, bot tetap jalan, tapi menu list produk kosong
const UPDATE_CATALOG_LAST_PURCHASE =
  String(process.env.UPDATE_CATALOG_LAST_PURCHASE || "0") === "1";

/** =========================
 * Google Sheets Client
 * ========================= */
function getGoogleAuth() {
  let sa;
  try {
    sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch (e) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON bukan JSON valid. Pastikan copas lengkap isi file service account."
    );
  }

  return new google.auth.JWT({
    email: sa.client_email,
    key: sa.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
}

const sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });

async function readRange(rangeA1) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: rangeA1
  });
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

/** =========================
 * Catalog (Katalog per tab)
 * Header baris 1:
 * A NAMA APK
 * B LINK DOWNLOAD
 * C DESKRIPSI
 * D HARGA
 * E TANGGAL (opsional - last purchased)
 * F INVOICE (opsional - last purchased)
 * ========================= */

function parsePrice(v) {
  const s = String(v || "").trim();
  const n = Number(s.replace(/[^\d]/g, "")) || 0;
  return n;
}

async function listProducts(tabName) {
  const values = await readRange(`${tabName}!A:D`);
  if (values.length <= 1) return [];

  const rows = values.slice(1);
  const products = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = String(r[0] || "").trim();
    const link = String(r[1] || "").trim();
    const desc = String(r[2] || "").trim();
    const price = parsePrice(r[3]);

    if (!name || !link || price <= 0) continue;

    products.push({
      tabName,
      rowIndex: i + 2, // data mulai baris 2
      name,
      link,
      desc,
      price
    });
  }
  return products;
}

async function getProductByRow(tabName, rowIndex) {
  const values = await readRange(`${tabName}!A${rowIndex}:D${rowIndex}`);
  const r = (values && values[0]) || [];
  const name = String(r[0] || "").trim();
  const link = String(r[1] || "").trim();
  const desc = String(r[2] || "").trim();
  const price = parsePrice(r[3]);

  if (!name || !link || price <= 0) return null;

  return { tabName, rowIndex, name, link, desc, price };
}

/** =========================
 * Telegram Helpers
 * ========================= */
async function tg(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;

  // timeout sederhana pakai AbortController
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(`Telegram API error: ${JSON.stringify(data)}`);
    return data.result;
  } finally {
    clearTimeout(t);
  }
}

function mainMenuKeyboard() {
  return {
    keyboard: [[{ text: "📦 List Produk" }, { text: "ℹ️ INFORMASI" }, { text: "✨ Cara Order" }]],
    resize_keyboard: true
  };
}

function rupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function makeOrderId(prefix = "INV") {
  const rand = crypto.randomBytes(3).toString("hex").toUpperCase();
  const ts = Date.now().toString().slice(-8);
  return `${prefix}${ts}${rand}`;
}

/** =========================
 * Pakasir Helpers
 * ========================= */
function pakasirPayUrl(amount, orderId) {
  return `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_SLUG)}/${amount}?order_id=${encodeURIComponent(
    orderId
  )}`;
}

async function pakasirTransactionDetail(amount, orderId) {
  const url =
    `https://app.pakasir.com/api/transactiondetail` +
    `?project=${encodeURIComponent(PAKASIR_SLUG)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&order_id=${encodeURIComponent(orderId)}` +
    `&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, { signal: controller.signal });
    const json = await resp.json();
    return json;
  } finally {
    clearTimeout(t);
  }
}

/** =========================
 * Orders storage (Google Sheet tab Orders)
 * Columns (A..H):
 * A order_id
 * B chat_id
 * C username
 * D product_id (format: "TAB#ROW")
 * E amount
 * F status (PENDING/PAID/CANCELLED)
 * G created_at
 * H paid_at
 * ========================= */
async function createPendingOrder({ orderId, chatId, username, productId, amount }) {
  await appendRow(SHEET_ORDERS_TAB, [
    orderId,
    String(chatId),
    username || "",
    productId,
    String(amount),
    "PENDING",
    new Date().toISOString(),
    ""
  ]);
}

async function findOrder(orderId) {
  const values = await readRange(`${SHEET_ORDERS_TAB}!A:H`);
  if (values.length <= 1) return null;

  const rows = values.slice(1);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    if (String(r[0] || "").trim() === orderId) {
      return {
        rowIndex: i + 2,
        order_id: r[0],
        chat_id: r[1],
        username: r[2],
        product_id: r[3],
        amount: Number(r[4] || 0),
        status: r[5],
        created_at: r[6],
        paid_at: r[7]
      };
    }
  }
  return null;
}

async function setOrderStatus(rowIndex, status, paidAt = "") {
  // F = status, H = paid_at
  await updateCell(SHEET_ORDERS_TAB, `F${rowIndex}`, status);
  if (paidAt) await updateCell(SHEET_ORDERS_TAB, `H${rowIndex}`, paidAt);
}

/** =========================
 * Bot Logic
 * ========================= */
async function sendWelcome(chatId) {
  const text =
    `Halo, 👋\n` +
    `Selamat datang di toko produk digital.\n\n` +
    `Gunakan menu di bawah untuk melihat produk & cara order.\n`;

  if (WELCOME_ANIM_FILE_ID) {
    await tg("sendAnimation", {
      chat_id: chatId,
      animation: WELCOME_ANIM_FILE_ID,
      caption: text,
      reply_markup: mainMenuKeyboard()
    });
  } else {
    await tg("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: mainMenuKeyboard()
    });
  }
}

async function sendInfo(chatId) {
  const text =
    `ℹ️ INFORMASI\n\n` +
    `• Pembayaran lewat Pakasir\n` +
    `• Produk dikirim otomatis setelah pembayaran berhasil\n`;
  await tg("sendMessage", { chat_id: chatId, text, reply_markup: mainMenuKeyboard() });
}

async function sendHowToOrder(chatId) {
  const text =
    `✨ Cara Order\n\n` +
    `1) Klik 📦 List Produk\n` +
    `2) Pilih kategori\n` +
    `3) Pilih produk\n` +
    `4) Klik tombol "Bayar sekarang"\n` +
    `5) Setelah status pembayaran "completed", link dikirim otomatis\n`;
  await tg("sendMessage", { chat_id: chatId, text, reply_markup: mainMenuKeyboard() });
}

async function sendCategoryList(chatId) {
  if (!CATEGORY_TABS.length) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Kategori belum diset. Isi ENV CATEGORY_TABS dulu ya.",
      reply_markup: mainMenuKeyboard()
    });
    return;
  }

  const buttons = CATEGORY_TABS.map((tab) => [{ text: tab, callback_data: `CAT:${tab}` }]);

  await tg("sendMessage", {
    chat_id: chatId,
    text: "📦 Pilih kategori:",
    reply_markup: { inline_keyboard: buttons }
  });
}

async function sendProductsByCategory(chatId, tabName) {
  const products = await listProducts(tabName);
  if (!products.length) {
    await tg("sendMessage", { chat_id: chatId, text: `Kategori ${tabName} kosong.` });
    return;
  }

  // Batas tombol Telegram: jangan kebanyakan. Kalau produk kamu banyak, nanti kita bikin paging.
  const buttons = products.slice(0, 50).map((p) => [
    {
      text: `${p.name} — ${rupiah(p.price)}`,
      callback_data: `BUY2:${encodeURIComponent(tabName)}:${p.rowIndex}`
    }
  ]);

  await tg("sendMessage", {
    chat_id: chatId,
    text: `📦 ${tabName}\nPilih produk:`,
    reply_markup: { inline_keyboard: buttons }
  });
}

async function startCheckout(chatId, fromUsername, tabName, rowIndex) {
  const product = await getProductByRow(tabName, rowIndex);
  if (!product) {
    await tg("sendMessage", { chat_id: chatId, text: "Produk tidak valid / sudah dihapus." });
    return;
  }

  const orderId = makeOrderId("INV");

  // product_id = pointer ke katalog
  const productRef = `${tabName}#${rowIndex}`;

  await createPendingOrder({
    orderId,
    chatId,
    username: fromUsername || "",
    productId: productRef,
    amount: product.price
  });

  const payUrl = pakasirPayUrl(product.price, orderId);

  const text =
    `🧾 Invoice dibuat\n\n` +
    `• Order ID: ${orderId}\n` +
    `• Produk: ${product.name}\n` +
    `• Total: ${rupiah(product.price)}\n\n` +
    `Klik tombol di bawah untuk bayar.`;

  await tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: {
      inline_keyboard: [
        [{ text: "💳 Bayar sekarang", url: payUrl }],
        [{ text: "🔄 Cek status", callback_data: `CHECK:${orderId}` }],
        [{ text: "❌ Batalkan", callback_data: `CANCEL:${orderId}` }]
      ]
    }
  });

  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `🆕 Order baru\n` +
      `Order ID: ${orderId}\n` +
      `Produk: ${product.name}\n` +
      `Kategori: ${tabName}\n` +
      `User: @${fromUsername || "-"}\n` +
      `Chat: ${chatId}\n` +
      `Total: ${rupiah(product.price)}`
  });
}

async function checkStatus(chatId, orderId) {
  const order = await findOrder(orderId);
  if (!order) {
    await tg("sendMessage", { chat_id: chatId, text: "Order tidak ditemukan." });
    return;
  }

  const detail = await pakasirTransactionDetail(order.amount, order.order_id);
  const status = detail?.transaction?.status || detail?.status || "unknown";

  await tg("sendMessage", {
    chat_id: chatId,
    text: `Status transaksi ${orderId}: ${status}`
  });
}

async function cancelOrder(chatId, orderId) {
  const order = await findOrder(orderId);
  if (!order) {
    await tg("sendMessage", { chat_id: chatId, text: "Order tidak ditemukan." });
    return;
  }

  if (String(order.chat_id) !== String(chatId)) {
    await tg("sendMessage", { chat_id: chatId, text: "Order ini bukan milik kamu." });
    return;
  }

  if (order.status === "PAID") {
    await tg("sendMessage", { chat_id: chatId, text: "Order sudah PAID, tidak bisa dibatalkan." });
    return;
  }

  await setOrderStatus(order.rowIndex, "CANCELLED");
  await tg("sendMessage", { chat_id: chatId, text: `Order ${orderId} dibatalkan.` });
}

/** =========================
 * Delivery (setelah PAID)
 * ========================= */
async function deliverProduct(order) {
  const chatId = order.chat_id;

  const ref = String(order.product_id || "");
  const [tabName, rowStr] = ref.split("#");
  const rowIndex = Number(rowStr);

  if (!tabName || !Number.isFinite(rowIndex)) {
    await tg("sendMessage", { chat_id: chatId, text: "Pembayaran sukses, tapi data produk tidak valid. Hubungi admin." });
    await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: `⚠️ ProductRef invalid\nOrder: ${order.order_id}\nRef: ${ref}` });
    return;
  }

  const product = await getProductByRow(tabName, rowIndex);
  if (!product) {
    await tg("sendMessage", { chat_id: chatId, text: "Pembayaran sukses, tapi produk tidak ditemukan. Hubungi admin." });
    await tg("sendMessage", { chat_id: ADMIN_CHAT_ID, text: `⚠️ Produk hilang\nOrder: ${order.order_id}\nRef: ${ref}` });
    return;
  }

  if (UPDATE_CATALOG_LAST_PURCHASE) {
    const now = new Date().toISOString();
    // Kolom E = TANGGAL, F = INVOICE (sesuai screenshot)
    await updateCell(tabName, `E${rowIndex}`, now);
    await updateCell(tabName, `F${rowIndex}`, order.order_id);
  }

  const msg =
    `✅ Pembayaran berhasil!\n\n` +
    `📦 Produk: ${product.name}\n` +
    `🧾 Invoice: ${order.order_id}\n\n` +
    (product.desc ? `📝 Deskripsi:\n${product.desc}\n\n` : "") +
    `🔗 Link Download:\n${product.link}\n\n` +
    `Terima kasih 🙏`;

  await tg("sendMessage", { chat_id: chatId, text: msg, reply_markup: mainMenuKeyboard() });

  await tg("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `✅ Delivery sukses\n` +
      `Order: ${order.order_id}\n` +
      `Produk: ${product.name}\n` +
      `Kategori: ${tabName}\n` +
      `Row: ${rowIndex}\n` +
      `Chat: ${chatId}`
  });
}

/** =========================
 * Routes
 * ========================= */
app.get("/", (req, res) => res.status(200).send("OK"));

/**
 * Telegram Webhook
 */
app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    // callback button
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message?.chat?.id;
      const data = cq.data || "";
      const fromUsername = cq.from?.username || "";

      // ack biar loading hilang
      await tg("answerCallbackQuery", { callback_query_id: cq.id });

      if (data.startsWith("CAT:")) {
        const tabName = data.slice(4);
        await sendProductsByCategory(chatId, tabName);
      } else if (data.startsWith("BUY2:")) {
        const [, encTab, rowStr] = data.split(":");
        const tabName = decodeURIComponent(encTab);
        const rowIndex = Number(rowStr);
        await startCheckout(chatId, fromUsername, tabName, rowIndex);
      } else if (data.startsWith("CHECK:")) {
        const orderId = data.split(":")[1];
        await checkStatus(chatId, orderId);
      } else if (data.startsWith("CANCEL:")) {
        const orderId = data.split(":")[1];
        await cancelOrder(chatId, orderId);
      }

      return res.sendStatus(200);
    }

    // pesan biasa
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = (update.message.text || "").trim();

      if (text === "/start") {
        await sendWelcome(chatId);
      } else if (text === "📦 List Produk") {
        await sendCategoryList(chatId);
      } else if (text === "ℹ️ INFORMASI") {
        await sendInfo(chatId);
      } else if (text === "✨ Cara Order") {
        await sendHowToOrder(chatId);
      } else {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "Pilih menu di bawah ya 🙂",
          reply_markup: mainMenuKeyboard()
        });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Telegram webhook error:", err);
    res.sendStatus(200); // tetap 200 biar Telegram tidak spam retry
  }
});

/**
 * Pakasir Webhook
 * URL di dashboard Pakasir:
 * https://<domain>/pakasir/webhook/<PAKASIR_WEBHOOK_SECRET>
 */
app.post(`/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const body = req.body || {};
    const { amount, order_id } = body;

    // respon cepat dulu
    res.status(200).json({ ok: true });

    if (!order_id || !amount) return;

    // validasi final status via transactiondetail
    const detail = await pakasirTransactionDetail(amount, order_id);
    const t = detail?.transaction;

    if (!t) {
      await tg("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text: `⚠️ Pakasir webhook masuk tapi transactiondetail kosong\nOrder: ${order_id}\nAmount: ${amount}\nBody: ${JSON.stringify(body)}`
      });
      return;
    }

    const finalStatus = String(t.status || "").toLowerCase();
    if (finalStatus !== "completed") return;

    const order = await findOrder(order_id);
    if (!order) {
      await tg("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text: `⚠️ PAID tapi order tidak ada di sheet Orders\nOrder: ${order_id}\nAmount: ${amount}`
      });
      return;
    }

    if (order.status === "PAID") return; // idempotent

    // pastikan amount sama
    if (Number(order.amount) !== Number(amount)) {
      await tg("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text: `⚠️ Amount mismatch\nOrder: ${order_id}\nOrdersSheet: ${order.amount}\nPakasir: ${amount}`
      });
      return;
    }

    await setOrderStatus(order.rowIndex, "PAID", new Date().toISOString());
    await deliverProduct(order);
  } catch (err) {
    console.error("Pakasir webhook error:", err);
  }
});

/** =========================
 * Start Server
 * ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port", PORT));
