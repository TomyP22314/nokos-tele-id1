import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import crypto from "crypto";
import QRCode from "qrcode";
import FormData from "form-data";

const app = express();
app.use(express.json());

/* ================= ENV ================= */
const REQUIRED = [
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

for (const key of REQUIRED) {
  if (!process.env[key] || String(process.env[key]).trim() === "") {
    throw new Error("Missing ENV: " + key);
  }
}

const {
  BOT_TOKEN,
  WEBHOOK_SECRET,
  ADMIN_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SHEET_ID,
  SHEET_ORDERS_TAB,
  PAKASIR_SLUG,
  PAKASIR_API_KEY,
  PAKASIR_WEBHOOK_SECRET
} = process.env;

const BANNER_URL = process.env.BANNER_URL || "";

/* ================= GOOGLE ================= */
const sa = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

const auth = new google.auth.JWT({
  email: sa.client_email,
  key: sa.private_key,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"]
});

const sheets = google.sheets({ version: "v4", auth });

async function readSheet(range) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range
  });
  return res.data.values || [];
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

/* ================= TELEGRAM ================= */
async function tgJson(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!j.ok) throw new Error("TG error: " + JSON.stringify(j));
  return j.result;
}

async function tgSendPhotoBuffer(chatId, buffer, caption) {
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", buffer, { filename: "qris.png", contentType: "image/png" });
  if (caption) form.append("caption", caption);

  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form
  });
  const j = await r.json();
  if (!j.ok) throw new Error("TG sendPhoto error: " + JSON.stringify(j));
  return j.result;
}

function rupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function getHarga(namaProduk) {
  if (namaProduk === "DRAKOR ID") return 15000;
  if (namaProduk === "APK DRACIN") return 20000;
  if (namaProduk === "APK ANIME") return 15000;
  return 15000;
}

// invoice mengandung index produk: INV{index}-{timestamp}-{rand}
function makeInvoice(index) {
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `INV${index}-${Date.now()}-${rand}`;
}

/* ================= UI START ================= */
function startMenuInline() {
  return {
    inline_keyboard: [
      [{ text: "📦 Produk", callback_data: "MENU_PRODUK" }],
      [{ text: "ℹ️ Info", callback_data: "MENU_INFO" }, { text: "📌 Cara Order", callback_data: "MENU_CARA" }]
    ]
  };
}

async function sendStart(chatId) {
  if (BANNER_URL) {
    await tgJson("sendPhoto", {
      chat_id: chatId,
      photo: BANNER_URL,
      caption: "🎉 Selamat datang di GOMSTORE!"
    });
  }

  await tgJson("sendMessage", {
    chat_id: chatId,
    text:
      `👋 Selamat datang!\n\n` +
      `✅ Produk digital siap kirim otomatis\n` +
      `💳 Bayar via Pakasir (QR)\n\n` +
      `Pilih menu di bawah:`,
    reply_markup: startMenuInline()
  });
}

/* ================= PRODUK ================= */
async function getProdukList() {
  // APK NONTON: A nama, B link, C deskripsi
  const rows = await readSheet("APK NONTON!A2:C");
  return rows.filter(r => (r?.[0] || "").toString().trim() !== "");
}

async function sendProduk(chatId) {
  const list = await getProdukList();
  const buttons = list.map((r, i) => ([{ text: r[0], callback_data: "BUY_" + i }]));

  await tgJson("sendMessage", {
    chat_id: chatId,
    text: "📦 Pilih produk:",
    reply_markup: { inline_keyboard: buttons }
  });
}

/* ================= ORDERS (SHEET) ================= */
async function createPendingOrder({ invoice, chatId, username, productIndex, productName, amount }) {
  await appendRow(SHEET_ORDERS_TAB, [
    new Date().toISOString(), // A created_at
    invoice,                  // B invoice
    String(chatId),           // C chat_id
    username || "",           // D username
    String(productIndex),     // E product_index
    productName,              // F product_name
    String(amount),           // G amount
    "PENDING",                // H status
    ""                        // I paid_at
  ]);
}

async function findOrderRow(invoice) {
  const values = await readSheet(`${SHEET_ORDERS_TAB}!A:I`);
  if (values.length <= 1) return null;

  const rows = values.slice(1);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if ((r[1] || "").toString().trim() === invoice) {
      return {
        rowIndex: i + 2,
        created_at: r[0],
        invoice: r[1],
        chat_id: r[2],
        username: r[3],
        product_index: Number(r[4]),
        product_name: r[5],
        amount: Number(r[6] || 0),
        status: r[7],
        paid_at: r[8]
      };
    }
  }
  return null;
}

async function setOrderStatus(rowIndex, status) {
  await updateCell(SHEET_ORDERS_TAB, `H${rowIndex}`, status);
  if (status === "PAID") {
    await updateCell(SHEET_ORDERS_TAB, `I${rowIndex}`, new Date().toISOString());
  }
}

/* ================= PAKASIR ================= */
function pakasirPayUrl(amount, orderId) {
  return `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_SLUG)}/${amount}?order_id=${encodeURIComponent(orderId)}`;
}

async function pakasirTransactionDetail(amount, orderId) {
  const url =
    `https://app.pakasir.com/api/transactiondetail` +
    `?project=${encodeURIComponent(PAKASIR_SLUG)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&order_id=${encodeURIComponent(orderId)}` +
    `&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;

  const r = await fetch(url);
  return await r.json();
}

/* ================= CHECKOUT (QR + BUTTONS) ================= */
async function startCheckout(chatId, username, index) {
  const list = await getProdukList();
  const produk = list[index];
  if (!produk) return;

  const nama = (produk[0] || "").toString().trim();
  const harga = getHarga(nama);

  const invoice = makeInvoice(index);
  const payUrl = pakasirPayUrl(harga, invoice);

  // simpan order PENDING
  await createPendingOrder({
    invoice,
    chatId,
    username: username || "",
    productIndex: index,
    productName: nama,
    amount: harga
  });

  // QR bayar
  const pngBuffer = await QRCode.toBuffer(payUrl, { type: "png", width: 700, margin: 1 });

  const caption =
    `🧾 Invoice: ${invoice}\n` +
    `📦 Produk: ${nama}\n` +
    `💰 Total: ${rupiah(harga)}\n\n` +
    `Scan QR untuk bayar, atau klik:\n${payUrl}`;

  await tgSendPhotoBuffer(chatId, pngBuffer, caption);

  // tombol status & batal
  await tgJson("sendMessage", {
    chat_id: chatId,
    text: "Menu order:",
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Cek Status", callback_data: `CHECK_${invoice}` }],
        [{ text: "❌ Batalkan", callback_data: `CANCEL_${invoice}` }]
      ]
    }
  });

  await tgJson("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `🆕 Order baru\nInvoice: ${invoice}\nProduk: ${nama}\nUser: @${username || "-"}\nTotal: ${rupiah(harga)}`
  });
}

/* ================= STATUS & CANCEL ================= */
async function checkOrderStatus(chatId, invoice) {
  const order = await findOrderRow(invoice);
  if (!order) {
    await tgJson("sendMessage", { chat_id: chatId, text: "Order tidak ditemukan." });
    return;
  }

  const stLocal = String(order.status || "").toUpperCase();
  if (stLocal === "PAID") {
    await tgJson("sendMessage", { chat_id: chatId, text: `✅ Status ${invoice}: PAID` });
    return;
  }
  if (stLocal === "CANCELLED") {
    await tgJson("sendMessage", { chat_id: chatId, text: `❌ Status ${invoice}: CANCELLED` });
    return;
  }

  const detail = await pakasirTransactionDetail(order.amount, invoice);
  const st = String(detail?.transaction?.status || detail?.status || "unknown").toLowerCase();

  await tgJson("sendMessage", {
    chat_id: chatId,
    text: `Status ${invoice}: ${st}`
  });
}

async function cancelOrder(chatId, invoice) {
  const order = await findOrderRow(invoice);
  if (!order) {
    await tgJson("sendMessage", { chat_id: chatId, text: "Order tidak ditemukan." });
    return;
  }

  if (String(order.chat_id) !== String(chatId)) {
    await tgJson("sendMessage", { chat_id: chatId, text: "Order ini bukan milik kamu." });
    return;
  }

  if (String(order.status).toUpperCase() === "PAID") {
    await tgJson("sendMessage", { chat_id: chatId, text: "Order sudah PAID, tidak bisa dibatalkan." });
    return;
  }

  await setOrderStatus(order.rowIndex, "CANCELLED");

  await tgJson("sendMessage", { chat_id: chatId, text: `✅ Order ${invoice} dibatalkan.` });

  await tgJson("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `❌ Order dibatalkan\nInvoice: ${invoice}\nUser: @${order.username || "-"}`
  });
}

/* ================= DELIVERY (AUTO SEND LINK + ADMIN NOTIF) ================= */
async function deliver(invoice, amountFromWebhook) {
  const order = await findOrderRow(invoice);
  if (!order) {
    await tgJson("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ PAID tapi order tidak ketemu di ${SHEET_ORDERS_TAB}\nInvoice: ${invoice}\nAmount: ${amountFromWebhook}`
    });
    return;
  }

  const stLocal = String(order.status || "").toUpperCase();
  if (stLocal === "PAID") return;
  if (stLocal === "CANCELLED") {
    await tgJson("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ PAID masuk tapi order sudah CANCELLED\nInvoice: ${invoice}`
    });
    return;
  }

  if (Number(order.amount) !== Number(amountFromWebhook)) {
    await tgJson("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Amount mismatch\nInvoice: ${invoice}\nOrders: ${order.amount}\nWebhook: ${amountFromWebhook}`
    });
    return;
  }

  const list = await getProdukList();
  const produk = list[order.product_index];
  if (!produk) {
    await tgJson("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Produk index tidak ditemukan\nInvoice: ${invoice}\nIndex: ${order.product_index}`
    });
    return;
  }

  const nama = (produk[0] || "").toString().trim();
  const link = (produk[1] || "").toString().trim();
  const desk = (produk[2] || "").toString().trim();

  // set PAID
  await setOrderStatus(order.rowIndex, "PAID");

  // catat TRANSAKSI (A-E)
  await appendRow("TRANSAKSI", [
    new Date().toISOString(),
    nama,
    order.username ? `@${order.username}` : "-",
    invoice,
    String(order.amount)
  ]);

  // kirim ke pembeli
  await tgJson("sendMessage", {
    chat_id: order.chat_id,
    text:
      `✅ Pembayaran berhasil!\n\n` +
      `📦 Produk: ${nama}\n` +
      `🧾 Invoice: ${invoice}\n` +
      `💰 Total: ${rupiah(order.amount)}\n\n` +
      `🔗 Link Download:\n${link}\n\n` +
      (desk ? `📝 Deskripsi:\n${desk}\n\n` : "") +
      `Terima kasih 🙏`
  });

  // notif admin transaksi berhasil
  await tgJson("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `✅ TRANSAKSI BERHASIL\n\n` +
      `Invoice: ${invoice}\n` +
      `Produk: ${nama}\n` +
      `User: @${order.username || "-"}\n` +
      `Total: ${rupiah(order.amount)}\n` +
      `Chat ID: ${order.chat_id}`
  });
}

/* ================= ROUTES ================= */
app.get("/", (req, res) => res.send("OK"));

app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    if (update.message?.text === "/start") {
      await sendStart(update.message.chat.id);
      return res.sendStatus(200);
    }

    if (update.callback_query) {
      const chatId = update.callback_query.message.chat.id;
      const data = update.callback_query.data;
      const username = update.callback_query.from?.username || "";

      await tgJson("answerCallbackQuery", { callback_query_id: update.callback_query.id });

      if (data === "MENU_PRODUK") {
        await sendProduk(chatId);
        return res.sendStatus(200);
      }
      if (data === "MENU_INFO") {
        await tgJson("sendMessage", {
          chat_id: chatId,
          text: "ℹ️ INFO\n\n• Pembayaran via Pakasir\n• Link otomatis dikirim setelah sukses\n• Jika kendala, chat admin."
        });
        return res.sendStatus(200);
      }
      if (data === "MENU_CARA") {
        await tgJson("sendMessage", {
          chat_id: chatId,
          text: "📌 CARA ORDER\n\n1) Klik 📦 Produk\n2) Pilih produk\n3) Scan QR / klik bayar\n4) Setelah sukses, link otomatis dikirim ✅"
        });
        return res.sendStatus(200);
      }

      if (data.startsWith("BUY_")) {
        const index = Number(data.replace("BUY_", ""));
        await startCheckout(chatId, username, index);
        return res.sendStatus(200);
      }

      if (data.startsWith("CHECK_")) {
        const invoice = data.replace("CHECK_", "");
        await checkOrderStatus(chatId, invoice);
        return res.sendStatus(200);
      }

      if (data.startsWith("CANCEL_")) {
        const invoice = data.replace("CANCEL_", "");
        await cancelOrder(chatId, invoice);
        return res.sendStatus(200);
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error("telegram error:", e);
    res.sendStatus(200);
  }
});

app.post(`/pakasir/webhook/${PAKASIR_WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const { order_id, amount } = req.body || {};
    res.sendStatus(200);

    if (!order_id || !amount) return;

    // validasi ke Pakasir (lebih aman)
    const detail = await pakasirTransactionDetail(amount, order_id);
    const status = String(detail?.transaction?.status || "").toLowerCase();
    if (status !== "completed") return;

    await deliver(order_id, amount);
  } catch (e) {
    console.error("pakasir error:", e);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running..."));
