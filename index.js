const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ----------------------------------------
// 🔥 SUPABASE INIT
// ----------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Table name:
const TABLE = "verifications";

// ----------------------------------------
// 🔥 DISCORD BOT INIT
// ----------------------------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.login(process.env.DISCORD_BOT_TOKEN);

client.once("ready", () => {
  console.log(`🤖 BOT READY — Logged in as ${client.user.tag}`);
});

// ----------------------------------------
// 📌 Discord Command: !verify CODE
// ----------------------------------------
client.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!verify")) return;

  const args = message.content.split(" ");

  if (args.length < 2) {
    return message.reply("❌ Use: `!verify 123456`");
  }

  const code = args[1];

  // Find row with this code
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("code", code)
    .limit(1)
    .maybeSingle();

  if (!data) return message.reply("❌ Invalid or expired code!");

  // Mark verified = true
  await supabase
    .from(TABLE)
    .update({ verified: true })
    .eq("id", data.id);

  return message.reply("✅ Verification Success!");
});

// ----------------------------------------
// 🎯 Roblox Route /check?hwid=XXXXX
// ----------------------------------------
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });

  // 1) See if HWID exists
  const { data: existing } = await supabase
    .from(TABLE)
    .select("*")
    .eq("hwid", hwid)
    .limit(1)
    .maybeSingle();

  // If exists
  if (existing) {
    if (existing.verified === true) {
      return res.json({ status: "VALID" });
    }
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }

  // 2) Create new record
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await supabase.from(TABLE).insert([
    {
      hwid: hwid,
      code: code,
      verified: false,
      expires_at: null,
    }
  ]);

  return res.json({ status: "NEED_VERIFY", code });
});

// ----------------------------------------
// 🚀 Start API Server
// ----------------------------------------
app.listen(PORT, () => console.log(`🚀 API Running on port ${PORT}`));
