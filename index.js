const express = require("express");
const cors = require("cors");
const { 
  Client, 
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder 
} = require("discord.js");
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
// 🔥 Slash Commands Register
// ----------------------------------------
const commands = [
  new SlashCommandBuilder()
    .setName("verify")
    .setDescription("Verify your HWID using 6-digit code")
    .addStringOption(option =>
      option.setName("code")
        .setDescription("Enter your 6-digit verification code")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show help information")
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

(async () => {
  try {
    console.log("📌 Registering Slash Commands...");
    await rest.put(
      Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
      { body: commands }
    );
    console.log("✅ Slash Commands Registered!");
  } catch (err) {
    console.error("❌ Slash Command Error:", err);
  }
})();

// ----------------------------------------
// 🎯 Slash Command Handler
// ----------------------------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "verify") {
    const code = interaction.options.getString("code");

    let { data: record } = await supabase
      .from(TABLE)
      .select("*")
      .eq("code", code)
      .maybeSingle();

    if (!record)
      return interaction.reply("❌ Invalid or expired code!");

    // Check expiry
    if (record.expires_at && new Date(record.expires_at) < new Date()) {
      return interaction.reply("❌ Code expired! Generate a new one.");
    }

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
