const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 10000;
const ADMIN_ID = "1169492860278669312"; // Subhu Jaat
const GUILD_ID = "1257403231127076915"; // Server ID

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
    GatewayIntentBits.MessageContent
  ],
});

// --- SLASH COMMAND SETUP ---
const commands = [
  new SlashCommandBuilder()
    .setName("setexpiry")
    .setDescription("Admin Only: Set custom expiry")
    .addStringOption(option => option.setName("target").setDescription("Code or HWID").setRequired(true))
    // 👇 Updated Description: Added '10m' example
    .addStringOption(option => option.setName("duration").setDescription("e.g. 10m, 1h, 2d, lifetime").setRequired(true)),
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once("ready", async () => {
  console.log(`✅ Bot Logged In as: ${client.user.tag}`);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID), 
      { body: commands }
    );
    console.log("🎉 SUCCESS: Slash Commands Registered!");
  } catch (error) {
    console.error("❌ Command Error:", error);
  }
});

// ---------------------------------------------------------
// 🛠️ VERIFICATION LOGIC
// ---------------------------------------------------------
async function handleVerification(message, code) {
  const { data } = await supabase.from(TABLE).select("*").eq("code", code).limit(1).maybeSingle();

  if (!data) return message.reply("❌ **Invalid Code!** Sir, code galat lag raha hai.");

  const now = new Date();
  const expiryTime = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  await supabase.from(TABLE).update({ verified: true, expires_at: expiryTime }).eq("id", data.id);

  return message.reply(`✅ **Access Granted!**\nVerified for **24 Hours**. Enjoy Sir! 🎮`);
}

// ---------------------------------------------------------
// 💬 MESSAGE HANDLER
// ---------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();

  // 👉 CASE 1: ADMIN EMOJI "😎" (With Funny Mode)
  if (content === "😎") {
    if (message.author.id !== ADMIN_ID) return; 

    await message.reply("बोलिये सर, आपका टोकन नम्बर क्या है? 🙇‍♂️");

    const filter = (m) => m.author.id === ADMIN_ID;
    const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

    collector.on('collect', async (m) => {
      const msg = m.content.toLowerCase();
      const token = m.content.trim();

      // 😂 FUNNY SCOLD CHECK
      const scoldWords = ["chup", "bakwas", "shant", "bol mat", "silence", "gyan mat"];
      
      if (scoldWords.some(word => msg.includes(word))) {
          await m.reply("Sorry Sir, My mistake! Main chup ho jata hu. 🤐");
          collector.stop();
          return;
      }

      // Normal Code Check
      if(token.length > 3) { 
          await handleVerification(m, token);
          collector.stop();
      }
    });
    return;
  }

  // 👉 CASE 2: PUBLIC VERIFY
  if (content.toLowerCase().startsWith("verify")) {
    const args = content.split(/\s+/);
    if (args.length < 2) return message.reply("❌ **Use:** `verify 123456`");
    const code = args[1];
    await handleVerification(message, code);
  }
});

// --- SLASH COMMAND HANDLER (/setexpiry) ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "setexpiry") {
    if (interaction.user.id !== ADMIN_ID) return interaction.reply({ content: "❌ Sirf Admin!", ephemeral: true });

    const target = interaction.options.getString("target");
    const duration = interaction.options.getString("duration");
    
    let newDate;
    if (duration.toLowerCase() === "lifetime") {
        const d = new Date();
        d.setFullYear(d.getFullYear() + 100);
        newDate = d.toISOString();
    } else {
        // 👇 Regex supports: m (minutes), h (hours), d (days), w (weeks)
        const match = duration.match(/^(\d+)([hdmw])$/);
        
        if (!match) return interaction.reply({ content: "❌ Invalid format! Use: 10m, 24h, 2d", ephemeral: true });
        
        const val = parseInt(match[1]);
        const unit = match[2];
        const now = new Date();

        // 👇 Minute Logic Added Here
        if (unit === 'm') now.setMinutes(now.getMinutes() + val);
        if (unit === 'h') now.setHours(now.getHours() + val);
        if (unit === 'd') now.setDate(now.getDate() + val);
        if (unit === 'w') now.setDate(now.getDate() + (val * 7));
        
        newDate = now.toISOString();
    }

    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found.");

    await supabase.from(TABLE).update({ verified: true, expires_at: newDate }).eq("id", data.id);
    return interaction.reply(`✅ **Updated!**\nTarget: ${target}\nDuration: ${duration}\nStatus: Verified`);
  }
});

// --- API ---
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
