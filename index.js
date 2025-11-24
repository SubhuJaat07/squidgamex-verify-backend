const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 10000;
// 👇 Sirf ye ID "😎" use kar payegi
const ADMIN_ID = "1169492860278669312"; 
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

// --- SLASH COMMAND REGISTER ---
const commands = [
  new SlashCommandBuilder()
    .setName("setexpiry")
    .setDescription("Admin Only: Set custom expiry")
    .addStringOption(option => option.setName("target").setDescription("Code or HWID").setRequired(true))
    .addStringOption(option => option.setName("duration").setDescription("e.g. 24h, 2d, lifetime").setRequired(true)),
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once("clientready", async () => {
  console.log(`🤖 Bot Ready: ${client.user.tag}`);
  try {
    // Commands register kar raha hai...
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("✅ Slash Commands Registered Successfully!");
  } catch (error) {
    console.error("❌ Command Error:", error);
  }
});

// ---------------------------------------------------------
// 🛠️ VERIFICATION LOGIC (Common Function)
// ---------------------------------------------------------
async function handleVerification(message, code) {
  // Check Code
  const { data } = await supabase.from(TABLE).select("*").eq("code", code).limit(1).maybeSingle();

  if (!data) return message.reply("❌ **Invalid Code!** Check karke dubara bhejein.");

  // Set 24 Hours Expiry
  const now = new Date();
  const expiryTime = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  // Update DB
  await supabase.from(TABLE).update({ verified: true, expires_at: expiryTime }).eq("id", data.id);

  return message.reply(`✅ **Access Granted!**\nAccount verified for **24 Hours**. 🎮`);
}

// ---------------------------------------------------------
// 💬 MESSAGE HANDLER
// ---------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();

  // 👉 CASE 1: SIRF "😎" EMOJI (Only for You)
  if (content === "😎") {
    // Security Check: Kya aap Admin hain?
    if (message.author.id !== ADMIN_ID) return; // Dusro ko ignore karega

    await message.reply("बोलिये सर, आपका टोकन नम्बर क्या है? 🙇‍♂️");

    // Wait for Token
    const filter = (m) => m.author.id === ADMIN_ID;
    const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

    collector.on('collect', async (m) => {
      const token = m.content.trim();
      // Agar user galti se number ki jagah text bhej de toh crash na ho
      if(token.length > 3) { 
          await handleVerification(m, token);
          collector.stop();
      }
    });
    return;
  }

  // 👉 CASE 2: PUBLIC COMMAND (verify 123456)
  if (content.toLowerCase().startsWith("verify")) {
    const args = content.split(/\s+/);
    if (args.length < 2) return message.reply("❌ **Use:** `verify 123456`");
    
    const code = args[1];
    await handleVerification(message, code);
  }
});

// --- SLASH COMMAND (/setexpiry) ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === "setexpiry") {
    if (interaction.user.id !== ADMIN_ID) return interaction.reply({ content: "❌ Sirf Admin ye use kar sakta hai!", ephemeral: true });

    const target = interaction.options.getString("target");
    const duration = interaction.options.getString("duration");
    
    let newDate;
    if (duration.toLowerCase() === "lifetime") {
        const d = new Date();
        d.setFullYear(d.getFullYear() + 100);
        newDate = d.toISOString();
    } else {
        const match = duration.match(/^(\d+)([hdmw])$/);
        if (!match) return interaction.reply({ content: "❌ Invalid format! Use: 24h, 2d, 1w", ephemeral: true });
        const val = parseInt(match[1]), unit = match[2], now = new Date();
        if (unit === 'h') now.setHours(now.getHours() + val);
        if (unit === 'd') now.setDate(now.getDate() + val);
        if (unit === 'm') now.setMinutes(now.getMinutes() + val);
        if (unit === 'w') now.setDate(now.getDate() + (val * 7));
        newDate = now.toISOString();
    }

    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target database mein nahi mila.");

    await supabase.from(TABLE).update({ verified: true, expires_at: newDate }).eq("id", data.id);
    return interaction.reply(`✅ **Updated!**\nTarget: ${target}\nDuration: ${duration}\nStatus: Verified`);
  }
});

// --- API ROUTES ---
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
