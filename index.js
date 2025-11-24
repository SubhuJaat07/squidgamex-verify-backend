const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 10000;
const ADMIN_ID = "YAHAN_APNI_DISCORD_ID_DALO"; // <--- ⚠️ Yahan apni ID paste karein
const TABLE = "verifications";

const app = express();
app.use(cors());
app.use(express.json());

// --- SUPABASE ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- DISCORD CLIENT ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// --- REGISTER SLASH COMMAND (AUTOMATIC) ---
const commands = [
  new SlashCommandBuilder()
    .setName("setexpiry")
    .setDescription("Admin Only: Set custom expiry for a user")
    .addStringOption(option => 
      option.setName("target").setDescription("Enter Code or HWID").setRequired(true))
    .addStringOption(option => 
      option.setName("duration").setDescription("e.g. 24h, 2d, 1w, or 'lifetime'").setRequired(true)),
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once("clientready", async () => {
  console.log(`🤖 Bot Ready: ${client.user.tag}`);
  
  // Register Slash Command locally to the bot
  try {
    console.log("Started refreshing application (/) commands.");
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log("Successfully reloaded application (/) commands.");
  } catch (error) {
    console.error(error);
  }
});

// --- HELPER: Parse Duration (e.g., "2d" -> Date Object) ---
function calculateExpiry(durationStr) {
  if (durationStr.toLowerCase() === "lifetime") return null; // Null means never expire (logic handle karna padega)
  
  const match = durationStr.match(/^(\d+)([hdmw])$/);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2];
  const now = new Date();

  if (unit === 'h') now.setHours(now.getHours() + value);
  if (unit === 'd') now.setDate(now.getDate() + value);
  if (unit === 'm') now.setMinutes(now.getMinutes() + value);
  if (unit === 'w') now.setDate(now.getDate() + (value * 7));
  
  return now.toISOString();
}

// ----------------------------------------
// 👑 SLASH COMMAND: /setexpiry
// ----------------------------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "setexpiry") {
    // 1. Check if user is Admin
    if (interaction.user.id !== ADMIN_ID) {
      return interaction.reply({ content: "❌ Tum ye command use nahi kar sakte!", ephemeral: true });
    }

    const target = interaction.options.getString("target");
    const duration = interaction.options.getString("duration");

    // Calculate new time
    // Special handling for lifetime: hum code mein bohot aage ka date daal denge ya logic change karenge
    // Easy way: Lifetime = 100 years
    let newDate;
    if (duration.toLowerCase() === "lifetime") {
        const d = new Date();
        d.setFullYear(d.getFullYear() + 100);
        newDate = d.toISOString();
    } else {
        newDate = calculateExpiry(duration);
    }

    if (!newDate) return interaction.reply({ content: "❌ Invalid format! Use: 10m, 24h, 2d, 1w", ephemeral: true });

    // Find row by Code OR HWID
    const { data: existing } = await supabase
      .from(TABLE)
      .select("*")
      .or(`code.eq.${target},hwid.eq.${target}`) // Search both columns
      .limit(1)
      .maybeSingle();

    if (!existing) return interaction.reply({ content: `❌ Target "${target}" not found in database.`, ephemeral: true });

    // Update Database
    await supabase
      .from(TABLE)
      .update({ verified: true, expires_at: newDate })
      .eq("id", existing.id);

    return interaction.reply(`✅ **Updated!**\nTarget: \`${target}\`\nNew Expiry: ${duration} from now.\nStatus: Verified.`);
  }
});

// ----------------------------------------
// 📌 NORMAL COMMAND: !verify CODE
// ----------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!verify")) return;

  const args = message.content.split(" ");
  if (args.length < 2) return message.reply("❌ Use: `!verify 123456`");

  const code = args[1];

  // Find Code
  const { data } = await supabase
    .from(TABLE)
    .select("*")
    .eq("code", code)
    .limit(1)
    .maybeSingle();

  if (!data) return message.reply("❌ Invalid Code!");

  // Verify User for 24 Hours
  const now = new Date();
  const expiryTime = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(); // +24 Hours

  await supabase
    .from(TABLE)
    .update({ verified: true, expires_at: expiryTime })
    .eq("id", data.id);

  return message.reply("✅ Verification Success! Access granted for **24 Hours**.");
});

// ----------------------------------------
// 🎯 ROBLOX API: /check?hwid=XXX
// ----------------------------------------
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });

  // 1. Find User by HWID
  const { data: existing } = await supabase
    .from(TABLE)
    .select("*")
    .eq("hwid", hwid)
    .limit(1)
    .maybeSingle();

  // If user exists
  if (existing) {
    const now = new Date();
    
    // Check if Verified AND Time is remaining
    if (existing.verified === true && existing.expires_at && new Date(existing.expires_at) > now) {
      return res.json({ status: "VALID" });
    }

    // Agar Expire ho gaya hai ya Verified nahi hai
    // Return SAME code (Code change nahi hoga)
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }

  // 2. New User -> Create New Record
  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await supabase.from(TABLE).insert([
    {
      hwid: hwid,
      code: code,
      verified: false,
      expires_at: null // New user has no access yet
    }
  ]);

  return res.json({ status: "NEED_VERIFY", code });
});

// 🟢 Keep Alive Route
app.get("/", (req, res) => res.send("System Online 🟢"));

client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`🚀 API on Port ${PORT}`));
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
