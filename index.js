const express = require("express");
const cors = require("cors");
// 👇 MessageFlags import kiya hai warning fix karne ke liye
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, MessageFlags } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 10000;
const ADMIN_ID = "1169492860278669312"; 
const GUILD_ID = "1257403231127076915"; 

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
    .addStringOption(option => option.setName("duration").setDescription("e.g. 24h, 2d, lifetime").setRequired(true)),
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

  if (!data) return message.reply("❌ **Invalid Code!**");

  const now = new Date();
  const expiryTime = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  await supabase.from(TABLE).update({ verified: true, expires_at: expiryTime }).eq("id", data.id);

  return message.reply(`✅ **Access Granted!**\nVerified for **24 Hours**. 🎮`);
}

// ---------------------------------------------------------
// 💬 MESSAGE HANDLER
// ---------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();

  // 👉 Admin Logic (😎 Trigger)
  if (content === "😎") {
    if (message.author.id !== ADMIN_ID) return; 

    await message.reply("बोलिये सर, आपका टोकन नम्बर क्या है? 🙇‍♂️");

    const filter = (m) => m.author.id === ADMIN_ID;
    const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

    collector.on('collect', async (m) => {
      const replyText = m.content.trim().toLowerCase();

      // 👇 FUNNY LOGIC: Agar aap daant do bot ko
      const triggerWords = ["tu chup rh", "chup rah", "bakwas nhi", "shant", "chup"];
      if (triggerWords.some(word => replyText.includes(word))) {
          await m.reply("Sorry Sir, My mistake 🤐");
          collector.stop();
          return;
      }

      // Normal Verification
      if(m.content.length > 3) { 
          await handleVerification(m, m.content.trim());
          collector.stop();
      }
    });
    return;
  }

  // 👉 Public Verify Command
  if (content.toLowerCase().startsWith("verify")) {
    const args = content.split(/\s+/);
    if (args.length < 2) return message.reply("❌ **Use:** `verify 123456`");
    const code = args[1];
    await handleVerification(message, code);
  }
});

// --- SLASH COMMAND HANDLER ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  if (interaction.commandName === "setexpiry") {
    // 👇 FUNNY LOGIC: Only Subhu Boss Check
    if (interaction.user.id !== ADMIN_ID) {
        return interaction.reply({ 
            content: "❌ **Only Subhu boss hi is command ko use kr skte hai!**", 
            flags: MessageFlags.Ephemeral // 👈 Fixed Warning
        });
    }

    const target = interaction.options.getString("target");
    const duration = interaction.options.getString("duration");
    
    let newDate;
    if (duration.toLowerCase() === "lifetime") {
        const d = new Date();
        d.setFullYear(d.getFullYear() + 100);
        newDate = d.toISOString();
    } else {
        const match = duration.match(/^(\d+)([hdmw])$/);
        if (!match) {
            return interaction.reply({ 
                content: "❌ Invalid format! Use: 24h, 2d", 
                flags: MessageFlags.Ephemeral // 👈 Fixed Warning
            });
        }
        const val = parseInt(match[1]), unit = match[2], now = new Date();
        if (unit === 'h') now.setHours(now.getHours() + val);
        if (unit === 'd') now.setDate(now.getDate() + val);
        if (unit === 'm') now.setMinutes(now.getMinutes() + val);
        if (unit === 'w') now.setDate(now.getDate() + (val * 7));
        newDate = now.toISOString();
    }

    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) {
        return interaction.reply({ 
            content: "❌ Target not found.", 
            flags: MessageFlags.Ephemeral // 👈 Fixed Warning
        });
    }

    await supabase.from(TABLE).update({ verified: true, expires_at: newDate }).eq("id", data.id);
    return interaction.reply(`✅ Updated **${target}** to **${duration}**`);
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
