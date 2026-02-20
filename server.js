import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

/**
 * =========================
 *  ENV yang WAJIB di Render
 * =========================
 * ADMIN_CHAT_ID              -> chat id admin (angka)
 * BOT_TOKEN                  -> token bot telegram
 * GOOGLE_SERVICE_ACCOUNT_JSON-> json service account (1 baris, lengkap)
 * SHEET_ID                   -> id spreadsheet
 * SHEET_ORDERS_TAB           -> nama tab orders, contoh: Orders
 * WEBHOOK_SECRET             -> secret telegram webhook path, contoh: gomsecret123
 *
 * PAKASIR_API_KEY            -> api key pakasir
 * PAKASIR_SLUG               -> slug project pakasir (dari dashboard)
 * PAKASIR_WEBHOOK_SECRET     -> secret untuk webhook pakasir (contoh: whsec_xxx)
 *
 * OPTIONAL:
 * WELCOME_ANIM_FILE_ID       -> file_id animasi welcome (boleh kosong)
 *
 * CATATAN:
 * - Sheet stok: ID1..ID8
 * - Header stok (baris 1): User ID | Username | Nama | Nomor HP | 2FA | Email Recovery
 */

const {
  ADMIN_CHAT_ID,
  BOT_TOKEN,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SHEET_ID,
  SHEET_ORDERS_TAB,
  WEBHOOK_SECRET,

  PAKASIR_API_KEY,
  PAKASIR_SLUG,
  PAKASIR_WEBHOOK_SECRET,

  WELCOME_ANIM_FILE_ID,
} = process.env;

function assertEnv() {
  const required = [
    "ADMIN_CHAT_ID",
    "BOT_TOKEN",
    "GOOGLE_SERVICE_ACCOUNT_JSON",
    "SHEET_ID",
    "SHEET_ORDERS_TAB",
    "WEBHOOK_SECRET",
    "PAKASIR_API_KEY",
    "PAKASIR_SLUG",
    "PAKASIR_WEBHOOK_SECRET",
  ];
  const missing = required.filter((k) => !process.env[k] || String(process.env[k]).trim() === "");
  if (missing.length) throw new Error("Missing ENV: " + missing.join(", "));
}
assertEnv();

const app = express();

// Telegram & Pakasir biasanya kirim JSON
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

const ID_LIST = ["ID1", "ID2", "ID3", "ID4", "ID5", "ID6", "ID7", "ID8"];
const PRICE_MAP = {
  ID1: 28000,
  ID2: 25000,
  ID3: 23000,
  ID4: 20000,
  ID5: 18000,
  ID6: 15000,
  ID7: 10000,
  ID8: 9000,
};

// =========================
// Google Sheets client
// =========================
function getGoogleClient() {
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

async function sheetsGet(range) {
  const sheets = getGoogleClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return res.data.values || [];
}

async function sheetsAppend(range, values) {
  const sheets = getGoogleClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

async function sheetsUpdate(range, values) {
  const sheets = getGoogleClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values },
  });
}

async function sheetsClear(range) {
  const sheets = getGoogleClient();
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range,
  });
}

// Helper: ubah angka ke format rupiah
function rupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

// =========================
// Telegram API helper
// =========================
async function tg(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) {
    console.log("TG error:", json);
    throw new Error(json.description || "Telegram API error");
  }
  return json.result;
}

async function sendText(chatId, text, extra = {}) {
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
}

async function sendAnim(chatId, fileId, caption, extra = {}) {
  return tg("sendAnimation", {
    chat_id: chatId,
    animation: fileId,
    caption,
    parse_mode: "HTML",
    ...extra,
  });
}

// =========================
// Data / Orders logic
// =========================
function nowISO() {
  return new Date().toISOString();
}

function makeOrderId() {
  return "ORD-" + Date.now() + "-" + Math.floor(Math.random() * 100000);
}

async function ensureOrdersHeader() {
  // Orders sheet columns:
  // A: order_id
  // B: chat_id
  // C: username
  // D: product_id (ID1..ID8)
  // E: price
  // F: status (pending/paid/canceled/failed)
  // G: invoice_id (from pakasir)
  // H: invoice_url
  // I: created_at
  // J: paid_at
  // K: delivered_at
  // L: stock_sheet (IDx)
  // M: stock_row (row number in that sheet)
  // N: stock_payload (string JSON)
  const headerRange = `${SHEET_ORDERS_TAB}!A1:N1`;
  const row = await sheetsGet(headerRange);
  if (row.length === 0) {
    await sheetsUpdate(headerRange, [[
      "order_id","chat_id","username","product_id","price","status","invoice_id","invoice_url",
      "created_at","paid_at","delivered_at","stock_sheet","stock_row","stock_payload"
    ]]);
  }
}

async function findFirstStockRow(sheetName) {
  // Read A2:G (User ID..Email Recovery)
  const values = await sheetsGet(`${sheetName}!A2:G`);
  // values[i] corresponds to row (i+2)
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const userId = row?.[0];
    if (userId && String(userId).trim() !== "") {
      return { rowNumber: i + 2, rowValues: row };
    }
  }
  return null;
}

async function countStock(sheetName) {
  const values = await sheetsGet(`${sheetName}!A2:A`);
  let count = 0;
  for (const r of values) {
    const v = r?.[0];
    if (v && String(v).trim() !== "") count++;
  }
  return count;
}

async function getAllStockCounts() {
  const counts = {};
  for (const id of ID_LIST) {
    counts[id] = await countStock(id);
  }
  return counts;
}

function buildStockText(counts) {
  const lines = [];
  lines.push(`<b>📦 Stok saat ini (READY saja):</b>\n`);
  for (const id of ID_LIST) {
    const c = counts[id] || 0;
    const price = PRICE_MAP[id];
    const dot = c > 0 ? "🟢" : "🔴";
    lines.push(`${dot} <b>${id}</b>: ${c} stok — <b>${rupiah(price)}</b>`);
  }
  lines.push(`\n<i>Pilih ID yang ingin dibeli:</i>`);
  return lines.join("\n");
}

function buildProductButtons(counts) {
  const buttons = [];
  for (const id of ID_LIST) {
    if ((counts[id] || 0) > 0) {
      buttons.push([{ text: `${id} (${rupiah(PRICE_MAP[id])})`, callback_data: `BUY:${id}` }]);
    }
  }
  // jika semua kosong
  if (buttons.length === 0) {
    buttons.push([{ text: "Tidak ada stok ready", callback_data: "NO_STOCK" }]);
  }
  return buttons;
}

// =========================
// Pakasir (placeholder safe)
// =========================
/**
 * NOTE:
 * Aku tidak tahu endpoint pasti Pakasir kamu (tiap provider beda).
 * Jadi aku buat 1 function yang kamu tinggal sesuaikan endpoint-nya kalau perlu.
 *
 * Yang wajib dari Pakasir:
 * - bikin invoice: return { invoice_id, invoice_url, qr_url? }
 * - webhook: kirim status PAID beserta invoice_id / order_id
 */
async function pakasirCreateInvoice({ orderId, title, amount, customerChatId }) {
  // Kamu mungkin perlu ubah endpoint ini sesuai dokumentasi Pakasir kamu.
  // Contoh pattern umum:
  // POST https://pakasir.com/api/invoices
  // headers: Authorization: Bearer <API_KEY>
  // body: { amount, description, external_id, ... }
  const endpoint = `https://pakasir.id/api/projects/${encodeURIComponent(PAKASIR_SLUG)}/invoices`; // <-- kalau beda, ubah di sini

  const payload = {
    external_id: orderId,
    amount: amount,
    description: title,
    customer_ref: String(customerChatId),
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${PAKASIR_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  let json = null;
  try { json = await res.json(); } catch { json = null; }

  // Kalau endpoint beda, biasanya error di sini. Lihat logs Render untuk menyesuaikan.
  if (!res.ok) {
    console.log("Pakasir create invoice failed:", res.status, json);
    throw new Error("Pakasir invoice gagal dibuat. Perlu sesuaikan endpoint/format sesuai Pakasir.");
  }

  // Normalisasi output (sesuaikan jika struktur beda)
  const invoiceId = json?.invoice_id || json?.data?.id || json?.id;
  const invoiceUrl = json?.invoice_url || json?.data?.invoice_url || json?.data?.url || json?.url;

  if (!invoiceId || !invoiceUrl) {
    console.log("Pakasir response unknown:", json);
    throw new Error("Response Pakasir tidak dikenali. Cek struktur JSON di logs.");
  }

  return { invoice_id: invoiceId, invoice_url: invoiceUrl, raw: json };
}

// =========================
// UI Text
// =========================
function mainMenuKeyboard() {
  return {
    keyboard: [
      [{ text: "📦 List Produk" }],
      [{ text: "ℹ️ INFORMASI" }, { text: "✨ Cara Order" }],
    ],
    resize_keyboard: true,
  };
}

function infoText() {
  return (
    `<b>ℹ️ INFORMASI</b>\n` +
    `• Produk digital dikirim otomatis setelah pembayaran terverifikasi.\n` +
    `• Pastikan kamu memilih ID yang benar.\n` +
    `• Jika ada kendala, hubungi admin.\n\n` +
    `<b>Admin:</b> <code>${ADMIN_CHAT_ID}</code>`
  );
}

function caraOrderText() {
  return (
    `<b>✨ Cara Order</b>\n` +
    `1) Klik <b>📦 List Produk</b>\n` +
    `2) Pilih ID yang READY\n` +
    `3) Bot buat invoice pembayaran\n` +
    `4) Setelah status <b>PAID</b>, bot kirim detail produk otomatis\n\n` +
    `<i>Catatan: stok yang sudah sold tidak akan muncul lagi.</i>`
  );
}

// =========================
// Handlers
// =========================
async function handleStart(chatId, username) {
  await ensureOrdersHeader();

  const caption =
    `Halo, <b>${escapeHtml(username || "kak")}</b> 👋\n` +
    `Selamat datang di toko.\n\n` +
    `Gunakan menu di bawah untuk mulai.`;

  if (WELCOME_ANIM_FILE_ID && String(WELCOME_ANIM_FILE_ID).trim() !== "") {
    await sendAnim(chatId, WELCOME_ANIM_FILE_ID, caption, { reply_markup: mainMenuKeyboard() });
  } else {
    await sendText(chatId, caption, { reply_markup: mainMenuKeyboard() });
  }
}

async function handleListProduk(chatId) {
  const counts = await getAllStockCounts();
  const text = buildStockText(counts);
  const buttons = buildProductButtons(counts);

  await sendText(chatId, text, {
    reply_markup: { inline_keyboard: buttons },
  });
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function createOrderAndInvoice({ chatId, username, productId }) {
  await ensureOrdersHeader();

  const price = PRICE_MAP[productId];
  if (!price) throw new Error("Product tidak dikenal.");

  // lock stok: ambil 1 row pertama yang tersedia
  const stock = await findFirstStockRow(productId);
  if (!stock) {
    await sendText(chatId, `Maaf, stok <b>${productId}</b> sedang habis.`, { parse_mode: "HTML" });
    return;
  }

  const orderId = makeOrderId();
  const title = `${productId} x1`;

  // buat invoice pakasir
  let invoice = null;
  try {
    invoice = await pakasirCreateInvoice({
      orderId,
      title,
      amount: price,
      customerChatId: chatId,
    });
  } catch (e) {
    await sendText(
      chatId,
      `❌ Gagal membuat invoice.\n\n<code>${escapeHtml(e.message)}</code>\n\nCek konfigurasi Pakasir (endpoint/slug/api key).`,
      { parse_mode: "HTML" }
    );
    return;
  }

  // simpan order ke Orders
  const stockPayload = {
    columns: ["User ID","Username","Nama","Nomor HP","2FA","Email Recovery"],
    values: stock.rowValues || [],
  };

  await sheetsAppend(`${SHEET_ORDERS_TAB}!A:N`, [[
    orderId,
    String(chatId),
    username || "",
    productId,
    String(price),
    "pending",
    invoice.invoice_id,
    invoice.invoice_url,
    nowISO(),
    "",
    "",
    productId,
    String(stock.rowNumber),
    JSON.stringify(stockPayload),
  ]]);

  // kirim link bayar (button link)
  await sendText(
    chatId,
    `<b>🧾 Invoice berhasil dibuat</b>\n` +
      `• Produk: <b>${productId}</b>\n` +
      `• Total: <b>${rupiah(price)}</b>\n` +
      `• Order ID: <code>${orderId}</code>\n\n` +
      `Silakan klik tombol bayar di bawah:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: "💳 Bayar Sekarang", url: invoice.invoice_url }],
          [{ text: "❌ Batalkan", callback_data: `CANCEL:${orderId}` }],
        ],
      },
    }
  );
}

async function cancelOrder(chatId, orderId) {
  // cari order di sheet (ambil semua order, cari cocok) — sederhana
  const values = await sheetsGet(`${SHEET_ORDERS_TAB}!A2:N`);
  let idx = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i]?.[0] === orderId) { idx = i; break; }
  }
  if (idx === -1) {
    await sendText(chatId, "Order tidak ditemukan.");
    return;
  }

  const rowNumber = idx + 2;
  const status = values[idx]?.[5];

  if (status === "paid") {
    await sendText(chatId, "Order sudah dibayar, tidak bisa dibatalkan.");
    return;
  }

  // update status jadi canceled
  await sheetsUpdate(`${SHEET_ORDERS_TAB}!F${rowNumber}:F${rowNumber}`, [["canceled"]]);
  await sendText(chatId, `✅ Order <code>${orderId}</code> dibatalkan.`, { parse_mode: "HTML" });
}

// deliver product (kirim data dari stock_payload) + hapus stok row
async function deliverOrderByInvoice(invoiceId) {
  const values = await sheetsGet(`${SHEET_ORDERS_TAB}!A2:N`);
  let idx = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i]?.[6] === invoiceId) { idx = i; break; }
  }
  if (idx === -1) return { ok: false, reason: "order_not_found" };

  const rowNumber = idx + 2;
  const order = values[idx];

  const orderId = order[0];
  const chatId = Number(order[1]);
  const productId = order[3];
  const status = order[5];
  const stockSheet = order[11];
  const stockRow = Number(order[12]);
  const stockPayloadStr = order[13];

  if (status === "paid") {
    return { ok: true, already: true };
  }

  // set paid
  await sheetsUpdate(`${SHEET_ORDERS_TAB}!F${rowNumber}:J${rowNumber}`, [[
    "paid", order[6], order[7], order[8], nowISO()
  ]]);

  // kirim detail produk dari payload
  let payload = null;
  try { payload = JSON.parse(stockPayloadStr || "{}"); } catch { payload = null; }

  const v = payload?.values || [];
  const [userId, uname, nama, hp, twofa, email] = v;

  const detail =
    `<b>✅ Produk berhasil dibeli</b>\n` +
    `• Produk: <b>${productId}</b>\n` +
    `• Order ID: <code>${orderId}</code>\n\n` +
    `<b>Detail:</b>\n` +
    `• User ID: <code>${escapeHtml(userId || "-")}</code>\n` +
    `• Username: <code>${escapeHtml(uname || "-")}</code>\n` +
    `• Nama: <code>${escapeHtml(nama || "-")}</code>\n` +
    `• Nomor HP: <code>${escapeHtml(hp || "-")}</code>\n` +
    `• 2FA: <code>${escapeHtml(twofa || "-")}</code>\n` +
    `• Email Recovery: <code>${escapeHtml(email || "-")}</code>\n\n` +
    `<i>Terima kasih sudah order.</i>`;

  await sendText(chatId, detail, { parse_mode: "HTML" });

  // hapus stok: kosongkan A:G pada row itu
  // (supaya tidak tampil lagi)
  await sheetsClear(`${stockSheet}!A${stockRow}:G${stockRow}`);

  // mark delivered time
  await sheetsUpdate(`${SHEET_ORDERS_TAB}!K${rowNumber}:K${rowNumber}`, [[nowISO()]]);

  // notif admin
  await sendText(
    Number(ADMIN_CHAT_ID),
    `✅ PAID: <b>${productId}</b> | Order <code>${orderId}</code> | Invoice <code>${invoiceId}</code>`,
    { parse_mode: "HTML" }
  );

  return { ok: true };
}

// =========================
// Telegram webhook (FAST ACK)
// =========================
app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, (req, res) => {
  // balas cepat agar tidak timeout
  res.status(200).send("OK");

  // proses di belakang
  Promise.resolve()
    .then(async () => {
      const update = req.body;

      // callback (klik tombol)
      if (update?.callback_query) {
        const cq = update.callback_query;
        const chatId = cq.message?.chat?.id;
        const username = cq.from?.username || cq.from?.first_name || "";

        // penting: jawab callback biar tombol tidak "loading"
        try {
          await tg("answerCallbackQuery", { callback_query_id: cq.id });
        } catch {}

        const data = cq.data || "";

        if (data === "NO_STOCK") {
          await sendText(chatId, "Stok sedang kosong.");
          return;
        }

        if (data.startsWith("BUY:")) {
          const productId = data.split(":")[1];
          await createOrderAndInvoice({ chatId, username, productId });
          return;
        }

        if (data.startsWith("CANCEL:")) {
          const orderId = data.split(":")[1];
          await cancelOrder(chatId, orderId);
          return;
        }

        await sendText(chatId, "Perintah tidak dikenali.");
        return;
      }

      // message text
      const msg = update?.message;
      if (!msg) return;

      const chatId = msg.chat?.id;
      const username = msg.from?.username || msg.from?.first_name || "";

      const text = (msg.text || "").trim();

      if (text === "/start") {
        await handleStart(chatId, username);
        return;
      }

      if (text === "📦 List Produk" || text.toLowerCase() === "list produk") {
        await handleListProduk(chatId);
        return;
      }

      if (text === "ℹ️ INFORMASI" || text.toLowerCase() === "informasi") {
        await sendText(chatId, infoText(), { reply_markup: mainMenuKeyboard() });
        return;
      }

      if (text === "✨ Cara Order" || text.toLowerCase() === "cara order") {
        await sendText(chatId, caraOrderText(), { reply_markup: mainMenuKeyboard() });
        return;
      }

      // fallback
      await sendText(chatId, "Pilih menu di bawah ya 👇", { reply_markup: mainMenuKeyboard() });
    })
    .catch((e) => console.log("Telegram bg error:", e));
});

// =========================
// Pakasir webhook
// =========================
app.post(`/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}`, (req, res) => {
  // balas cepat
  res.status(200).send("OK");

  Promise.resolve()
    .then(async () => {
      const payload = req.body;
      console.log("Pakasir webhook payload:", JSON.stringify(payload));

      // Kamu mungkin perlu sesuaikan field status berdasarkan payload asli pakasir.
      // Kita coba dukung beberapa format umum:
      const status =
        payload?.status ||
        payload?.data?.status ||
        payload?.event ||
        payload?.type ||
        "";

      const normalized = String(status).toLowerCase();

      // Ambil invoice id dari payload
      const invoiceId =
        payload?.invoice_id ||
        payload?.data?.invoice_id ||
        payload?.data?.id ||
        payload?.id;

      if (!invoiceId) {
        console.log("Pakasir webhook: missing invoice id");
        return;
      }

      // Anggap paid jika status mengandung "paid" / "success" / "settlement"
      const isPaid =
        normalized.includes("paid") ||
        normalized.includes("success") ||
        normalized.includes("settlement");

      if (!isPaid) {
        console.log("Pakasir webhook: not paid event:", status);
        return;
      }

      await deliverOrderByInvoice(String(invoiceId));
    })
    .catch((e) => console.log("Pakasir bg error:", e));
});

// health check
app.get("/", (req, res) => res.status(200).send("OK"));

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
