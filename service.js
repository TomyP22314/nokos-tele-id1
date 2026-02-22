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

const ADMIN_ID = String(ADMIN_CHAT_ID);
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
  form.append("photo", buffer, { filename: "qr.png", contentType: "image/png" });
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

function makeInvoice(index) {
  const rand = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `INV${index}-${Date.now()}-${rand}`;
}

function isAdmin(chatId) {
  return String(chatId) === ADMIN_ID;
}

/* ================= UI START ================= */
function startMenuInline(is_admin = false) {
  const rows = [
    [{ text: "📦 Produk", callback_data: "MENU_PRODUK" }],
    [{ text: "ℹ️ Info", callback_data: "MENU_INFO" }, { text: "📌 Cara Order", callback_data: "MENU_CARA" }]
  ];
  if (is_admin) rows.push([{ text: "🛠 Admin Panel", callback_data: "ADMIN_PANEL" }]);
  return { inline_keyboard: rows };
}

async function sendStart(chatId) {
  if (BANNER_URL) {
    await tgJson("sendPhoto", {
      chat_id: chatId,
      photo: BANNER_URL,
      caption: "🎉 Selamat datang!"
    });
  }

  await tgJson("sendMessage", {
    chat_id: chatId,
    text:
      `👋 Selamat datang di toko!\n\n` +
      `✅ Produk digital siap kirim otomatis\n` +
      `💳 Pembayaran via QR\n\n` +
      `Pilih menu di bawah:`,
    reply_markup: startMenuInline(isAdmin(chatId))
  });
}

/* ================= PRODUK (APK NONTON) =================
   Format tab: A Nama, B Link, C Deskripsi, D STOCK (optional)
   - D kosong / "UNLIMITED" => unlimited
   - D angka => stok terbatas
*/
async function getProdukListWithRowIndex() {
  // Ambil A:D supaya dapat stock
  const rows = await readSheet("APK NONTON!A2:D");
  const list = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || [];
    const nama = (r[0] || "").toString().trim();
    if (!nama) continue;

    const link = (r[1] || "").toString().trim();
    const desk = (r[2] || "").toString().trim();
    const stockRaw = (r[3] || "").toString().trim();

    list.push({
      rowIndex: i + 2, // karena mulai A2
      nama,
      link,
      desk,
      stockRaw
    });
  }
  return list;
}

function parseStock(stockRaw) {
  const s = (stockRaw || "").toString().trim().toUpperCase();
  if (!s || s === "UNLIMITED" || s === "∞") return { mode: "UNLIMITED", value: null };
  const n = Number(s);
  if (Number.isFinite(n)) return { mode: "LIMITED", value: Math.max(0, Math.floor(n)) };
  return { mode: "UNLIMITED", value: null };
}

function stockText(stockRaw) {
  const st = parseStock(stockRaw);
  if (st.mode === "UNLIMITED") return "♾️ Ready";
  return st.value > 0 ? `🟢 Stok: ${st.value}` : "🔴 Stok habis";
}

async function sendProduk(chatId) {
  const list = await getProdukListWithRowIndex();

  const buttons = [];
  let text = "📦 List Produk:\n\n";
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    const st = parseStock(p.stockRaw);
    const harga = getHarga(p.nama);
    text += `• ${p.nama} — ${rupiah(harga)} — ${stockText(p.stockRaw)}\n`;
    const canBuy = st.mode === "UNLIMITED" || (st.value && st.value > 0);
    if (canBuy) buttons.push([{ text: `Beli ${p.nama}`, callback_data: "BUY_" + i }]);
  }

  text += "\nKlik tombol untuk beli.";

  await tgJson("sendMessage", {
    chat_id: chatId,
    text,
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

/* ================= PAYMENT (under the hood) =================
   Tampilan ke user: "Pembayaran via QR"
*/
function payUrl(amount, orderId) {
  return `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_SLUG)}/${amount}?order_id=${encodeURIComponent(orderId)}`;
}

async function transactionDetail(amount, orderId) {
  const url =
    `https://app.pakasir.com/api/transactiondetail` +
    `?project=${encodeURIComponent(PAKASIR_SLUG)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&order_id=${encodeURIComponent(orderId)}` +
    `&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;

  const r = await fetch(url);
  return await r.json();
}

/* ================= STOCK UPDATE =================
   Kolom D adalah STOCK. RowIndex produk ada di object produk.
*/
async function setStockByRow(rowIndex, newValue) {
  // D{rowIndex}
  await updateCell("APK NONTON", `D${rowIndex}`, newValue);
}

async function decrementStockIfLimited(product) {
  const st = parseStock(product.stockRaw);
  if (st.mode === "UNLIMITED") return; // tidak berkurang

  const next = Math.max(0, (st.value || 0) - 1);
  await setStockByRow(product.rowIndex, String(next));
}

/* ================= CHECKOUT (QR + BUTTONS) ================= */
async function startCheckout(chatId, username, index) {
  const list = await getProdukListWithRowIndex();
  const produk = list[index];
  if (!produk) return;

  const st = parseStock(produk.stockRaw);
  if (st.mode === "LIMITED" && (!st.value || st.value <= 0)) {
    await tgJson("sendMessage", { chat_id: chatId, text: "Maaf, stok habis 🙏" });
    return;
  }

  const harga = getHarga(produk.nama);
  const invoice = makeInvoice(index);
  const url = payUrl(harga, invoice);

  await createPendingOrder({
    invoice,
    chatId,
    username: username || "",
    productIndex: index,
    productName: produk.nama,
    amount: harga
  });

  const pngBuffer = await QRCode.toBuffer(url, { type: "png", width: 700, margin: 1 });

  const caption =
    `🧾 Invoice: ${invoice}\n` +
    `📦 Produk: ${produk.nama}\n` +
    `💰 Total: ${rupiah(harga)}\n\n` +
    `✅ Pembayaran via QR\n` +
    `Atau klik link:\n${url}`;

  await tgSendPhotoBuffer(chatId, pngBuffer, caption);

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

  // admin notif order baru
  await tgJson("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: `🆕 Order baru\nInvoice: ${invoice}\nProduk: ${produk.nama}\nUser: @${username || "-"}\nTotal: ${rupiah(harga)}`
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
    await tgJson("sendMessage", { chat_id: chatId, text: `✅ Status ${invoice}: BERHASIL` });
    return;
  }
  if (stLocal === "CANCELLED") {
    await tgJson("sendMessage", { chat_id: chatId, text: `❌ Status ${invoice}: DIBATALKAN` });
    return;
  }

  const detail = await transactionDetail(order.amount, invoice);
  const st = String(detail?.transaction?.status || detail?.status || "unknown").toLowerCase();

  await tgJson("sendMessage", { chat_id: chatId, text: `Status ${invoice}: ${st}` });
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
    await tgJson("sendMessage", { chat_id: chatId, text: "Order sudah berhasil, tidak bisa dibatalkan." });
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
      text: `⚠️ Pembayaran masuk tapi order tidak ketemu\nInvoice: ${invoice}\nAmount: ${amountFromWebhook}`
    });
    return;
  }

  const stLocal = String(order.status || "").toUpperCase();
  if (stLocal === "PAID") return;
  if (stLocal === "CANCELLED") {
    await tgJson("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Pembayaran masuk tapi order sudah dibatalkan\nInvoice: ${invoice}`
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

  const list = await getProdukListWithRowIndex();
  const produk = list[order.product_index];
  if (!produk) {
    await tgJson("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Produk index tidak ditemukan\nInvoice: ${invoice}\nIndex: ${order.product_index}`
    });
    return;
  }

  // set PAID
  await setOrderStatus(order.rowIndex, "PAID");

  // kurangi stok kalau LIMITED
  await decrementStockIfLimited(produk);

  // catat TRANSAKSI (A-E)
  await appendRow("TRANSAKSI", [
    new Date().toISOString(),
    produk.nama,
    order.username ? `@${order.username}` : "-",
    invoice,
    String(order.amount)
  ]);

  // kirim ke pembeli
  await tgJson("sendMessage", {
    chat_id: order.chat_id,
    text:
      `✅ Transaksi berhasil!\n\n` +
      `📦 Produk: ${produk.nama}\n` +
      `🧾 Invoice: ${invoice}\n` +
      `💰 Total: ${rupiah(order.amount)}\n\n` +
      `🔗 Link Download:\n${produk.link}\n\n` +
      (produk.desk ? `📝 Deskripsi:\n${produk.desk}\n\n` : "") +
      `Terima kasih 🙏`
  });

  // ADMIN notif transaksi berhasil
  await tgJson("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text:
      `✅ TRANSAKSI BERHASIL\n\n` +
      `Invoice: ${invoice}\n` +
      `Produk: ${produk.nama}\n` +
      `User: @${order.username || "-"}\n` +
      `Total: ${rupiah(order.amount)}\n` +
      `Sisa stok: ${stockText((await getProdukListWithRowIndex())[order.product_index]?.stockRaw)}`
  });
}

/* ================= ADMIN PANEL ================= */
async function adminPanel(chatId) {
  if (!isAdmin(chatId)) return;

  const list = await getProdukListWithRowIndex();
  const buttons = list.map((p, i) => ([{ text: `✏️ Stok ${p.nama}`, callback_data: `ADMIN_STOCK_${i}` }]));

  await tgJson("sendMessage", {
    chat_id: chatId,
    text: "🛠 Admin Panel\nPilih produk untuk edit stok:",
    reply_markup: { inline_keyboard: buttons }
  });
}

async function adminStockMenu(chatId, index) {
  if (!isAdmin(chatId)) return;

  const list = await getProdukListWithRowIndex();
  const p = list[index];
  if (!p) return;

  const st = parseStock(p.stockRaw);
  const info = st.mode === "UNLIMITED" ? "UNLIMITED" : String(st.value);

  await tgJson("sendMessage", {
    chat_id: chatId,
    text: `📦 ${p.nama}\nStok sekarang: ${info}\n\nPilih aksi:`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "➕ +1", callback_data: `ADMIN_STOCK_ADD_${index}` },
          { text: "➖ -1", callback_data: `ADMIN_STOCK_SUB_${index}` }
        ],
        [
          { text: "♾️ Set UNLIMITED", callback_data: `ADMIN_STOCK_UNL_${index}` },
          { text: "0️⃣ Set 0", callback_data: `ADMIN_STOCK_SET0_${index}` }
        ],
        [{ text: "🔙 Kembali", callback_data: "ADMIN_PANEL" }]
      ]
    }
  });
}

async function adminStockUpdate(chatId, action, index) {
  if (!isAdmin(chatId)) return;

  const list = await getProdukListWithRowIndex();
  const p = list[index];
  if (!p) return;

  const st = parseStock(p.stockRaw);

  if (action === "UNL") {
    await setStockByRow(p.rowIndex, "UNLIMITED");
  } else if (action === "SET0") {
    await setStockByRow(p.rowIndex, "0");
  } else if (action === "ADD") {
    if (st.mode === "UNLIMITED") {
      // biarkan unlimited
      await setStockByRow(p.rowIndex, "UNLIMITED");
    } else {
      await setStockByRow(p.rowIndex, String((st.value || 0) + 1));
    }
  } else if (action === "SUB") {
    if (st.mode === "UNLIMITED") {
      // kalau unlimited dikurangi -> set 0 (biar jelas)
      await setStockByRow(p.rowIndex, "0");
    } else {
      await setStockByRow(p.rowIndex, String(Math.max(0, (st.value || 0) - 1)));
    }
  }

  await tgJson("sendMessage", { chat_id: chatId, text: "✅ Stok berhasil diupdate." });
  await adminStockMenu(chatId, index);
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

    // optional: admin bisa ketik /admin
    if (update.message?.text === "/admin") {
      if (isAdmin(update.message.chat.id)) await adminPanel(update.message.chat.id);
      return res.sendStatus(200);
    }

    if (update.callback_query) {
      const chatId = update.callback_query.message.chat.id;
      const data = update.callback_query.data;
      const username = update.callback_query.from?.username || "";

      await tgJson("answerCallbackQuery", { callback_query_id: update.callback_query.id });

      // Menu utama
      if (data === "MENU_PRODUK") { await sendProduk(chatId); return res.sendStatus(200); }
      if (data === "MENU_INFO") {
        await tgJson("sendMessage", {
          chat_id: chatId,
          text: "ℹ️ INFO\n\n• Pembayaran via QR\n• Link dikirim otomatis setelah berhasil\n• Jika kendala, hubungi admin."
        });
        return res.sendStatus(200);
      }
      if (data === "MENU_CARA") {
        await tgJson("sendMessage", {
          chat_id: chatId,
          text: "📌 CARA ORDER\n\n1) Klik 📦 Produk\n2) Pilih produk\n3) Scan QR / klik link bayar\n4) Setelah berhasil, link otomatis dikirim ✅"
        });
        return res.sendStatus(200);
      }

      // Admin panel
      if (data === "ADMIN_PANEL") { await adminPanel(chatId); return res.sendStatus(200); }

      if (data.startsWith("ADMIN_STOCK_") && !data.startsWith("ADMIN_STOCK_ADD_") && !data.startsWith("ADMIN_STOCK_SUB_") && !data.startsWith("ADMIN_STOCK_UNL_") && !data.startsWith("ADMIN_STOCK_SET0_")) {
        const index = Number(data.replace("ADMIN_STOCK_", ""));
        await adminStockMenu(chatId, index);
        return res.sendStatus(200);
      }

      if (data.startsWith("ADMIN_STOCK_ADD_")) {
        const index = Number(data.replace("ADMIN_STOCK_ADD_", ""));
        await adminStockUpdate(chatId, "ADD", index);
        return res.sendStatus(200);
      }
      if (data.startsWith("ADMIN_STOCK_SUB_")) {
        const index = Number(data.replace("ADMIN_STOCK_SUB_", ""));
        await adminStockUpdate(chatId, "SUB", index);
        return res.sendStatus(200);
      }
      if (data.startsWith("ADMIN_STOCK_UNL_")) {
        const index = Number(data.replace("ADMIN_STOCK_UNL_", ""));
        await adminStockUpdate(chatId, "UNL", index);
        return res.sendStatus(200);
      }
      if (data.startsWith("ADMIN_STOCK_SET0_")) {
        const index = Number(data.replace("ADMIN_STOCK_SET0_", ""));
        await adminStockUpdate(chatId, "SET0", index);
        return res.sendStatus(200);
      }

      // Beli
      if (data.startsWith("BUY_")) {
        const index = Number(data.replace("BUY_", ""));
        await startCheckout(chatId, username, index);
        return res.sendStatus(200);
      }

      // Cek status
      if (data.startsWith("CHECK_")) {
        const invoice = data.replace("CHECK_", "");
        await checkOrderStatus(chatId, invoice);
        return res.sendStatus(200);
      }

      // Cancel
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

    // validasi via transactiondetail
    const detail = await transactionDetail(amount, order_id);
    const status = String(detail?.transaction?.status || "").toLowerCase();
    if (status !== "completed") return;

    await deliver(order_id, amount);
  } catch (e) {
    console.error("payment webhook error:", e);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Server running..."));
