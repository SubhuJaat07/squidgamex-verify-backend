const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("Squid Game X Backend is Alive! 🟢");
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TABLE = "verifications";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

client.login(process.env.DISCORD_BOT_TOKEN);

client.once("clientready", () => {
  console.log(`Bot Ready: ${client.user.tag}`);
});

// ----------------------------------------
// 📌 Verify Command (Checks Expiry)
// ----------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!verify")) return;

  const args = message.content.split(" ");
  if (args.length < 2) return message.reply("❌ Use: `!verify 123456`");

  const code = args[1];

  const { data } = await supabase
    .from(TABLE)
    .select("*")
    .eq("code", code)
    .limit(1)
    .maybeSingle();

  if (!data) return message.reply("❌ Invalid code!");

  // ✅ CHECK: Kya code expire ho gaya hai?
  if (data.expires_at && new Date() > new Date(data.expires_at)) {
    return message.reply("❌ This code has EXPIRED! Please rejoin the game to get a new one.");
  }

  await supabase
    .from(TABLE)
    .update({ verified: true })
    .eq("id", data.id);

  return message.reply("✅ Success! You can play now.");
});

// ----------------------------------------
// 🎯 Roblox Check (Sets 24h Expiry)
// ----------------------------------------
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "No HWID" });

  // Calculate 24 Hours from now
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  const { data: existing } = await supabase
    .from(TABLE)
    .select("*")
    .eq("hwid", hwid)
    .limit(1)
    .maybeSingle();

  if (existing) {
    // Agar pehle se verified hai
    if (existing.verified === true) {
      return res.json({ status: "VALID" });
    }

    // ✅ CHECK: Agar code expire ho gaya hai, toh NAYA banao
    const isExpired = existing.expires_at && new Date(existing.expires_at) < now;
    
    if (isExpired) {
      const newCode = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Update with new code and new 24h time
      await supabase
        .from(TABLE)
        .update({ code: newCode, expires_at: expiresAt })
        .eq("id", existing.id);

      return res.json({ status: "NEED_VERIFY", code: newCode });
    }

    // Agar expire nahi hua, wahi purana code return karo
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }

  // New User: Create with 24h expiry
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await supabase.from(TABLE).insert([
    {
      hwid: hwid,
      code: code,
      verified: false,
      expires_at: expiresAt // 👈 24h time set
    }
  ]);

  return res.json({ status: "NEED_VERIFY", code });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
