import express from "express";
import fetch from "node-fetch";
import { google } from "googleapis";
import crypto from "crypto";

const app = express();
app.use(express.json());

// ===== ENV =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "secret";

const SHEET_ID = process.env.SHEET_ID;
const ORDERS_TAB = process.env.SHEET_ORDERS_TAB || "Orders";
const GOOGLE_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

const PAKASIR_SLUG = process.env.PAKASIR_SLUG; // goms-noktel
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const PAKASIR_WEBHOOK_SECRET = process.env.PAKASIR_WEBHOOK_SECRET;

// ===== VALIDASI ENV =====
function assertEnv() {
  const missing = [];
  if (!BOT_TOKEN) missing.push("BOT_TOKEN");
  if (!SHEET_ID) missing.push("SHEET_ID");
  if (!GOOGLE_JSON) missing.push("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!PAKASIR_SLUG) missing.push("PAKASIR_SLUG");
  if (!PAKASIR_API_KEY) missing.push("PAKASIR_API_KEY");
  if (!PAKASIR_WEBHOOK_SECRET) missing.push("PAKASIR_WEBHOOK_SECRET");
  if (missing.length) throw new Error("Missing ENV: " + missing.join(", "));
}
assertEnv();

// ===== 8 SHEET STOK =====
const STOCK_TABS = {
  ID1: "ID1",
  ID2: "ID2",
  ID3: "ID3",
  ID4: "ID4",
  ID5: "ID5",
  ID6: "ID6",
  ID7: "ID7",
  ID8: "ID8",
};

// ===== HARGA (SESUAI LIST KAMU) =====
const PRICE_BY_ID = {
  ID1: 28000,
  ID2: 25000,
  ID3: 23000,
  ID4: 20000,
  ID5: 18000,
  ID6: 15000,
  ID7: 10000,
  ID8: 9000,
};

const CARA_ORDER =
  "📌 Cara Order\n\n" +
  "1) Klik 🛒 Order\n" +
  "2) Pilih ID yang tersedia\n" +
  "3) Bot buat link bayar Pakasir\n" +
  "4) Setelah pembayaran sukses, bot otomatis kirim detail produk\n\n" +
  "Catatan: detail produk dikirim hanya setelah status pembayaran 'completed'.";

function rupiah(n) {
  return "Rp " + Number(n).toLocaleString("id-ID");
}

function nowISO() {
  return new Date().toISOString();
}

function newOrderId() {
  return `INV-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

// ===== Telegram helpers =====
function tg(method) {
  return `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
}

async function sendMessage(chatId, text, replyMarkup) {
  await fetch(tg("sendMessage"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      reply_markup: replyMarkup || undefined,
      disable_web_page_preview: true,
    }),
  });
}

async function answerCallbackQuery(id) {
  await fetch(tg("answerCallbackQuery"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: id }),
  });
}

function mainMenu() {
  return {
    inline_keyboard: [
      [{ text: "🛒 Order", callback_data: "MENU_ORDER" }],
      [{ text: "📌 Cara Order", callback_data: "MENU_CARA" }],
    ],
  };
}

// ===== Google Sheets =====
function sheetsClient() {
  const creds = JSON.parse(GOOGLE_JSON);
  const auth = new google.auth.JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function sheetGet(tab, rangeA1) {
  const sheets = sheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tab}!${rangeA1}`,
  });
  return res.data.values || [];
}

async function sheetAppend(tab, row) {
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${tab}!A:Z`,
    valueInputOption: "RAW",
    requestBody: { values: [row] },
  });
}

async function sheetUpdate(tab, rangeA1, values2D) {
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${tab}!${rangeA1}`,
    valueInputOption: "RAW",
    requestBody: { values: values2D },
  });
}

function toColLetter(n) {
  let s = "";
  while (n > 0) {
    const mod = (n - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ===== STOCK (format: User ID, Username, Nama, Nomor HP, 2FA, Email Recovery, Status) =====
function normalizeHeader(h) {
  return String(h || "").trim().toLowerCase();
}

async function parseStockHeader(tabName) {
  const rows = await sheetGet(tabName, "A1:G1");
  if (!rows.length || !rows[0]?.length) throw new Error(`Sheet ${tabName} kosong`);

  const header = rows[0].map(normalizeHeader);

  // Minimal wajib ada kolom Status
  const idxStatus = header.indexOf("status");
  if (idxStatus === -1) {
    throw new Error(`Header sheet ${tabName} harus ada kolom "Status" (kolom G)`);
  }

  // Kita cari index tiap kolom (kalau ada)
  const idxUserId = header.indexOf("user id");
  const idxUsername = header.indexOf("username");
  const idxNama = header.indexOf("nama");
  const idxHp = header.indexOf("nomor hp");
  const idx2fa = header.indexOf("2fa");
  const idxEmail = header.indexOf("email recovery");

  return { idxUserId, idxUsername, idxNama, idxHp, idx2fa, idxEmail, idxStatus };
}

async function countReadyOnTab(tabName) {
  const rows = await sheetGet(tabName, "A:G");
  if (rows.length < 2) return 0;

  const { idxStatus } = await parseStockHeader(tabName);

  let cnt = 0;
  for (let r = 1; r < rows.length; r++) {
    const status = String(rows[r][idxStatus] || "").trim().toUpperCase();
    if (status === "READY") cnt++;
  }
  return cnt;
}

async function countAllReady() {
  const result = {};
  for (const id of Object.keys(STOCK_TABS)) {
    result[id] = await countReadyOnTab(STOCK_TABS[id]);
  }
  return result;
}

function formatStockDetail(row, idx) {
  const userId = idx.idxUserId >= 0 ? String(row[idx.idxUserId] || "").trim() : "";
  const username = idx.idxUsername >= 0 ? String(row[idx.idxUsername] || "").trim() : "";
  const nama = idx.idxNama >= 0 ? String(row[idx.idxNama] || "").trim() : "";
  const hp = idx.idxHp >= 0 ? String(row[idx.idxHp] || "").trim() : "";
  const twofa = idx.idx2fa >= 0 ? String(row[idx.idx2fa] || "").trim() : "";
  const email = idx.idxEmail >= 0 ? String(row[idx.idxEmail] || "").trim() : "";

  const lines = [];
  if (userId) lines.push(`• User ID: ${userId}`);
  if (username) lines.push(`• Username: ${username}`);
  if (nama) lines.push(`• Nama: ${nama}`);
  if (hp) lines.push(`• Nomor HP: ${hp}`);
  if (twofa) lines.push(`• 2FA: ${twofa}`);
  if (email) lines.push(`• Email Recovery: ${email}`);

  return lines.join("\n") || "(detail kosong)";
}

async function takeOneStockFromTab(tabName) {
  const rows = await sheetGet(tabName, "A:G");
  if (rows.length < 2) return null;

  const idx = await parseStockHeader(tabName);

  for (let r = 1; r < rows.length; r++) {
    const status = String(rows[r][idx.idxStatus] || "").trim().toUpperCase();
    if (status === "READY") {
      const rowNumber = r + 1;

      // update status -> SOLD
      const colIndex1 = idx.idxStatus + 1; // 1-based
      const colLetter = toColLetter(colIndex1);
      await sheetUpdate(tabName, `${colLetter}${rowNumber}`, [["SOLD"]]);

      const detailText = formatStockDetail(rows[r], idx);
      return { detailText, rowNumber };
    }
  }
  return null;
}

// ===== ORDERS =====
async function createOrderRow({ orderId, chatId, groupId, amount }) {
  await sheetAppend(ORDERS_TAB, [
    orderId,
    String(chatId),
    groupId,
    String(amount),
    "PENDING",
    nowISO(),
    "",
  ]);
}

async function getOrderById(orderId) {
  const rows = await sheetGet(ORDERS_TAB, "A:G");
  if (rows.length < 2) return null;

  const header = rows[0].map((x) => String(x || "").trim().toLowerCase());
  const iOrder = header.indexOf("order_id");
  const iChat = header.indexOf("chat_id");
  const iGroup = header.indexOf("group_id");
  const iAmount = header.indexOf("amount");
  const iStatus = header.indexOf("status");

  if ([iOrder, iChat, iGroup, iAmount, iStatus].some((i) => i === -1)) {
    throw new Error("Header Orders harus: order_id|chat_id|group_id|amount|status|created_at|completed_at");
  }

  for (let r = 1; r < rows.length; r++) {
    if (String(rows[r][iOrder] || "").trim() === orderId) {
      return {
        orderId,
        chatId: String(rows[r][iChat] || "").trim(),
        groupId: String(rows[r][iGroup] || "").trim().toUpperCase(),
        amount: Number(String(rows[r][iAmount] || "0").trim()),
        status: String(rows[r][iStatus] || "").trim().toUpperCase(),
        rowNumber: r + 1,
      };
    }
  }
  return null;
}

async function markOrderCompleted(order) {
  // Orders: A order_id, B chat_id, C group_id, D amount, E status, F created_at, G completed_at
  await sheetUpdate(ORDERS_TAB, `E${order.rowNumber}:G${order.rowNumber}`, [
    ["COMPLETED", "", nowISO()],
  ]);
}

// ===== Pakasir =====
function pakasirPayUrl(amount, orderId) {
  return `https://app.pakasir.com/pay/${encodeURIComponent(PAKASIR_SLUG)}/${encodeURIComponent(
    String(amount)
  )}?order_id=${encodeURIComponent(orderId)}`;
}

async function pakasirTransactionDetail(amount, orderId) {
  const url =
    `https://app.pakasir.com/api/transactiondetail` +
    `?project=${encodeURIComponent(PAKASIR_SLUG)}` +
    `&amount=${encodeURIComponent(String(amount))}` +
    `&order_id=${encodeURIComponent(orderId)}` +
    `&api_key=${encodeURIComponent(PAKASIR_API_KEY)}`;

  const r = await fetch(url);
  const data = await r.json();
  return data?.transaction || null;
}

// ===== Routes =====
app.get("/", (req, res) => res.send("OK"));

app.post(`/telegram/webhook/${WEBHOOK_SECRET}`, async (req, res) => {
  try {
    const update = req.body;

    if (update.message?.text) {
      const chatId = update.message.chat.id;
      const text = update.message.text.trim();

      if (text === "/start") {
        await sendMessage(chatId, "✅ Selamat datang!\nPilih menu:", mainMenu());
      } else {
        await sendMessage(chatId, "Ketik /start untuk mulai.", mainMenu());
      }
    }

    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message.chat.id;
      const data = cb.data;

      await answerCallbackQuery(cb.id);

      if (data === "MENU_CARA") {
        await sendMessage(chatId, CARA_ORDER, mainMenu());
      }

      if (data === "MENU_ORDER") {
        const counts = await countAllReady();

        // tampil status stok (SOLD tidak dihitung, jadi tidak tampil)
        const lines = [];
        for (let i = 1; i <= 8; i++) {
          const key = `ID${i}`;
          const qty = counts[key] || 0;
          lines.push(`${qty > 0 ? "🟢" : "🔴"} ${key}: ${qty} stok — ${rupiah(PRICE_BY_ID[key])}`);
        }

        // tombol hanya untuk yang stok > 0
        const buttons = [];
        for (let i = 1; i <= 8; i++) {
          const key = `ID${i}`;
          const qty = counts[key] || 0;
          if (qty > 0) {
            buttons.push([{ text: `${key} (${rupiah(PRICE_BY_ID[key])})`, callback_data: `BUY_${key}` }]);
          }
        }

        await sendMessage(
          chatId,
          "📦 Stok saat ini (READY saja):\n" + lines.join("\n") + "\n\nPilih ID yang ingin dibeli:",
          buttons.length ? { inline_keyboard: buttons } : mainMenu()
        );
      }

      if (data.startsWith("BUY_")) {
        const groupId = data.replace("BUY_", "").trim().toUpperCase();
        const tabName = STOCK_TABS[groupId];
        const amount = PRICE_BY_ID[groupId];

        if (!tabName || !amount) {
          await sendMessage(chatId, "ID / harga tidak valid.");
          return res.sendStatus(200);
        }

        const readyCount = await countReadyOnTab(tabName);
        if (readyCount <= 0) {
          await sendMessage(chatId, `Maaf stok ${groupId} sedang kosong.`);
          return res.sendStatus(200);
        }

        const orderId = newOrderId();
        await createOrderRow({ orderId, chatId, groupId, amount });

        const payUrl = pakasirPayUrl(amount, orderId);
        await sendMessage(
          chatId,
          `🧾 Order dibuat!\n\nProduk: ${groupId}\nHarga: ${rupiah(amount)}\nOrder ID: ${orderId}\n\nSilakan bayar via Pakasir:\n${payUrl}\n\nSetelah pembayaran sukses (completed), detail akan dikirim otomatis.`
        );
      }
    }

    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

// Pakasir webhook
app.post("/pakasir/webhook/:secret", async (req, res) => {
  try {
    if (req.params.secret !== PAKASIR_WEBHOOK_SECRET) return res.status(401).send("unauthorized");

    const { amount, order_id, project, status } = req.body || {};
    if (!amount || !order_id) return res.status(400).send("bad request");

    if (String(project) !== String(PAKASIR_SLUG)) return res.status(200).send("ignored");
    if (String(status) !== "completed") return res.status(200).send("ok");

    const order = await getOrderById(String(order_id));
    if (!order) return res.status(200).send("unknown order");
    if (order.status === "COMPLETED") return res.status(200).send("already done");

    if (Number(order.amount) !== Number(amount)) return res.status(200).send("amount mismatch");

    const trx = await pakasirTransactionDetail(order.amount, order.orderId);
    if (!trx || String(trx.status) !== "completed") return res.status(200).send("not completed");

    const tabName = STOCK_TABS[order.groupId];
    if (!tabName) return res.status(200).send("bad group");

    const stock = await takeOneStockFromTab(tabName);
    if (!stock) {
      await sendMessage(order.chatId, `⚠️ Pembayaran sukses, tapi stok ${order.groupId} habis. Hubungi admin.`);
      return res.status(200).send("no stock");
    }

    await markOrderCompleted(order);

    await sendMessage(
      order.chatId,
      `✅ Pembayaran diterima!\n\nProduk: ${order.groupId}\n\nDetail:\n${stock.detailText}\n\nTerima kasih 🙏`
    );

    return res.status(200).send("ok");
  } catch (e) {
    console.error(e);
    return res.status(200).send("ok");
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Server running on", port));
