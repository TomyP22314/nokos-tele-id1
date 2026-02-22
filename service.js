// service.js
import express from "express";
import { google } from "googleapis";
import crypto from "crypto";
import fetch from "node-fetch";
import FormData from "form-data";

/**
 * =========================
 * ENV (WAJIB)
 * =========================
 */
const REQUIRED_ENVS = [
  "BOT_TOKEN",
  "WEBHOOK_SECRET",
  "ADMIN_CHAT_ID",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "SHEET_ID",
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

const PAKASIR_SLUG = process.env.PAKASIR_SLUG;
const PAKASIR_API_KEY = process.env.PAKASIR_API_KEY;
const PAKASIR_WEBHOOK_SECRET = process.env.PAKASIR_WEBHOOK_SECRET;

// Optional UI/UX env
const BANNER_URL = process.env.BANNER_URL || ""; // banner /start
const WELCOME_ANIM_FILE_ID = process.env.WELCOME_ANIM_FILE_ID || ""; // telegram file_id
const REQUIRE_MEMBERSHIP = String(process.env.REQUIRE_MEMBERSHIP || "0") === "1";
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || "").replace("@", ""); // opsional untuk tombol bantuan

// Tab names (sesuai sheet kamu)
const TAB_PRODUCTS = "APK NONTON";
const TAB_TX = "TRANSAKSI";
const TAB_TX_OK = "TRANSAKSI BERHASIL";
const TAB_TX_FAIL = "TRANSAKSI GAGAL";
const TAB_MEMBERS = "MEMBER LIST";

/**
 * =========================
 * APP
 * =========================
 */
const app = express();
app.use(express.json({ verify: (req, res, buf) => (req.rawBody = buf) }));
app.use(express.urlencoded({ extended: true }));

/**
 * =========================
 * Google Sheets
 * =========================
 */
function getGoogleAuth() {
  let sa;
  try {
    sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON bukan JSON valid. Paste isi file service account utuh.");
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
    spreadsheetId
