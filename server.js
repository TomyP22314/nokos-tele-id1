import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json({ verify: rawBodySaver }));
app.use(express.urlencoded({ extended: true }));

function rawBodySaver(req, res, buf) {
  req.rawBody = buf; // untuk verifikasi signature jika diperlukan
}

/** =========================
 *  ENV (Render Environment)
 *  ========================= */
const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_WEBHOOK_SECRET = process.env.WEBHOOK_SECRET; // contoh: gomsecret123
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || "";

const SHEET_ID = process.env.SHEET_ID;
const SHEET_ORDERS_TAB = process.env.SHEET_ORDERS_TAB || "Orders"; // WAJIB ADA TAB INI
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// Pakasir
const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const PAKASIR_WEBHOOK_SECRET = process.env.PAKASIR_WEBHOOK_SECRET; // contoh: whsec_goms123

// Opsional (kalau mau kirim animasi/gif di /start)
const WELCOME_ANIM_FILE_ID = process.env.WELCOME_ANIM_FILE_ID || "";

// Base URL service render kamu (wajib agar link webhook & callback benar)
const BASE_URL = process.env.BASE_URL || "https://nokos-tele.onrender.com";

// Pakasir create invoice endpoint (karena tiap akun bisa beda)
// Isi ini di ENV kalau endpoint default tidak cocok.
const PAKASIR_CREATE_URL =
  process.env.PAKASIR_CREATE_URL || "https://pakasir.id/api/transaction";

// Pakasir header auth mode:
// "bearer" -> Authorization: Bearer xxx
// "x-api-key" -> X-API-KEY: xxx
const PAKASIR_AUTH_MODE = process.env.PAKASIR_AUTH_MODE || "bearer";

// Minimal amount deposit
const MIN_AMOUNT = 1000;

/** =========================
 *  PRICE LIST
 *  ========================= */
const PRODUCTS = [
  { id: "ID1", price: 28000 },
  { id: "ID2", price: 25000 },
  { id: "ID3", price: 23000 },
  { id: "ID4", price: 20000 },
  { id: "ID5", price: 18000 },
  { id: "ID6", price: 15000 },
  { id: "ID7", price: 10000 },
  { id: "ID8", price: 9000 }
];

/** =========================
 *  BASIC HELPERS
 *  ========================= */
function rupiah(n) {
  return "Rp " + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function nowISO() {
  return new Date().toISOString();
}

function assertEnv() {
  const missing = [];
  const req = [
    ["BOT_TOKEN", BOT_TOKEN],
    ["WEBHOOK_SECRET", TELEGRAM_WEBHOOK_SECRET],
    ["SHEET_ID", SHEET_ID],
    ["GOOGLE_SERVICE_ACCOUNT_JSON", GOOGLE_SERVICE_ACCOUNT_JSON],
    ["PAKASIR_SLUG", PAKASIR_SLUG],
    ["PAKASIR_API_KEY", PAKASIR_API_KEY],
    ["PAKASIR_WEBHOOK_SECRET", PAKASIR_WEBHOOK_SECRET]
  ];
  for (const [k, v] of req) if (!v) missing.push(k);
  if (missing.length) throw new Error("Missing ENV: " + missing.join(", "));
}

/** =========================
 *  GOOGLE SHEETS
 *  ========================= */
function getSheetsClient() {
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const jwt = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  const sheets = google.sheets({ version: "v4", auth: jwt });
  return sheets;
}

async function ensureOrdersHeader() {
  const sheets = getSheetsClient();
  // Buat header Orders minimal
  const header = [
    "order_id",
    "chat_id",
    "username",
    "product_id",
    "price",
    "status",
    "invoice_id",
    "invoice_url",
    "stock_sheet",
    "stock_row",
    "created_at",
    "paid_at"
  ];

  // Cek apakah baris 1 kosong
  const range = `${SHEET_ORDERS_TAB}!A1:L1`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });

  const current = (res.data.values && res.data.values[0]) || [];
  if (current.length === 0 || current.join("|") !== header.join("|")) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [header] }
    });
  }
}

async function appendOrderRow(row) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_ORDERS_TAB}!A:L`,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] }
  });
}

// Cari order by invoice_id (scan Orders)
async function findOrderByInvoiceId(invoiceId) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${SHEET_ORDERS_TAB}!A2:L`
  });
  const rows = res.data.values || [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    // invoice_id kolom G (index 6) sesuai header
    if (r[6] === String(invoiceId)) {
      return { rowIndexInSheet: i + 2, row: r };
    }
  }
  return null;
}

async function updateOrderStatusByRowIndex(rowIndex, { status, paidAt }) {
  const sheets = getSheetsClient();
  // status kolom F, paid_at kolom L
  const updates = [];
  if (status) updates.push({ range: `${SHEET_ORDERS_TAB}!F${rowIndex}`, values: [[status]] });
  if (paidAt) updates.push({ range: `${SHEET_ORDERS_TAB}!L${rowIndex}`, values: [[paidAt]] });

  for (const u of updates) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: u.range,
      valueInputOption: "RAW",
      requestBody: { values: u.values }
    });
  }
}

// Ambil stok pertama dari tab produk (ID1..ID8)
// return: { values, rowNumber }
async function takeOneStock(productId) {
  const sheets = getSheetsClient();

  // Ambil semua data (A2:F) karena header di row 1
  const range = `${productId}!A2:F`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });

  const rows = res.data.values || [];
  if (rows.length === 0) return null;

  // Cari baris pertama yang punya User ID (kolom A tidak kosong)
  let idx = -1;
  for (let i = 0; i < rows.length; i++) {
    const userId = (rows[i][0] || "").trim();
    if (userId) {
      idx = i;
      break;
    }
  }
  if (idx === -1) return null;

  const picked = rows[idx];
  const rowNumber = idx + 2; // karena range mulai A2
  return { picked, rowNumber };
}

// Hapus baris stok setelah sold
async function deleteStockRow(productId, rowNumber) {
  const sheets = getSheetsClient();

  // Butuh sheetId (bukan nama tab), jadi ambil metadata dulu
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const sheet = (meta.data.sheets || []).find(
    (s) => s.properties && s.properties.title === productId
  );
  if (!sheet) throw new Error(`Tab sheet ${productId} tidak ditemukan`);

  const sheetId = sheet.properties.sheetId;

  // Delete dimension rows: rowNumber adalah 1-based, API butuh 0-based index
  const startIndex = rowNumber - 1;
  const endIndex = rowNumber;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId,
              dimension: "ROWS",
              startIndex,
              endIndex
            }
          }
        }
      ]
    }
  });
}

// Hitung stok ready (jumlah baris dengan User ID terisi)
async function countStock(productId) {
  const sheets = getSheetsClient();
  const range = `${productId}!A2:A`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });
  const rows = res.data.values || [];
  let c = 0;
  for (const r of rows) {
    const v = (r[0] || "").trim();
    if (v) c++;
  }
  return c;
}

/** =========================
 *  TELEGRAM API HELPERS
 *  ========================= */
const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function tg(method, payload) {
  const res = await fetch(`${TG_API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const json = await res.json();
  if (!json.ok) {
    console.log("Telegram error:", json);
    throw new Error(json.description || "Telegram API error");
  }
  return json.result;
}

async function sendMainMenu(chatId, text) {
  const keyboard = {
    keyboard: [
      [{ text: "📦 List Produk" }],
      [{ text: "ℹ️ INFORMASI" }, { text: "✨ Cara Order" }]
    ],
    resize_keyboard: true
  };
  return tg("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: keyboard
  });
}

async function sendStockList(chatId) {
  // Buat pesan stok READY saja
  const lines = [];
  lines.push("📦 *Stok saat ini (READY saja):*");
  lines.push("");

  const buttons = [];
  for (const p of PRODUCTS) {
    const stok = await countStock(p.id);
    const dot = stok > 0 ? "🟢" : "🔴";
    lines.push(`${dot} *${p.id}*: ${stok} stok — ${rupiah(p.price)}`);
    if (stok > 0) {
      buttons.push([{ text: `${p.id} (${rupiah(p.price)})`, callback_data: `BUY:${p.id}` }]);
    }
  }

  lines.push("");
  lines.push("Pilih ID yang ingin dibeli:");

  const inline = {
    inline_keyboard: buttons.length ? buttons : [[{ text: "Stok kosong", callback_data: "NOOP" }]]
  };

  return tg("sendMessage", {
    chat_id: chatId,
    text: lines.join("\n"),
    parse_mode: "Markdown",
    reply_markup: inline
  });
}

async function sendInfo(chatId) {
  const text =
    "ℹ️ *INFORMASI*\n\n" +
    "• Semua transaksi diproses otomatis.\n" +
    "• Pembayaran menggunakan *Pakasir*.\n" +
    "• Detail produk dikirim *setelah pembayaran terverifikasi*.\n\n" +
    "Jika ada kendala, hubungi admin.";
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
}

async function sendHowTo(chatId) {
  const text =
    "✨ *Cara Order*\n\n" +
    "1) Klik *List Produk*\n" +
    "2) Pilih ID yang ingin dibeli\n" +
    "3) Bot akan membuat invoice Pakasir\n" +
    "4) Setelah status *PAID*, bot kirim detail produk otomatis\n\n" +
    "Catatan: Jika stok habis, tombol tidak muncul.";
  return tg("sendMessage", { chat_id: chatId, text, parse_mode: "Markdown" });
}

/** =========================
 *  PAKASIR INVOICE (GENERIC)
 *  =========================
 * Karena endpoint & format Pakasir bisa beda,
 * bagian ini dibuat fleksibel.
 */
function pakasirAuthHeaders() {
  if (PAKASIR_AUTH_MODE === "x-api-key") {
    return { "X-API-KEY": PAKASIR_API_KEY };
  }
  return { Authorization: `Bearer ${PAKASIR_API_KEY}` };
}

async function pakasirCreateInvoice({ orderId, title, amount, chatId }) {
  const payload = {
    project_slug: PAKASIR_SLUG,
    external_id: orderId,
    amount: amount,
    description: title,
    customer_id: String(chatId),

    // Jika Pakasir mendukung callback:
    callback_url: `${BASE_URL}/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}`,
    webhook_url: `${BASE_URL}/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}`
  };

  const res = await fetch(PAKASIR_CREATE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...pakasirAuthHeaders()
    },
    body: JSON.stringify(payload)
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.log("Pakasir create invoice failed:", json);
    throw new Error("Gagal membuat invoice Pakasir. Cek endpoint/format payload.");
  }

  // Normalisasi field (berbeda-beda tiap gateway)
  const invoiceId =
    json.invoice_id || json.transaction_id || json.id || json.data?.id || "";
  const invoiceUrl =
    json.invoice_url || json.payment_url || json.url || json.data?.payment_url || "";

  if (!invoiceUrl) {
    console.log("Pakasir response:", json);
    throw new Error("Invoice berhasil dibuat tapi link pembayaran tidak ditemukan (payment_url).");
  }

  return { invoiceId: String(invoiceId || orderId), invoiceUrl, raw: json };
}

/** =========================
 *  ORDER FLOW
 *  ========================= */
function makeOrderId() {
  return "ORD-" + Date.now() + "-" + Math.floor(Math.random() * 9999);
}

async function startBuyFlow(chatId, username, productId) {
  const product = PRODUCTS.find((p) => p.id === productId);
  if (!product) {
    return tg("sendMessage", { chat_id: chatId, text: "Produk tidak ditemukan." });
  }

  const stok = await countStock(productId);
  if (stok <= 0) {
    return tg("sendMessage", { chat_id: chatId, text: "Maaf, stok habis." });
  }

  const orderId = makeOrderId();
  const title = `${productId} x1`;

  // Buat invoice
  const inv = await pakasirCreateInvoice({
    orderId,
    title,
    amount: product.price,
    chatId
  });

  // simpan ke Orders
  await appendOrderRow([
    orderId,
    String(chatId),
    username || "",
    productId,
    String(product.price),
    "PENDING",
    inv.invoiceId,
    inv.invoiceUrl,
    productId,
    "", // stock_row belum tahu sampai PAID
    nowISO(),
    "" // paid_at
  ]);

  // kirim QR / link (Telegram akan auto preview link)
  const text =
    "🧾 *Invoice berhasil dibuat*\n\n" +
    `• Produk: *${productId}*\n` +
    `• Harga: *${rupiah(product.price)}*\n` +
    `• Order ID: \`${orderId}\`\n\n` +
    "Klik tombol di bawah untuk bayar:";

  const inline = {
    inline_keyboard: [
      [{ text: "💳 Bayar Sekarang", url: inv.invoiceUrl }],
      [{ text: "❌ Batalkan", callback_data: `CANCEL:${orderId}` }]
    ]
  };

  return tg("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    reply_markup: inline
  });
}

/** =========================
 *  TELEGRAM WEBHOOK
 *  ========================= */
app.post(`/telegram/webhook/${TELEGRAM_WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    // handle callback button
    if (update.callback_query) {
      const cq = update.callback_query;
      const chatId = cq.message.chat.id;
      const username = cq.from.username || "";

      const data = cq.data || "";
      if (data.startsWith("BUY:")) {
        const productId = data.split(":")[1];
        await tg("answerCallbackQuery", { callback_query_id: cq.id });
        await startBuyFlow(chatId, username, productId);
      } else if (data.startsWith("CANCEL:")) {
        await tg("answerCallbackQuery", { callback_query_id: cq.id, text: "Order dibatalkan." });
        await tg("sendMessage", { chat_id: chatId, text: "✅ Order dibatalkan." });
      } else {
        await tg("answerCallbackQuery", { callback_query_id: cq.id });
      }

      return res.json({ ok: true });
    }

    // handle message
    if (update.message && update.message.text) {
      const chatId = update.message.chat.id;
      const username = update.message.from.username || "";
      const text = (update.message.text || "").trim();

      if (text === "/start") {
        // optional anim
        if (WELCOME_ANIM_FILE_ID) {
          try {
            await tg("sendAnimation", {
              chat_id: chatId,
              animation: WELCOME_ANIM_FILE_ID,
              caption:
                "👋 *Selamat datang di Toko Digital*\n\nGunakan menu di bawah untuk melihat produk.",
              parse_mode: "Markdown"
            });
          } catch (e) {
            // kalau gagal anim, lanjut saja
          }
        }

        await sendMainMenu(
          chatId,
          "👋 Selamat datang!\nPilih menu di bawah untuk mulai."
        );
        return res.json({ ok: true });
      }

      if (text === "📦 List Produk") {
        await sendStockList(chatId);
        return res.json({ ok: true });
      }

      if (text === "ℹ️ INFORMASI") {
        await sendInfo(chatId);
        return res.json({ ok: true });
      }

      if (text === "✨ Cara Order") {
        await sendHowTo(chatId);
        return res.json({ ok: true });
      }

      // default
      await sendMainMenu(chatId, "Pilih menu ya 🙂");
    }

    res.json({ ok: true });
  } catch (err) {
    console.log("Telegram webhook error:", err);
    res.json({ ok: true });
  }
});

/** =========================
 *  PAKASIR WEBHOOK
 *  =========================
 * WAJIB set di dashboard Pakasir:
 * ${BASE_URL}/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}
 */
app.post(`/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const payload = req.body || {};

    // Normalisasi status + invoiceId
    const status =
      payload.status ||
      payload.data?.status ||
      payload.transaction_status ||
      "";

    const invoiceId =
      payload.invoice_id ||
      payload.id ||
      payload.transaction_id ||
      payload.data?.id ||
      payload.data?.invoice_id ||
      "";

    // Kita anggap "PAID"/"SUCCESS"/"SETTLED" sebagai pembayaran sukses
    const paid =
      String(status).toUpperCase() === "PAID" ||
      String(status).toUpperCase() === "SUCCESS" ||
      String(status).toUpperCase() === "SETTLED";

    if (!invoiceId) {
      console.log("Webhook masuk tapi invoiceId kosong:", payload);
      return res.json({ ok: true });
    }

    if (!paid) {
      // status belum paid -> ignore
      return res.json({ ok: true });
    }

    // Cari order di sheet
    const found = await findOrderByInvoiceId(String(invoiceId));
    if (!found) {
      console.log("Order tidak ditemukan utk invoiceId:", invoiceId);
      return res.json({ ok: true });
    }

    const { rowIndexInSheet, row } = found;
    const orderId = row[0];
    const chatId = row[1];
    const productId = row[3];
    const price = row[4];

    // Ambil stok 1 item
    const stock = await takeOneStock(productId);
    if (!stock) {
      await tg("sendMessage", {
        chat_id: chatId,
        text:
          "✅ Pembayaran terverifikasi.\n\n" +
          "Namun stok sedang kosong / habis. Admin akan menghubungi kamu."
      });

      if (ADMIN_CHAT_ID) {
        await tg("sendMessage", {
          chat_id: ADMIN_CHAT_ID,
          text: `⚠️ PAID tapi stok kosong!\nOrder: ${orderId}\nProduk: ${productId}\nChat: ${chatId}`
        });
      }

      await updateOrderStatusByRowIndex(rowIndexInSheet, {
        status: "PAID_NO_STOCK",
        paidAt: nowISO()
      });

      return res.json({ ok: true });
    }

    // Hapus baris stok agar tidak tampil lagi
    await deleteStockRow(productId, stock.rowNumber);

    // Update order status
    await updateOrderStatusByRowIndex(rowIndexInSheet, {
      status: "PAID",
      paidAt: nowISO()
    });

    // Kirim detail produk (dari sheet)
    const [userId, username, nama, nomorHp, twofa, emailRecovery] = stock.picked;

    const msg =
      "✅ *Pembayaran Berhasil*\n\n" +
      `• Order: \`${orderId}\`\n` +
      `• Produk: *${productId}*\n` +
      `• Harga: *${rupiah(Number(price))}*\n\n` +
      "*Detail Produk:*\n" +
      `• User ID: \`${userId || "-"}\`\n` +
      `• Username: ${username || "-"}\n` +
      `• Nama: ${nama || "-"}\n` +
      `• Nomor HP: ${nomorHp || "-"}\n` +
      `• 2FA: ${twofa || "-"}\n` +
      `• Email Recovery: ${emailRecovery || "-"}\n\n` +
      "_Terima kasih!_";

    await tg("sendMessage", {
      chat_id: chatId,
      text: msg,
      parse_mode: "Markdown"
    });

    return res.json({ ok: true });
  } catch (err) {
    console.log("Pakasir webhook error:", err);
    return res.json({ ok: true });
  }
});

/** =========================
 *  HEALTH CHECK
 *  ========================= */
app.get("/", (req, res) => res.send("OK"));

/** =========================
 *  START SERVER
 *  ========================= */
async function main() {
  assertEnv();
  await ensureOrdersHeader();

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log("Server running on", port);
    console.log("Telegram webhook endpoint:", `${BASE_URL}/telegram/webhook/${TELEGRAM_WEBHOOK_SECRET}`);
    console.log("Pakasir webhook endpoint:", `${BASE_URL}/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}`);
  });
}

main().catch((e) => {
  console.log("Fatal:", e);
  process.exit(1);
});
