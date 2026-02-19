import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "secret";

const SHEET_ID = process.env.SHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "Sheet1";
const GOOGLE_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

// ====== EDIT TOKO DI SINI ======
const ADMIN_TEXT = "Transfer ke:\nBCA 123xxxx a/n Toko Kamu";

// Produk = NOMOR (karena kolom pertama kamu adalah "nomor")
// Ganti/ tambah sesuai stok di sheet kamu.
const PRODUK_LIST = [
  { kode: "083177866269", nama: "Nomor 083177866269", harga: "Rp50.000" },
  { kode: "082387243135", nama: "Nomor 082387243135", harga: "Rp50.000" },
];

// ====== UTIL TELEGRAM ======
function telegramApi(method) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function sendMessage(chatId, text, replyMarkup) {
  await fetch(telegramApi("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup || undefined,
    }),
  });
}

async function answerCallbackQuery(callbackQueryId) {
  await fetch(telegramApi("answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// ====== GOOGLE SHEETS ======
function getSheetsClient() {
  if (!GOOGLE_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON belum di-set");
  const creds = JSON.parse(GOOGLE_JSON);

  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

/**
 * Ambil 1 stok yang:
 * - nomor == kode
 * - status == READY / Ready (case-insensitive)
 * Lalu update status -> SOLD dan kembalikan {id, password}
 */
async function takeStockByNomor(nomorKode) {
  if (!SHEET_ID) throw new Error("SHEET_ID belum di-set");

  const sheets = getSheetsClient();
  const range = `${SHEET_TAB}!A:D`; // nomor, id, password, status

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range,
  });

  const rows = res.data.values || [];
  if (rows.length < 2) return null;

  const header = rows[0].map((h) => String(h || "").trim().toLowerCase());

  // Header harus: nomor | id | password | status
  const idxNomor = header.indexOf("nomor");
  const idxId = header.indexOf("id");
  const idxPass = header.indexOf("password");
  const idxStatus = header.indexOf("status");

  if ([idxNomor, idxId, idxPass, idxStatus].some((x) => x === -1)) {
    throw new Error(
      "Header sheet harus: nomor | id | password | status (huruf kecil/apa saja boleh, tapi tulisannya harus sama)"
    );
  }

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];

    const nomor = String(r[idxNomor] || "").trim();
    const status = String(r[idxStatus] || "").trim().toUpperCase();

    if (nomor === nomorKode && status === "READY") {
      const rowNumber = i + 1; // 1-based
      const updateRange = `${SHEET_TAB}!A${rowNumber}:D${rowNumber}`;

      const newRow = [...r];
      newRow[idxStatus] = "SOLD";

      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: updateRange,
        valueInputOption: "RAW",
        requestBody: { values: [newRow] },
      });

      return {
        id: String(r[idxId] || "").trim(),
        password: String(r[idxPass] || "").trim(),
      };
    }
  }

  return null;
}

// ====== ROUTES ======
app.get("/", (req, res) => res.send("Bot is running"));

app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    const msg = update.message;
    const cbq = update.callback_query;

    // /start
    if (msg?.text) {
      const chatId = msg.chat.id;

      if (msg.text === "/start") {
        await sendMessage(chatId, "Selamat datang di toko 👋\nPilih menu:", {
          inline_keyboard: [
            [{ text: "📦 Lihat Produk", callback_data: "MENU_PRODUK" }],
            [{ text: "🧾 Cara Beli", callback_data: "MENU_CARA" }],
            [{ text: "👤 Hubungi Admin", callback_data: "MENU_ADMIN" }],
          ],
        });
      } else {
        await sendMessage(chatId, "Ketik /start untuk mulai.");
      }
    }

    // tombol
    if (cbq) {
      const chatId = cbq.message.chat.id;
      const data = cbq.data;

      await answerCallbackQuery(cbq.id);

      if (data === "MENU_PRODUK") {
        const buttons = PRODUK_LIST.map((p) => [
          { text: `Beli ${p.nama} (${p.harga})`, callback_data: `BUY_${p.kode}` },
        ]);

        await sendMessage(chatId, "Produk tersedia:", {
          inline_keyboard: buttons,
        });
      }

      if (data === "MENU_CARA") {
        await sendMessage(
          chatId,
          "Cara beli:\n1) Klik produk\n2) Transfer\n3) Klik 'Saya sudah bayar'\n\nCatatan: versi ini belum cek pembayaran otomatis."
        );
      }

      if (data === "MENU_ADMIN") {
        await sendMessage(chatId, "Hubungi admin: @username_admin (ganti sesuai punyamu)");
      }

      if (data.startsWith("BUY_")) {
        const kode = data.replace("BUY_", "");
        const produk = PRODUK_LIST.find((p) => p.kode === kode);

        if (!produk) {
          await sendMessage(chatId, "Produk tidak ditemukan.");
        } else {
          await sendMessage(
            chatId,
            `Kamu pilih: ${produk.nama}\nHarga: ${produk.harga}\n\n${ADMIN_TEXT}\n\nSetelah bayar klik tombol ini:`,
            {
              inline_keyboard: [
                [{ text: "✅ Saya sudah bayar", callback_data: `PAID_${produk.kode}` }],
              ],
            }
          );
        }
      }

      if (data.startsWith("PAID_")) {
        const kode = data.replace("PAID_", "");
        const produk = PRODUK_LIST.find((p) => p.kode === kode);

        if (!produk) {
          await sendMessage(chatId, "Produk tidak ditemukan.");
        } else {
          const stock = await takeStockByNomor(produk.kode);

          if (!stock) {
            await sendMessage(chatId, `Maaf stok ${produk.nama} habis atau status bukan READY.`);
          } else {
            await sendMessage(
              chatId,
              `✅ Berhasil diproses.\n\nData kamu:\nID: ${stock.id}\nPassword: ${stock.password}\n\nSimpan baik-baik ya!`
            );
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(200);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on", port));
