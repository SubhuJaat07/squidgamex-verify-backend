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
const RULES_TABLE = "role_rules";

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
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers // Role check karne ke liye zaruri hai
  ],
});

// --- SLASH COMMANDS SETUP ---
const commands = [
  // 1. Set Custom Expiry (Manual)
  new SlashCommandBuilder()
    .setName("setexpiry")
    .setDescription("Admin: Set manual expiry for a user")
    .addStringOption(o => o.setName("target").setDescription("Code or HWID").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("e.g. 30m, 6h, 2d").setRequired(true)),

  // 2. Ban User
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Admin: Ban a user/HWID from using the key system")
    .addStringOption(o => o.setName("target").setDescription("Code or HWID").setRequired(true)),

  // 3. Unban User
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Admin: Unban a user")
    .addStringOption(o => o.setName("target").setDescription("Code or HWID").setRequired(true)),

  // 4. Lookup User Details
  new SlashCommandBuilder()
    .setName("lookup")
    .setDescription("Admin: View details of a Code/HWID")
    .addStringOption(o => o.setName("target").setDescription("Code or HWID").setRequired(true)),

  // 5. Set Role Rule (Automatic Expiry)
  new SlashCommandBuilder()
    .setName("setrule")
    .setDescription("Admin: Set auto-expiry duration for a specific Role")
    .addRoleOption(o => o.setName("role").setDescription("Select Role").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("e.g. 48h, 7d").setRequired(true)),

  // 6. List Active Rules
  new SlashCommandBuilder()
    .setName("listrules")
    .setDescription("Admin: See all active role-based rules"),

].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once("ready", async () => {
  console.log(`✅ Bot Logged In as: ${client.user.tag}`);
  try {
    await rest.put(
      Routes.applicationGuildCommands(client.user.id, GUILD_ID), 
      { body: commands }
    );
    console.log("🎉 SUCCESS: Advanced Admin Commands Registered!");
  } catch (error) {
    console.error("❌ Command Error:", error);
  }
});

// ---------------------------------------------------------
// 🛠️ HELPER: Time Calculation
// ---------------------------------------------------------
function getFutureDate(durationStr) {
  if (durationStr.toLowerCase() === "lifetime") {
    const d = new Date(); d.setFullYear(d.getFullYear() + 100); return d.toISOString();
  }
  const match = durationStr.match(/^(\d+)([mhdw])$/);
  if (!match) return null;

  const val = parseInt(match[1]);
  const unit = match[2];
  const now = new Date();

  if (unit === 'm') now.setMinutes(now.getMinutes() + val);
  if (unit === 'h') now.setHours(now.getHours() + val);
  if (unit === 'd') now.setDate(now.getDate() + val);
  if (unit === 'w') now.setDate(now.getDate() + (val * 7));
  
  return now.toISOString();
}

// ---------------------------------------------------------
// 🔐 VERIFICATION LOGIC (With Ban & Role Check)
// ---------------------------------------------------------
async function handleVerification(message, code) {
  // 1. Fetch User Data
  const { data: userData } = await supabase.from(TABLE).select("*").eq("code", code).limit(1).maybeSingle();

  if (!userData) return message.reply("❌ **Invalid Code!**");

  // 2. CHECK BAN STATUS
  if (userData.is_banned) {
    return message.reply("🚫 **YOU ARE BANNED!**\nAdmin has blocked your access.");
  }

  // 3. CHECK ROLE RULES (Dynamic Duration)
  let durationToAdd = 24 * 60 * 60 * 1000; // Default 24 Hours
  let appliedRule = "Default (24h)";

  try {
    // Get user roles from Discord
    const member = await message.guild.members.fetch(message.author.id);
    const userRoleIds = member.roles.cache.map(r => r.id);

    // Fetch rules from DB
    const { data: rules } = await supabase.from(RULES_TABLE).select("*");

    if (rules && rules.length > 0) {
      // Check if user has any role that matches a rule
      for (const rule of rules) {
        if (userRoleIds.includes(rule.role_id)) {
          // Calculate milliseconds for this rule
          const future = getFutureDate(rule.duration);
          if (future) {
            durationToAdd = new Date(future).getTime() - new Date().getTime();
            appliedRule = `Role Special (${rule.duration})`;
            break; // First matching rule wins
          }
        }
      }
    }
  } catch (e) {
    console.log("Role fetch error (User might be outside server?):", e);
  }

  // 4. Update DB
  const expiryTime = new Date(new Date().getTime() + durationToAdd).toISOString();
  await supabase.from(TABLE).update({ verified: true, expires_at: expiryTime }).eq("id", userData.id);

  return message.reply(`✅ **Access Granted!**\n⏱️ Validity: **${appliedRule}**\n🎮 Enjoy your game!`);
}

// ---------------------------------------------------------
// 💬 MESSAGE HANDLER
// ---------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();

  // 👉 Admin Emoji "😎"
  if (content === "😎") {
    if (message.author.id !== ADMIN_ID) return; 
    await message.reply("बोलिये सर, आपका टोकन नम्बर क्या है? 🙇‍♂️");

    const filter = (m) => m.author.id === ADMIN_ID;
    const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

    collector.on('collect', async (m) => {
      const msg = m.content.toLowerCase();
      const token = m.content.trim();

      const scoldWords = ["chup", "bakwas", "shant", "bol mat", "silence", "gyan mat"];
      if (scoldWords.some(word => msg.includes(word))) {
          await m.reply("Sorry Sir, My mistake! Main chup ho jata hu. 🤐");
          collector.stop();
          return;
      }
      if(token.length > 3) { 
          await handleVerification(m, token);
          collector.stop();
      }
    });
    return;
  }

  // 👉 Public Verify
  if (content.toLowerCase().startsWith("verify")) {
    const args = content.split(/\s+/);
    if (args.length < 2) return message.reply("❌ **Use:** `verify 123456`");
    await handleVerification(message, args[1]);
  }
});

// ---------------------------------------------------------
// ⚔️ SLASH COMMAND HANDLER (New Admin Powers)
// ---------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  // Security Check (Sab commands ke liye)
  if (interaction.user.id !== ADMIN_ID) {
    return interaction.reply({ content: "❌ Sirf Admin (Subhu Boss) ye kar sakte hain!", ephemeral: true });
  }

  const { commandName } = interaction;
  const target = interaction.options.getString("target");

  // --- 1. SET EXPIRY (Manual) ---
  if (commandName === "setexpiry") {
    const duration = interaction.options.getString("duration");
    const newDate = getFutureDate(duration);
    if (!newDate) return interaction.reply({ content: "❌ Invalid format! Use: 10m, 24h, 2d", ephemeral: true });

    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found.");

    await supabase.from(TABLE).update({ verified: true, expires_at: newDate, is_banned: false }).eq("id", data.id);
    return interaction.reply(`✅ **Updated!** ${target} is verified for ${duration}.`);
  }

  // --- 2. BAN USER ---
  if (commandName === "ban") {
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found.");

    await supabase.from(TABLE).update({ is_banned: true, verified: false }).eq("id", data.id);
    return interaction.reply(`🚫 **BANNED!** Target \`${target}\` has been blocked from the system.`);
  }

  // --- 3. UNBAN USER ---
  if (commandName === "unban") {
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found.");

    await supabase.from(TABLE).update({ is_banned: false }).eq("id", data.id);
    return interaction.reply(`✅ **Unbanned!** Target \`${target}\` is free now.`);
  }

  // --- 4. LOOKUP (View Verified) ---
  if (commandName === "lookup") {
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found in database.");

    const status = data.is_banned ? "🚫 BANNED" : (data.verified ? "✅ VERIFIED" : "❌ NOT VERIFIED");
    const expiry = data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime() / 1000)}:R>` : "No Active Session";

    return interaction.reply(`
**🔍 User Details:**
• **HWID:** \`${data.hwid}\`
• **Code:** \`${data.code}\`
• **Status:** ${status}
• **Expiry:** ${expiry}
    `);
  }

  // --- 5. SET ROLE RULE ---
  if (commandName === "setrule") {
    const role = interaction.options.getRole("role");
    const duration = interaction.options.getString("duration");
    
    // Check format
    if (!getFutureDate(duration)) return interaction.reply("❌ Invalid Time! Use: 24h, 2d, 30m");

    // Check if rule exists, update or insert
    const { data: existing } = await supabase.from(RULES_TABLE).select("*").eq("role_id", role.id).maybeSingle();
    
    if (existing) {
      await supabase.from(RULES_TABLE).update({ duration: duration }).eq("id", existing.id);
    } else {
      await supabase.from(RULES_TABLE).insert([{ role_id: role.id, duration: duration }]);
    }
    return interaction.reply(`✅ **Rule Set!** Role **${role.name}** now gets **${duration}** validity.`);
  }

  // --- 6. LIST RULES ---
  if (commandName === "listrules") {
    const { data: rules } = await supabase.from(RULES_TABLE).select("*");
    if (!rules || rules.length === 0) return interaction.reply("ℹ️ No active rules found. Default is 24h.");

    let msg = "**📜 Active Role Rules:**\n";
    rules.forEach(r => {
      msg += `• <@&${r.role_id}> : **${r.duration}**\n`;
    });
    return interaction.reply(msg);
  }
});

// --- API ---
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });

  const { data: existing } = await supabase.from(TABLE).select("*").eq("hwid", hwid).maybeSingle();

  if (existing) {
    // 🛑 BAN CHECK IN API
    if (existing.is_banned) return res.json({ status: "BANNED", message: "Contact Admin" });

    const now = new Date();
    if (existing.verified === true && existing.expires_at && new Date(existing.expires_at) > now) {
      return res.json({ status: "VALID" });
    }
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await supabase.from(TABLE).insert([{ hwid: hwid, code: code, verified: false, expires_at: null, is_banned: false }]);
  return res.json({ status: "NEED_VERIFY", code });
});

app.get("/", (req, res) => res.send("System Online 🟢"));
client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`🚀 API Running on Port ${PORT}`));
