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
  "PAYMENT_PROJECT_SLUG",
  "PAYMENT_API_KEY"
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
  PAYMENT_API_KEY
} = process.env;

/* ================= TELEGRAM ================= */
async function tg(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
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
    range
  });
  return r.data.values || [];
}

async function append(range, row) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

async function update(range, value) {
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] }
  });
}

/* ================= CONSTANT TAB ================= */
const TAB_MEMBER = "MEMBER LIST";
const TAB_TX = "TRANSAKSI";
const TAB_TX_SUCCESS = "TRANSAKSI BERHASIL";
const TAB_TX_FAIL = "TRANSAKSI GAGAL";
const TAB_CATEGORY = "CATEGORIES";
const TAB_BANNED = "BANNED";
/* ================= MEMBER SYSTEM ================= */

async function addMember(chatId, username) {
  const rows = await read(`${TAB_MEMBER}!A:C`);
  const exists = rows.find(r => String(r[2]) === String(chatId));
  if (exists) return;

  const nomor = rows.length;
  await append(`${TAB_MEMBER}!A:C`, [
    nomor,
    new Date().toISOString(),
    username ? `@${username}` : chatId
  ]);
}

async function isBanned(chatId) {
  const rows = await read(`${TAB_BANNED}!A:C`);
  return rows.some(r => String(r[0]) === String(chatId));
}

async function banUser(chatId, reason) {
  await append(`${TAB_BANNED}!A:C`, [
    chatId,
    reason || "No reason",
    new Date().toISOString()
  ]);
}

async function unbanUser(chatId) {
  const rows = await read(`${TAB_BANNED}!A:C`);
  const index = rows.findIndex(r => String(r[0]) === String(chatId));
  if (index >= 0) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId: SHEET_ID,
      range: `${TAB_BANNED}!A${index+1}:C${index+1}`
    });
  }
}

/* ================= CATEGORY ================= */

async function getCategories() {
  const rows = await read(`${TAB_CATEGORY}!A:B`);
  return rows.slice(1).map(r => r[0]);
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
    tab: category
  }));
}
/* ================= PAYMENT ================= */

async function getPaymentDetail(amount, invoice) {
  const url =
    `https://app.pakasir.com/api/transactiondetail` +
    `?project=${PAYMENT_PROJECT_SLUG}` +
    `&amount=${amount}` +
    `&order_id=${invoice}` +
    `&api_key=${PAYMENT_API_KEY}`;

  const res = await fetch(url);
  return res.json();
}

/* ================= TRANSAKSI ================= */

async function createTransaction(product, chatId, username) {
  const invoice =
    "TX" + Date.now() + crypto.randomBytes(2).toString("hex");

  await append(`${TAB_TX}!A:H`, [
    new Date().toISOString(),
    product.id,
    product.name,
    username ? `@${username}` : "-",
    chatId,
    invoice,
    product.price,
    "PENDING"
  ]);

  return invoice;
}

async function findTransaction(invoice) {
  const rows = await read(`${TAB_TX}!A:H`);
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][5]) === String(invoice)) {
      return {
        rowIndex: i + 1,
        data: rows[i]
      };
    }
  }
  return null;
}

async function markSuccess(rowIndex, rowData) {
  await update(`${TAB_TX}!H${rowIndex}`, "SUCCESS");

  await append(`${TAB_TX_SUCCESS}!A:H`, rowData);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${TAB_TX}!A${rowIndex}:H${rowIndex}`
  });
}

async function markFailed(rowIndex, rowData) {
  await update(`${TAB_TX}!H${rowIndex}`, "FAILED");

  await append(`${TAB_TX_FAIL}!A:H`, rowData);

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SHEET_ID,
    range: `${TAB_TX}!A${rowIndex}:H${rowIndex}`
  });
}
/* ================= AUTO QRIS ================= */

async function sendQRIS(chatId, product, invoice) {
  const pay = await getPaymentDetail(product.price, invoice);

  const qr =
    pay?.transaction?.qr_url ||
    pay?.transaction?.qris_url ||
    pay?.qr_url ||
    null;

  if (!qr) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "⚠️ QRIS belum tersedia. Silakan cek beberapa saat lagi."
    });
    return;
  }

  await tg("sendPhoto", {
    chat_id: chatId,
    photo: qr,
    caption:
      `🧾 Invoice: ${invoice}\n` +
      `📦 Produk: ${product.name}\n` +
      `💰 Total: Rp ${Number(product.price).toLocaleString("id-ID")}\n\n` +
      `Silakan scan QRIS di atas.\n` +
      `Setelah bayar klik /cek ${invoice}`
  });
}

/* ================= CEK STATUS & DELIVER ================= */

async function checkAndDeliver(chatId, invoice) {
  const tx = await findTransaction(invoice);
  if (!tx) {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Invoice tidak ditemukan."
    });
    return;
  }

  const row = tx.data;
  const amount = row[6];

  const detail = await getPaymentDetail(amount, invoice);

  const status =
    (detail?.transaction?.status ||
      detail?.status ||
      "").toUpperCase();

  if (status === "COMPLETED") {

    const categories = await getCategories();
    let product = null;

    for (const cat of categories) {
      const prods = await getProducts(cat);
      const found = prods.find(p => String(p.id) === String(row[1]));
      if (found) {
        product = found;
        break;
      }
    }

    if (!product) {
      await tg("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text: `Produk tidak ditemukan untuk invoice ${invoice}`
      });
      return;
    }

    // kurangi stock jika tidak unlimited
    if (product.stock !== "UNLIMITED") {
      const current = Number(product.stock || 0);
      if (current > 0) {
        await update(`${product.tab}!E${product.rowIndex}`, current - 1);
      }
    }

    await markSuccess(tx.rowIndex, row);

    await tg("sendMessage", {
      chat_id: row[4],
      text:
        `✅ Pembayaran Berhasil!\n\n` +
        `📦 ${product.name}\n\n` +
        `🔗 Link Download:\n${product.link}`
    });

  } else if (status === "EXPIRED" || status === "FAILED") {
    await markFailed(tx.rowIndex, row);

    await tg("sendMessage", {
      chat_id: chatId,
      text: "❌ Transaksi gagal atau expired."
    });

  } else {
    await tg("sendMessage", {
      chat_id: chatId,
      text: "Status: " + (status || "MENUNGGU PEMBAYARAN")
    });
  }
}
/* ================= TELEGRAM MAIN HANDLER ================= */

app.post("/", async (req, res) => {
  try {
    const msg = req.body.message;
    const cb = req.body.callback_query;

    /* ========= CALLBACK BUTTON ========= */
    if (cb) {
      const chatId = cb.message.chat.id;
      const data = cb.data;

      if (data.startsWith("CAT_")) {
        const cat = data.replace("CAT_", "");
        const products = await getProducts(cat);

        const buttons = products.map(p => ([
          {
            text: `${p.name} - Rp ${Number(p.price).toLocaleString("id-ID")}`,
            callback_data: `BUY_${cat}_${p.id}`
          }
        ]));

        await tg("sendMessage", {
          chat_id: chatId,
          text: `📦 Produk ${cat}`,
          reply_markup: { inline_keyboard: buttons }
        });
      }

      if (data.startsWith("BUY_")) {
        const parts = data.split("_");
        const cat = parts[1];
        const id = parts[2];

        const products = await getProducts(cat);
        const product = products.find(p => p.id === id);

        if (!product) return res.sendStatus(200);

        const invoice = await createTransaction(
          product,
          chatId,
          cb.from.username
        );

        await sendQRIS(chatId, product, invoice);
      }

      return res.sendStatus(200);
    }

    /* ========= MESSAGE ========= */
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const text = msg.text || "";
    const username = msg.from.username;

    if (await isBanned(chatId)) {
      await tg("sendMessage", {
        chat_id: chatId,
        text: "❌ Kamu diblokir."
      });
      return res.sendStatus(200);
    }

    /* ========= START ========= */
    if (text === "/start") {
      await addMember(chatId, username);

      const categories = await getCategories();
      const buttons = categories.map(c => ([
        { text: c, callback_data: `CAT_${c}` }
      ]));

      await tg("sendMessage", {
        chat_id: chatId,
        text: "Selamat datang 👋\nPilih kategori:",
        reply_markup: { inline_keyboard: buttons }
      });
    }

    /* ========= CEK ========= */
    if (text.startsWith("/cek")) {
      const invoice = text.split(" ")[1];
      if (!invoice) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "Format: /cek TXxxxx"
        });
      } else {
        await checkAndDeliver(chatId, invoice);
      }
    }

    /* ========= ADMIN COMMAND ========= */
    if (String(chatId) === String(ADMIN_CHAT_ID)) {

      if (text.startsWith("/ban")) {
        const id = text.split(" ")[1];
        await banUser(id, "Admin ban");
        await tg("sendMessage", {
          chat_id: chatId,
          text: "User diban."
        });
      }

      if (text.startsWith("/unban")) {
        const id = text.split(" ")[1];
        await unbanUser(id);
        await tg("sendMessage", {
          chat_id: chatId,
          text: "User di-unban."
        });
      }

      if (text === "/dashboard") {
        const success = await read(`${TAB_TX_SUCCESS}!A:H`);
        const fail = await read(`${TAB_TX_FAIL}!A:H`);

        await tg("sendMessage", {
          chat_id: chatId,
          text:
            `📊 Dashboard\n\n` +
            `✅ Berhasil: ${success.length - 1}\n` +
            `❌ Gagal: ${fail.length - 1}`
        });
      }
    }

    res.sendStatus(200);

  } catch (err) {
    console.log("ERROR:", err.message);
    res.sendStatus(200);
  }
});

/* ================= SERVER ================= */

app.get("/", (req, res) => res.send("BOT RUNNING"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Server started");
});
