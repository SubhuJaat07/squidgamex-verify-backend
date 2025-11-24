const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 10000;
const ADMIN_ID = "1169492860278669312"; // Aapki ID
const TABLE = "verifications";

const app = express();
app.use(cors());
app.use(express.json());

// --- SUPABASE ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- DISCORD CLIENT ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent // ⚠️ Ye Developer Portal pe ON hona chahiye
  ],
});

// --- SLASH COMMAND REGISTER (Isse rehne do, future ke liye) ---
const commands = [
  new SlashCommandBuilder()
    .setName("setexpiry")
    .setDescription("Admin Only: Set custom expiry")
    .addStringOption(option => option.setName("target").setDescription("Code/HWID").setRequired(true))
    .addStringOption(option => option.setName("duration").setDescription("24h, 2d, lifetime").setRequired(true)),
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once("clientready", async () => {
  console.log(`🤖 Bot Ready: ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Slash commands reloaded.");
  } catch (error) {
    console.error(error);
  }
});

// ---------------------------------------------------------
// 🛠️ COMMON VERIFICATION FUNCTION (Logic yahan hai)
// ---------------------------------------------------------
async function handleVerification(message, code) {
  // 1. Check Code in DB
  const { data } = await supabase
    .from(TABLE)
    .select("*")
    .eq("code", code)
    .limit(1)
    .maybeSingle();

  if (!data) {
    return message.reply("❌ **Invalid Code!** Kripya sahi code check karein.");
  }

  // 2. Set 24 Hours Expiry
  const now = new Date();
  const expiryTime = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  // 3. Update DB
  await supabase
    .from(TABLE)
    .update({ verified: true, expires_at: expiryTime })
    .eq("id", data.id);

  return message.reply(`✅ **Verification Successful!**\nGame Access Granted for **24 Hours**. 🎮`);
}

// ---------------------------------------------------------
// 💬 MESSAGE HANDLER (Commands)
// ---------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim(); // Extra spaces hatane ke liye

  // 👉 CASE 1: "admin 😎" (Conversation Mode)
  if (content === "admin 😎") {
    // Sirf aap (Admin) use kar sakein, toh ye line uncomment karein:
    // if (message.author.id !== ADMIN_ID) return; 

    await message.reply("बोलिये सर, आपका टोकन नम्बर क्या है? 🙇‍♂️");

    // Wait for response (1 minute timeout)
    const filter = (m) => m.author.id === message.author.id;
    const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

    collector.on('collect', async (m) => {
      const token = m.content.trim();
      await handleVerification(m, token); // Call verification logic
    });
    
    return;
  }

  // 👉 CASE 2: "verify 123456" (Direct Mode)
  if (content.toLowerCase().startsWith("verify")) {
    const args = content.split(/\s+/); // Split by space
    
    // Agar sirf "verify" likha hai
    if (args.length < 2) {
      return message.reply("❌ **Use:** `verify 123456`");
    }

    const code = args[1];
    await handleVerification(message, code);
  }
});

// --- SLASH COMMAND LOGIC (/setexpiry) ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "setexpiry") {
    if (interaction.user.id !== ADMIN_ID) return interaction.reply({ content: "❌ Not Authorized!", ephemeral: true });

    const target = interaction.options.getString("target");
    const duration = interaction.options.getString("duration");
    
    let newDate;
    if (duration.toLowerCase() === "lifetime") {
        const d = new Date();
        d.setFullYear(d.getFullYear() + 100);
        newDate = d.toISOString();
    } else {
        // Simple calc logic
        const match = duration.match(/^(\d+)([hdmw])$/);
        if (!match) return interaction.reply({ content: "❌ Invalid format! Use: 24h, 2d", ephemeral: true });
        const val = parseInt(match[1]), unit = match[2], now = new Date();
        if (unit === 'h') now.setHours(now.getHours() + val);
        if (unit === 'd') now.setDate(now.getDate() + val);
        newDate = now.toISOString();
    }

    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found.");

    await supabase.from(TABLE).update({ verified: true, expires_at: newDate }).eq("id", data.id);
    return interaction.reply(`✅ Updated ${target} to ${duration}`);
  }
});

// --- API & SERVER ---
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });

  const { data: existing } = await supabase.from(TABLE).select("*").eq("hwid", hwid).maybeSingle();

  if (existing) {
    const now = new Date();
    if (existing.verified === true && existing.expires_at && new Date(existing.expires_at) > now) {
      return res.json({ status: "VALID" });
    }
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await supabase.from(TABLE).insert([{ hwid: hwid, code: code, verified: false, expires_at: null }]);
  return res.json({ status: "NEED_VERIFY", code });
});

app.get("/", (req, res) => res.send("System Online 🟢"));
client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`🚀 API Running on Port ${PORT}`));
