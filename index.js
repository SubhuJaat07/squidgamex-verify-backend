// index.js — SquidGameX Verify Backend (Stable Version)

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 10000;

// 💾 Temporary storage (RAM)
// (restart hoga to reset ho jayega — next step: database)
const pending = {};     // code → { hwid, createdAt }
const verified = {};    // hwid → expiryTimestamp(ms)

// ==========================
//    HTTP ROUTES
// ==========================
app.get("/", (req, res) => {
  res.send("🚀 SquidGameX Verify Server is LIVE (Render)!");
});

// Roblox script calls this:
app.get("/check", (req, res) => {
  const hwid = req.query.hwid;
  if (!hwid) return res.json({ status: "ERROR", msg: "NO_HWID" });

  const now = Date.now();

  // ⭐ If already verified, do NOT send new code
  if (verified[hwid] && verified[hwid] > now) {
    console.log(`[VALID] HWID ${hwid} already verified.`);
    return res.json({ status: "VALID" });
  }

  // New code only when needed
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  pending[code] = { hwid, createdAt: now };

  console.log(`[VERIFY] HWID ${hwid} → Sending code: ${code}`);

  return res.json({
    status: "NEED_VERIFY",
    code: code
  });
});

// ==========================
//    DISCORD BOT PART
// ==========================
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

client.on("messageCreate", (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!verify")) return;

  const parts = message.content.trim().split(/\s+/);
  if (parts.length < 2) {
    return message.reply("Use: `!verify <code>`");
  }

  const code = parts[1];
  const entry = pending[code];
  const now = Date.now();

  // ❌ No code found / expired
  if (!entry) {
    return message.reply("❌ Invalid or expired code.");
  }

  // ⭐ If already verified
  if (verified[entry.hwid] && verified[entry.hwid] > now) {
    return message.reply("⚠ Already verified! You can use the script.");
  }

  // Activate HWID for 24 hours
  const durationMs = 24 * 60 * 60 * 1000; // 24 HOURS
  verified[entry.hwid] = now + durationMs;

  delete pending[code]; // remove code (one-time use)

  console.log(`[OK] HWID ${entry.hwid} verified by ${message.author.tag}`);

  return message.reply(`
  🔓 **Device Verified!**
  🕐 Verification Active for 24 hours
  ✔ You can now use the script.
  `);
});

// Login bot if token exists
const token = process.env.BOT_TOKEN;
if (!token) {
  console.warn("⚠ BOT_TOKEN ENV MISSING — BOT LOGIN SKIPPED");
} else {
  client.login(token).catch((err) => {
    console.error("Bot login failed:", err);
  });
}

// ==========================
//    START HTTP SERVER
// ==========================
app.listen(PORT, () => {
  console.log(`🌐 HTTP server running on port ${PORT}`);
});
