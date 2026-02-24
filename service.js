import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import crypto from "crypto";

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
];

for (const k of REQUIRED_ENVS) {
  if (!process.env[k]) {
    console.error("Missing ENV:", k);
    process.exit(1);
  }
}

const {
  BOT_TOKEN,
  ADMIN_CHAT_ID,
  GOOGLE_SERVICE_ACCOUNT_JSON,
  SHEET_ID,
  PAYMENT_PROJECT_SLUG,
  PAYMENT_API_KEY,
} = process.env;

const SPAM_STRIKES_TO_BAN = Number(process.env.SPAM_STRIKES_TO_BAN || 3);

/* ================= TELEGRAM ================= */
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
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

async function read(range) {
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });
  return r.data.values || [];
}

async function append(range, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

async function update(range, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] },
  });
}

async function clearRow(tab, rowIndex, colEndLetter) {
  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A${rowIndex}:${colEndLetter}${rowIndex}`,
  });
}

/* ================= CONSTANT TAB ================= */
const TAB_MEMBER = "MEMBER LIST";
const TAB_TX = "TRANSAKSI";
const TAB_TX_SUCCESS = "TRANSAKSI BERHASIL";
const TAB_TX_FAIL = "TRANSAKSI GAGAL";
const TAB_CATEGORY = "CATEGORIES";
const TAB_BANNED = "BANNED";

/* ================= HELPERS ================= */
function nowISO() {
  return new Date().toISOString();
}

function displayUser(username, chatId) {
  const u = username ? `@${username}` : "-";
  return `${u} | ${chatId}`;
}

function parseChatIdFromDisplay(display) {
  // format: "@username | 123456"
  const parts = String(display || "").split("|").map(s => s.trim());
  const maybe = parts[parts.length - 1];
  const n = Number(maybe);
  return Number.isFinite(n) ? String(n) : null;
}

function normalizeStatus(s) {
  return String(s || "").trim().toUpperCase();
}

/* ================= MEMBER SYSTEM ================= */
async function addMember(chatId, username) {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  const exists = rows.some(r => String(r[2] || "").includes(String(chatId)));
  if (exists) return;

  const nomor = rows.length; // termasuk header
  await append(`${TAB_MEMBER}!A:C`, [
    nomor,
    new Date().toISOString().slice(0, 10),
    displayUser(username, chatId),
  ]);
}

async function isBanned(chatId) {
  const rows = await read(`${TAB_BANNED}!A:C`);
  return rows.some(r => String(r[0]) === String(chatId));
}

async function banUser(chatId, reason) {
  const already = await isBanned(chatId);
  if (already) return;

  await append(`${TAB_BANNED}!A:C`, [
    String(chatId),
    reason || "No reason",
    nowISO(),
  ]);
}

async function unbanUser(chatId) {
  const rows = await read(`${TAB_BANNED}!A:C`);
  const index = rows.findIndex(r => String(r[0]) === String(chatId));
  if (index >= 0) {
    // +1 untuk header row spreadsheet (rowIndex = index+1)
    await clearRow(TAB_BANNED, index + 1, "C");
  }
}

/* ================= CATEGORY ================= */
async function getCategories() {
  const rows = await read(`${TAB_CATEGORY}!A:B`);
  return rows.slice(1).map(r => r[0]).filter(Boolean);
}

async function getProducts(category) {
  const rows = await read(`${category}!A:F`);
  return rows.slice(1).map((r, i) => ({
    id: r[0],
    name: r[1],
    link: r[2],
    desc: r[3],
    stock: r[4],
    price: r[5],
    rowIndex: i + 2,
    tab: category,
  }));
}

/* ================= PAYMENT (PAKASIR) =================
  - Create: POST https://app.pakasir.com/api/transactioncreate/qris
  - Detail: GET  https://app.pakasir.com/api/transactiondetail?project=...&amount=...&order_id=...&api_key=...
*/
async function createPakasirQRIS(amount, orderId) {
  const url = "https://app.pakasir.com/api/transactioncreate/qris";
  const body = {
    project: PAYMENT_PROJECT_SLUG,
    order_id: orderId,
    amount: Number(amount),
    api_key: PAYMENT_API_KEY,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => ({}));
  return json;
}

async function getPaymentDetail(amount, invoice) {
  const url =
    `https://app.pakasir.com/api/transactiondetail` +
    `?project=${encodeURIComponent(PAYMENT_PROJECT_SLUG)}` +
    `&amount=${encodeURIComponent(amount)}` +
    `&order_id=${encodeURIComponent(invoice)}` +
    `&api_key=${encodeURIComponent(PAYMENT_API_KEY)}`;

  const res = await fetch(url);
  return res.json();
}

function buildQrImageUrlFromQrString(qrString) {
  // Pakasir API mengirim payment_number (string QR). Kita render jadi gambar via layanan QR image.
  // (Alternatif: bikin QR sendiri pakai library, tapi ini paling simpel.)
  return `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(
    qrString
  )}`;
}

/* ================= TRANSAKSI (SHEET 7 KOLOM) =================
A tanggal
B id produk
C nama produk
D username/id pembeli  => "@user | chatId"
E invoice
F harga (amount item)
G status
*/
async function createTransaction(product, chatId, username) {
  const invoice = "INV-" + Date.now() + "-" + crypto.randomBytes(2).toString("hex");

  await append(`${TAB_TX}!A:G`, [
    nowISO(),
    product.id,
    product.name,
    displayUser(username, chatId),
    invoice,
    String(product.price),
    "PENDING",
  ]);

  return invoice;
}

async function findTransactionInTab(tab, invoice) {
  const rows = await read(`${tab}!A:G`);
  for (let i = 1; i < rows.length; i++) {
    const inv = rows[i][4]; // kolom E
    if (String(inv) === String(invoice)) {
      return { rowIndex: i + 1, data: rows[i] };
    }
  }
  return null;
}

async function findTransaction(invoice) {
  return findTransactionInTab(TAB_TX, invoice);
}

async function markSuccess(rowIndex, rowData) {
  // update status (kolom G)
  await update(`${TAB_TX}!G${rowIndex}`, "SUCCESS");
  // salin ke sheet berhasil
  const newRow = [...rowData];
  newRow[6] = "SUCCESS";
  await append(`${TAB_TX_SUCCESS}!A:G`, newRow);
  // hapus dari transaksi pending
  await clearRow(TAB_TX, rowIndex, "G");
}

async function markFailed(rowIndex, rowData, statusText = "FAILED") {
  await update(`${TAB_TX}!G${rowIndex}`, statusText);
  const newRow = [...rowData];
  newRow[6] = statusText;
  await append(`${TAB_TX_FAIL}!A:G`, newRow);
  await clearRow(TAB_TX, rowIndex, "G");
}

/* ================= AUTO QRIS ================= */
async function sendQRIS(chatId, product, invoice) {
  // Buat transaksi QRIS di Pakasir (API create)
  const created = await createPakasirQRIS(product.price, invoice);

  const payment = created?.payment || created?.transaction || null;
  const qrString = payment?.payment_number || null; // dari docs: payment_number
  const totalPayment = payment?.total_payment || product.price;

  if (!qrString) {
    await tg("sendMessage", {
      chat_id: chatId,
      text:
        "⚠️ Gagal membuat QRIS.\n\n" +
        "Coba lagi beberapa saat, atau hubungi admin.",
    });

    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Gagal create QRIS untuk invoice ${invoice}\nResponse: ${JSON.stringify(created).slice(0, 1500)}`,
    });

    return;
  }

  const qrImageUrl = buildQrImageUrlFromQrString(qrString);

  await tg("sendPhoto", {
    chat_id: chatId,
    photo: qrImageUrl,
    caption:
      `🧾 Invoice: ${invoice}\n` +
      `📦 Produk: ${product.name}\n` +
      `💰 Total Bayar (termasuk fee): Rp ${Number(totalPayment).toLocaleString("id-ID")}\n\n` +
      `Silakan scan QRIS di atas.\n` +
      `Setelah bayar, bot akan otomatis kirim produk (atau klik cek status).`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔄 Cek Status", callback_data: `CEK_${invoice}` }],
      ],
    },
  });
}

/* ================= DELIVERY CORE ================= */
async function getProductById(productId) {
  const categories = await getCategories();
  for (const cat of categories) {
    const prods = await getProducts(cat);
    const found = prods.find(p => String(p.id) === String(productId));
    if (found) return found;
  }
  return null;
}

async function deliverProduct(row) {
  const productId = row[1]; // kolom B
  const buyerDisplay = row[3]; // kolom D "@u | chatId"
  const chatId = parseChatIdFromDisplay(buyerDisplay);

  if (!chatId) {
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Gagal deliver: chat_id tidak terbaca.\nBuyer: ${buyerDisplay}\nInvoice: ${row[4]}`,
    });
    return { ok: false, reason: "CHAT_ID_NOT_FOUND" };
  }

  const product = await getProductById(productId);
  if (!product) {
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `⚠️ Produk tidak ditemukan untuk invoice ${row[4]} (productId: ${productId})`,
    });
    return { ok: false, reason: "PRODUCT_NOT_FOUND" };
  }

  // Kurangi stock jika bukan unlimited
  if (String(product.stock).toUpperCase() !== "UNLIMITED") {
    const current = Number(product.stock || 0);
    if (current > 0) {
      await update(`${product.tab}!E${product.rowIndex}`, current - 1);
    } else {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "⚠️ Maaf, stok habis. Hubungi admin untuk bantuan.",
      });
      await tg("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text: `⚠️ Stok habis saat deliver.\nProduk: ${product.name}\nInvoice: ${row[4]}`,
      });
      return { ok: false, reason: "OUT_OF_STOCK" };
    }
  }

  await tg("sendMessage", {
    chat_id: chatId,
    text:
      `✅ Pembayaran Berhasil!\n\n` +
      `📦 ${product.name}\n\n` +
      `🔗 Link Download:\n${product.link}`,
  });

  return { ok: true };
}

/* ================= CEK STATUS & DELIVER ================= */
async function checkAndDeliver(chatId, invoice) {
  // 1) Cari di pending
  const tx = await findTransaction(invoice);

  // Kalau tidak ada, cek apakah sudah sukses sebelumnya
  if (!tx) {
    const done = await findTransactionInTab(TAB_TX_SUCCESS, invoice);
    if (done) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "✅ Transaksi ini sudah SUCCESS sebelumnya. Silakan cek pesan link produk ya.",
      });
      return;
    }

    const failed = await findTransactionInTab(TAB_TX_FAIL, invoice);
    if (failed) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "❌ Transaksi ini sudah tercatat GAGAL/EXPIRED.",
      });
      return;
    }

    await tg("sendMessage", {
      chat_id: chatId,
      text: "Invoice tidak ditemukan.",
    });
    return;
  }

  const row = tx.data;

  // Anti double
  if (normalizeStatus(row[6]) === "SUCCESS") {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "✅ Transaksi sudah berhasil sebelumnya.",
    });
    return;
  }

  const amount = row[5];   // kolom F
  const detail = await getPaymentDetail(amount, invoice);

  const status = normalizeStatus(detail?.transaction?.status || detail?.status);

  if (status === "COMPLETED") {
    const delivered = await deliverProduct(row);

    if (delivered.ok) {
      await markSuccess(tx.rowIndex, row);
    } else {
      // kalau gagal deliver (mis stok habis dsb), jangan mark success dulu
      await tg("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text: `⚠️ Pembayaran completed tapi deliver gagal (${delivered.reason}). Invoice: ${invoice}`,
      });
    }

    return;
  }

  if (status === "EXPIRED" || status === "FAILED" || status === "CANCELLED" || status === "CANCELED") {
    await markFailed(tx.rowIndex, row, status);
    await tg("sendMessage", { chat_id: chatId, text: `❌ Transaksi ${status}.` });
    return;
  }

  await tg("sendMessage", {
    chat_id: chatId,
    text: "Status: " + (status || "MENUNGGU PEMBAYARAN"),
  });
}

/* ================= ANTI SPAM (AUTO BAN) =================
  - Rate limit per chat untuk message & callback
  - Jika melanggar berkali-kali -> auto ban ke sheet BANNED
*/
const spamState = new Map();
/*
spamState.get(chatId) = {
  msg: { count, ts },
  cb: { count, ts },
  strikes,
  lastStrikeAt
}
*/

function getSpam(chatId) {
  const key = String(chatId);
  if (!spamState.has(key)) {
    spamState.set(key, {
      msg: { count: 0, ts: Date.now() },
      cb: { count: 0, ts: Date.now() },
      strikes: 0,
      lastStrikeAt: 0,
    });
  }
  return spamState.get(key);
}

function hitLimiter(bucket, limit, windowMs) {
  const now = Date.now();
  if (now - bucket.ts > windowMs) {
    bucket.ts = now;
    bucket.count = 0;
  }
  bucket.count += 1;
  return bucket.count > limit;
}

async function handleSpamViolation(chatId, reason) {
  const s = getSpam(chatId);
  const now = Date.now();

  // reset strike cooldown (mis 10 menit)
  if (now - s.lastStrikeAt > 10 * 60 * 1000) {
    s.strikes = 0;
  }

  s.strikes += 1;
  s.lastStrikeAt = now;

  if (s.strikes >= SPAM_STRIKES_TO_BAN) {
    await banUser(chatId, `AutoBan Spam: ${reason}`);
    await tg("sendMessage", {
      chat_id: chatId,
      text: "❌ Kamu diblokir otomatis karena spam.",
    });
    await tg("sendMessage", {
      chat_id: ADMIN_CHAT_ID,
      text: `🚫 AutoBan spam\nChat: ${chatId}\nReason: ${reason}\nStrikes: ${s.strikes}`,
    });
    return true;
  } else {
    await tg("sendMessage", {
      chat_id: chatId,
      text: `⚠️ Jangan spam ya. (Peringatan ${s.strikes}/${SPAM_STRIKES_TO_BAN})`,
    });
    return false;
  }
}

/* ================= PAKASIR WEBHOOK =================
Body contoh:
{
  "amount": 22000,
  "order_id": "...",
  "project": "...",
  "status": "completed",
  "payment_method": "qris",
  "completed_at": "..."
}
*/
app.post("/pakasir/webhook", async (req, res) => {
  try {
    // balas cepat dulu
    res.sendStatus(200);

    const body = req.body || {};
    const invoice = body.order_id;
    const amount = body.amount;
    const status = normalizeStatus(body.status);

    if (!invoice || !amount) return;

    // optional: pastikan project cocok
    if (body.project && String(body.project) !== String(PAYMENT_PROJECT_SLUG)) {
      return;
    }

    // hanya proses completed
    if (status !== "COMPLETED") return;

    const tx = await findTransaction(invoice);
    if (!tx) return;

    // validasi sesuai saran pakasir: amount + order_id harus match
    const row = tx.data;
    const sheetAmount = String(row[5]); // kolom F
    if (String(sheetAmount) !== String(amount)) {
      await tg("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text: `⚠️ Webhook amount mismatch\nInvoice: ${invoice}\nWebhook: ${amount}\nSheet: ${sheetAmount}`,
      });
      return;
    }

    const delivered = await deliverProduct(row);
    if (delivered.ok) {
      await markSuccess(tx.rowIndex, row);
    }
  } catch (e) {
    console.log("WEBHOOK ERROR:", e?.message);
  }
});

/* ================= TELEGRAM MAIN HANDLER ================= */
app.post("/", async (req, res) => {
  try {
    const msg = req.body.message;
    const cb = req.body.callback_query;

    /* ========= CALLBACK ========= */
    if (cb) {
      const chatId = cb.message.chat.id;
      const data = cb.data;

      if (await isBanned(chatId)) return res.sendStatus(200);

      // rate limit callback (contoh: max 12 klik / 10 detik)
      const s = getSpam(chatId);
      const violated = hitLimiter(s.cb, 12, 10_000);
      if (violated) {
        await handleSpamViolation(chatId, "Callback spam");
        return res.sendStatus(200);
      }

      // CATEGORY BUTTON
      if (data.startsWith("CAT_")) {
        const cat = data.replace("CAT_", "");
        const products = await getProducts(cat);

        const buttons = products.map(p => ([
          {
            text: `${p.name} - Rp ${Number(p.price).toLocaleString("id-ID")}`,
            callback_data: `BUY_${cat}_${p.id}`,
          },
        ]));

        await tg("sendMessage", {
          chat_id: chatId,
          text: `📦 Produk ${cat}`,
          reply_markup: { inline_keyboard: buttons },
        });
      }

      // BUY BUTTON
      else if (data.startsWith("BUY_")) {
        const parts = data.split("_");
        const cat = parts[1];
        const id = parts[2];

        const products = await getProducts(cat);
        const product = products.find(p => String(p.id) === String(id));

        if (!product) return res.sendStatus(200);

        // stok 0 -> tolak (kecuali unlimited)
        if (String(product.stock).toUpperCase() !== "UNLIMITED") {
          const current = Number(product.stock || 0);
          if (current <= 0) {
            await tg("sendMessage", {
              chat_id: chatId,
              text: "⚠️ Stok produk ini sedang habis.",
            });
            return res.sendStatus(200);
          }
        }

        const invoice = await createTransaction(product, chatId, cb.from.username);
        await sendQRIS(chatId, product, invoice);
      }

      // CEK STATUS BUTTON
      else if (data.startsWith("CEK_")) {
        const invoice = data.replace("CEK_", "");
        await checkAndDeliver(chatId, invoice);
      }

      return res.sendStatus(200);
    }

    /* ========= MESSAGE ========= */
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const text = msg.text || "";
    const username = msg.from.username;

    if (await isBanned(chatId)) {
      await tg("sendMessage", { chat_id: chatId, text: "❌ Kamu diblokir." });
      return res.sendStatus(200);
    }

    // rate limit message (contoh: max 8 pesan / 10 detik)
    const s = getSpam(chatId);
    const violated = hitLimiter(s.msg, 8, 10_000);
    if (violated) {
      await handleSpamViolation(chatId, "Message spam");
      return res.sendStatus(200);
    }

    if (text === "/start") {
      await addMember(chatId, username);

      const categories = await getCategories();
      const buttons = categories.map(c => ([
        { text: c, callback_data: `CAT_${c}` },
      ]));

      await tg("sendMessage", {
        chat_id: chatId,
        text: "Selamat datang 👋\nPilih kategori:",
        reply_markup: { inline_keyboard: buttons },
      });

      return res.sendStatus(200);
    }

    /* ========= ADMIN COMMAND ========= */
    if (String(chatId) === String(ADMIN_CHAT_ID)) {
      if (text.startsWith("/ban ")) {
        const id = text.split(" ")[1];
        await banUser(id, "Admin ban");
        await tg("sendMessage", { chat_id: chatId, text: "User diban." });
      }

      if (text.startsWith("/unban ")) {
        const id = text.split(" ")[1];
        await unbanUser(id);
        await tg("sendMessage", { chat_id: chatId, text: "User di-unban." });
      }

      if (text === "/dashboard") {
        const success = await read(`${TAB_TX_SUCCESS}!A:G`);
        const fail = await read(`${TAB_TX_FAIL}!A:G`);

        await tg("sendMessage", {
          chat_id: chatId,
          text:
            `📊 Dashboard\n\n` +
            `✅ Berhasil: ${Math.max(success.length - 1, 0)}\n` +
            `❌ Gagal: ${Math.max(fail.length - 1, 0)}`,
        });
      }
    }

    return res.sendStatus(200);
  } catch (err) {
    console.log("ERROR:", err?.message);
    return res.sendStatus(200);
  }
});

/* ================= SERVER ================= */
app.get("/", (req, res) => res.send("BOT RUNNING"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Server started");
});
