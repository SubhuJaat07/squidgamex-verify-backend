// index.js  — SquidGameX verify backend (Render version)

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config(); // local test ke liye, Render pe env se hi kaam ho jayega

const app = express();
const PORT = process.env.PORT || 10000;

// In-memory storage (server restart pe reset ho jayega)
const pending = {};   // code -> { hwid, createdAt }
const verified = {};  // hwid -> expiryTimestamp (ms)

// -----------------------
// HTTP ROUTES
// -----------------------

// Simple home page
app.get("/", (req, res) => {
  res.send("🚀 SquidGameX Verify server is LIVE (Render)!");
});

// Roblox script yahi hit karega:
//   GET /check?hwid=XYZ123
app.get("/check", (req, res) => {
  const hwid = req.query.hwid;

  if (!hwid) {
    return res.json({ status: "ERROR", msg: "NO_HWID" });
  }

  // already verified?
  const now = Date.now();
  if (verified[hwid] && verified[hwid] > now) {
    return res.json({ status: "VALID" });
  }

  // not verified → new 6-digit code
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  pending[code] = {
    hwid,
    createdAt: now
  };

  console.log(`[VERIFY] HWID ${hwid} -> code ${code}`);

  return res.json({
    status: "NEED_VERIFY",
    code: code
  });
});

// -----------------------
// DISCORD BOT PART
// -----------------------

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.once("ready", () => {
  console.log(`🤖 BOT ONLINE: ${client.user.tag}`);
});

// command:  !verify 123456
client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!verify")) return;

  const parts = message.content.trim().split(/\s+/);
  if (parts.length < 2) {
    return message.reply("Use: `!verify <code>`");
  }

  const code = parts[1];
  const entry = pending[code];

  if (!entry) {
    return message.reply("❌ Invalid or expired code.");
  }

  // 24 hours verification
  const durationMs = 24 * 60 * 60 * 1000;
  verified[entry.hwid] = Date.now() + durationMs;

  delete pending[code];

  console.log(`[OK] HWID ${entry.hwid} verified for 24h by ${message.author.tag}`);

  return message.reply("✅ Device verified for **24 hours**. You can use the script now.");
});

// BOT TOKEN env se
const token = process.env.BOT_TOKEN;
if (!token) {
  console.warn("⚠️ BOT_TOKEN env var missing! Discord bot will NOT login.");
} else {
  client.login(token).catch((err) => {
    console.error("Bot login failed:", err);
  });
}

// -----------------------
// START HTTP SERVER
// -----------------------

app.listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});
