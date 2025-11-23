const express = require('express');
const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config(); // Loads .env file

const app = express();
const PORT = process.env.PORT || 3000;

// Temp DB (in-memory)
const pending = {};
const verified = {};

// Random 6-Digit Verify Code
function generateCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// --- DISCORD BOT ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

client.on("ready", () => {
  console.log(`Bot is online: ${client.user.tag}`);
});

client.on("messageCreate", msg => {
  if (msg.author.bot) return;
  if (!msg.content.startsWith("!verify ")) return;

  const code = msg.content.split("!verify ")[1].trim();
  if (!pending[code]) return msg.reply("❌ Invalid or expired code!");

  verified[pending[code]] = Date.now() + (24 * 60 * 60 * 1000);
  delete pending[code];
  msg.reply("✔ Device verified for 24 hours!");
});

// --- API Routes ---
app.get("/", (_, res) => {
  res.send("🚀 SquidGameX Verify API is LIVE!");
});

app.get("/check", (req, res) => {
  const hwid = req.query.hwid;
  if (!hwid) return res.json({ status: "ERROR", msg: "Missing HWID" });

  if (verified[hwid] && verified[hwid] > Date.now()) {
    return res.json({ status: "VALID" });
  }

  const code = generateCode();
  pending[code] = hwid;

  res.json({ status: "NEED_VERIFY", code });
});

client.login(process.env.BOT_TOKEN);
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
