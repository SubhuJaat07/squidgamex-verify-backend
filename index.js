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
// ✅ KEEPALIVE ROUTE (For UptimeRobot)
// ----------------------------------------
app.get("/", (req, res) => {
  res.send("Squid Game X Backend is Alive! 🟢");
});

// ----------------------------------------
// 🔥 SUPABASE INIT
// ----------------------------------------
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Table name
const TABLE = "verifications";

// ----------------------------------------
// 🔥 DISCORD BOT INIT
// ----------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

client.login(process.env.DISCORD_BOT_TOKEN);

client.once("clientready", () => {
  console.log(`🤖 BOT READY — Logged in as ${client.user.tag}`);
});

// ----------------------------------------
// 📌 Discord Command: !verify CODE
// ----------------------------------------
client.on("messageCreate", async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  if (!message.content.startsWith("!verify")) return;

  const args = message.content.split(" ");

  if (args.length < 2) {
    return message.reply("❌ Use: `!verify 123456`");
  }

  const code = args[1];

  // 1. Check code in DB
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("code", code)
    .limit(1)
    .maybeSingle();

  if (!data) return message.reply("❌ Invalid or expired code!");

  // 2. Update verified status
  await supabase
    .from(TABLE)
    .update({ verified: true })
    .eq("id", data.id);

  return message.reply("✅ Verification Success! You can now play.");
});

// ----------------------------------------
// 🎯 Roblox Route: /check?hwid=XXXXX
// ----------------------------------------
// Note: 'async' keyword yahan zaruri hai 👇
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });

  // 1. Check if HWID exists
  const { data: existing } = await supabase
    .from(TABLE)
    .select("*")
    .eq("hwid", hwid)
    .limit(1)
    .maybeSingle();

  // If exists, check status
  if (existing) {
    if (existing.verified === true) {
      return res.json({ status: "VALID" });
    }
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }

  // 2. Create new record if not exists
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  // Ye await tabhi chalega jab function async ho (jo upar hai)
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
// 🚀 Start Server
// ----------------------------------------
app.listen(PORT, () => console.log(`🚀 API Running on port ${PORT}`));
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
      return res.json({ status: "VALID" });
    }
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }

  // 2) Create new record if not exists
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
    await supabase
      .from(TABLE)
      .update({ verified: true })
      .eq("id", record.id);

    return interaction.reply("✅ HWID Verified for 24 hours!");
  }

  if (interaction.commandName === "help") {
    return interaction.reply("Use `/verify <code>` to verify your HWID.");
  }
});

// ----------------------------------------
// 📌 OLD MESSAGE COMMAND SUPPORT (!verify)
// ----------------------------------------
client.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!verify")) return;

  const args = message.content.split(" ");
  if (args.length < 2) return message.reply("❌ Use: `!verify 123456`");

  const code = args[1];

  let { data: record } = await supabase
    .from(TABLE)
    .select("*")
    .eq("code", code)
    .maybeSingle();

  if (!record) return message.reply("❌ Invalid or expired code!");

  if (record.expires_at && new Date(record.expires_at) < new Date()) {
    return message.reply("❌ Code expired! Generate new.");
  }

  await supabase
    .from(TABLE)
    .update({ verified: true })
    .eq("id", record.id);

  return message.reply("✅ Verified!");
});

// ----------------------------------------
// 🎯 Roblox Route /check?hwid=XXXXX
// ----------------------------------------
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });

  // Check if HWID exists
  let { data: record } = await supabase
    .from(TABLE)
    .select("*")
    .eq("hwid", hwid)
    .maybeSingle();

  // If exists
  if (record) {
    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      return res.json({ status: "EXPIRED" });
    }

    if (record.verified === true) {
      return res.json({ status: "VALID" });
    }

    return res.json({ status: "NEED_VERIFY", code: record.code });
  }

  // New entry
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await supabase.from(TABLE).insert([
    {
      hwid: hwid,
      code: code,
      verified: false,
      expires_at: expiresAt,
    }
  ]);

  return res.json({ status: "NEED_VERIFY", code });
});

// ----------------------------------------
// 🚀 Start API Server
// ----------------------------------------
app.listen(PORT, () => console.log(`🚀 API Running on port ${PORT}`));
