const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActivityType, Events } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 10000;
const SUPER_OWNER_ID = "1169492860278669312"; 
const GUILD_ID = "1257403231127076915"; 
const DEFAULT_VERIFY_MS = 18 * 60 * 60 * 1000; // 18 Hours Default
const WARNING_CHANNEL_ID = "1444769950421225542"; 

// Tables
const TABLE = "verifications";
const RULES_TABLE = "role_rules";
const ADMINS_TABLE = "bot_admins";

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers 
  ],
});

// --- COMMANDS ---
const commands = [
  // User Commands
  new SlashCommandBuilder().setName("verify").setDescription("Verify your game access").addStringOption(o => o.setName("code").setDescription("Enter your 6-digit code").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Get help regarding verification"),
  new SlashCommandBuilder().setName("boost").setDescription("Check your role-based boosts & potential time"),

  // Admin Commands
  new SlashCommandBuilder().setName("activeusers").setDescription("Admin: View currently verified users with Names").addIntegerOption(o => o.setName("page").setDescription("Page number")),
  new SlashCommandBuilder().setName("setexpiry").setDescription("Admin: Manual expiry").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)).addStringOption(o => o.setName("duration").setDescription("Time (e.g. 2d)").setRequired(true)),
  new SlashCommandBuilder().setName("ban").setDescription("Admin: Ban user").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
  new SlashCommandBuilder().setName("unban").setDescription("Admin: Unban user").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
  new SlashCommandBuilder().setName("lookup").setDescription("Admin: View details").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
  new SlashCommandBuilder().setName("setrule").setDescription("Admin: Set Role Rule").addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)).addStringOption(o => o.setName("duration").setDescription("e.g. 32h, +1h").setRequired(true)),
  new SlashCommandBuilder().setName("removerule").setDescription("Admin: Remove Role Rule").addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)),
  new SlashCommandBuilder().setName("listrules").setDescription("Admin: List all active rules sorted"),
  new SlashCommandBuilder().setName("resetuser").setDescription("Admin: RESET user data").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot Logged In as: ${client.user.tag}`);
  client.user.setActivity('Squid Game X', { type: ActivityType.Playing });
  try {
    // Refreshing commands to remove duplicates if they exist on Guild level
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("🎉 SUCCESS: All Commands Registered!");
  } catch (error) {
    console.error("❌ Command Error:", error);
  }
});

// --- HELPERS ---

function parseDuration(durationStr) {
  if (!durationStr) return 0;
  if (durationStr.toLowerCase() === "lifetime") return "LIFETIME";
  
  const cleanStr = durationStr.startsWith("+") ? durationStr.substring(1) : durationStr;
  const match = cleanStr.match(/^(\d+)([mhdw])$/);
  if (!match) return 0;

  const val = parseInt(match[1]);
  const unit = match[2];
  let ms = 0;

  if (unit === 'm') ms = val * 60 * 1000;
  if (unit === 'h') ms = val * 60 * 60 * 1000;
  if (unit === 'd') ms = val * 24 * 60 * 60 * 1000;
  if (unit === 'w') ms = val * 7 * 24 * 60 * 60 * 1000;
  return ms;
}

function formatTime(ms) {
  if (ms === "LIFETIME") return "Lifetime";
  if (typeof ms !== 'number' || ms < 0) return 'Expired';

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  let parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  
  if (parts.length === 0) return "0m";
  return parts.join(' ');
}

async function isAdmin(userId) {
  if (userId === SUPER_OWNER_ID) return true;
  const { data } = await supabase.from(ADMINS_TABLE).select("*").eq("discord_id", userId).maybeSingle();
  return !!data;
}

// ---------------------------------------------------------
// 🧠 LOGIC: Calculate Duration Based on Roles
// ---------------------------------------------------------
async function calculateUserDuration(member, rules) {
  let activeRules = rules.map(r => {
    const discordRole = member.roles.cache.get(r.role_id);
    return discordRole ? { ...r, roleName: discordRole.name } : null;
  }).filter(r => r !== null);

  if (activeRules.length === 0) {
    return { duration: DEFAULT_VERIFY_MS, ruleText: "Default (18h)", isPunished: false };
  }

  // 1. Punishment Check
  const punishments = activeRules.filter(r => r.roleName.toLowerCase().startsWith("punish"));
  if (punishments.length > 0) {
    let minMs = Infinity;
    let selectedRule = null;
    punishments.forEach(r => {
      const ms = parseDuration(r.duration);
      if (ms !== "LIFETIME" && ms < minMs) { minMs = ms; selectedRule = r; }
    });
    return { duration: minMs, ruleText: `🚫 ${selectedRule.roleName} (${formatTime(minMs)})`, isPunished: true };
  }

  // 2. Base + Bonus Logic
  const bases = activeRules.filter(r => !r.duration.startsWith("+"));
  const bonuses = activeRules.filter(r => r.duration.startsWith("+"));

  let maxBase = DEFAULT_VERIFY_MS;
  let baseName = "Default";

  bases.forEach(r => {
    const ms = parseDuration(r.duration);
    if (ms === "LIFETIME") { maxBase = "LIFETIME"; baseName = r.roleName; }
    else if (maxBase !== "LIFETIME" && ms > maxBase) { maxBase = ms; baseName = r.roleName; }
  });

  if (maxBase === "LIFETIME") {
    return { duration: "LIFETIME", ruleText: `👑 ${baseName} (Lifetime)`, isPunished: false };
  }

  let totalBonus = 0;
  let bonusNames = [];
  bonuses.forEach(r => {
    totalBonus += parseDuration(r.duration);
    bonusNames.push(`${r.roleName} (${r.duration})`);
  });

  const finalDuration = maxBase + totalBonus;
  const bonusText = bonusNames.length > 0 ? ` + [${bonusNames.join(", ")}]` : "";
  const ruleText = `✅ ${baseName} (${formatTime(maxBase)})${bonusText}`;

  return { duration: finalDuration, ruleText, isPunished: false };
}

// ---------------------------------------------------------
// 🧠 VERIFICATION HANDLER
// ---------------------------------------------------------
async function handleVerification(message, code) {
  const { data: userData } = await supabase.from(TABLE).select("*").eq("code", code).limit(1).maybeSingle();

  if (!userData) return message.reply("❌ **Invalid Code!**");
  if (userData.is_banned) return message.reply("🚫 **BANNED!** Admin has blocked you.");
  
  const isFirstVerification = !userData.verified;

  let calculation;
  try {
    const member = await message.guild.members.fetch(message.author.id);
    const { data: rules } = await supabase.from(RULES_TABLE).select("*");
    calculation = await calculateUserDuration(member, rules || []);
  } catch (e) {
    console.error("Role logic error:", e);
    calculation = { duration: DEFAULT_VERIFY_MS, ruleText: "Error/Default (18h)", isPunished: false };
  }

  const { duration, ruleText, isPunished } = calculation;

  let expiryTime;
  if (duration === "LIFETIME") {
    const d = new Date(); d.setFullYear(d.getFullYear() + 100);
    expiryTime = d.toISOString();
  } else {
    expiryTime = new Date(new Date().getTime() + duration).toISOString();
  }

  // UPDATE DB WITH DISCORD_ID
  await supabase.from(TABLE).update({ 
    verified: true, 
    expires_at: expiryTime,
    discord_id: message.author.id // Saving User ID here
  }).eq("id", userData.id);

  const embedColor = isPunished ? 0xFF0000 : 0x00FF00; 
  
  const mainReply = message.reply({
    content: `✅ Access Granted for <@${message.author.id}>!`, 
    embeds: [{
      color: embedColor,
      title: isPunished ? "⚠️ Access Restricted" : "✅ Verified",
      description: `**Applied Rule:** ${ruleText}\n**Total Validity:** ${formatTime(duration)}`, 
      footer: { text: "Squid Game X Verification" }
    }]
  });
  
  if (isFirstVerification && !isPunished) {
      message.channel.send(`👋 Welcome <@${message.author.id}>! Please share your Roblox username at <#${WARNING_CHANNEL_ID}> to avoid a ban.`);
  }
  
  return mainReply;
}

// --- MESSAGE HANDLER ---
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  
  if (content.toLowerCase().startsWith("verify")) {
    const args = content.split(/\s+/);
    if (args.length < 2) return message.reply("❌ **Use:** `verify 123456`");
    await handleVerification(message, args[1]);
  }

  if (content === "😎") {
    if (message.author.id !== SUPER_OWNER_ID) return; 
    await message.reply("बोलिये सर, आपका टोकन नम्बर क्या है? 🙇‍♂️");
    const filter = (m) => m.author.id === SUPER_OWNER_ID;
    const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });
    collector.on('collect', async (m) => {
      const msg = m.content.toLowerCase();
      const token = m.content.trim();
      if (["chup", "bakwas"].some(w => msg.includes(w))) { await m.reply("Sorry Sir! 🤐"); collector.stop(); return; }
      if(token.length > 3) { await handleVerification(m, token); collector.stop(); }
    });
  }
});

// --- SLASH HANDLER ---
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  if (commandName === "verify") {
    const code = interaction.options.getString("code");
    await interaction.deferReply();
    const fakeMsg = {
      author: interaction.user,
      guild: interaction.guild,
      reply: (opts) => interaction.editReply(opts),
      channel: interaction.channel
    };
    await handleVerification(fakeMsg, code);
    return;
  }

  if (commandName === "help") {
    return interaction.reply({ content: "Use `/verify <code>` to verify.", ephemeral: true });
  }

  if (commandName === "boost") {
    await interaction.deferReply(); // Public as per request
    try {
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const { data: rules } = await supabase.from(RULES_TABLE).select("*");
      const calc = await calculateUserDuration(member, rules || []);
      
      return interaction.editReply({
        embeds: [{
          color: 0xFFA500,
          title: "🚀 Your Boost Status",
          description: `Based on your current roles:\n\n**Applied Logic:** ${calc.ruleText}\n**Potential Time:** ${formatTime(calc.duration)}`
        }]
      });
    } catch(e) {
      return interaction.editReply("Error calculating boost.");
    }
  }

  // --- ADMIN COMMANDS ---
  if (!await isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Not Admin!", ephemeral: true });

  if (commandName === "listrules") {
    await interaction.deferReply();
    const { data: rules } = await supabase.from(RULES_TABLE).select("*");
    if (!rules || !rules.length) return interaction.editReply("ℹ️ No active rules.");
    
    const guild = await client.guilds.fetch(GUILD_ID);
    
    let punishArr = [], baseArr = [], bonusArr = [];

    for (const r of rules) {
       const role = guild.roles.cache.get(r.role_id);
       const name = role ? role.name : "Unknown";
       const ms = parseDuration(r.duration);
       const obj = { name, durationStr: r.duration, ms };

       if (name.toLowerCase().startsWith("punish")) punishArr.push(obj);
       else if (r.duration.startsWith("+")) bonusArr.push(obj);
       else baseArr.push(obj);
    }

    baseArr.sort((a, b) => (b.ms === "LIFETIME" ? 1 : b.ms - a.ms)); 
    bonusArr.sort((a, b) => b.ms - a.ms); 
    punishArr.sort((a, b) => a.ms - b.ms); 

    let msg = "**📜 Active Verification Rules:**\n\n";
    if(punishArr.length) msg += "**👮‍♂️ Punishment:**\n" + punishArr.map(r => `• ${r.name}: **${r.durationStr}**`).join("\n") + "\n\n";
    if(baseArr.length) msg += "**👑 Base Roles:**\n" + baseArr.map(r => `• ${r.name}: **${r.durationStr}**`).join("\n") + "\n\n";
    if(bonusArr.length) msg += "**➕ Bonuses:**\n" + bonusArr.map(r => `• ${r.name}: **${r.durationStr}**`).join("\n");

    return interaction.editReply(msg);
  }

  // UPDATED ACTIVE USERS (Show Name)
  if (commandName === "activeusers") {
    await interaction.deferReply(); 
    const limit = 25;
    const page = interaction.options.getInteger("page") || 1;
    const offset = (page - 1) * limit;
    
    // Fetch discord_id as well
    const { data: activeUsers } = await supabase.from(TABLE)
      .select("code, expires_at, discord_id") 
      .eq("verified", true)
      .gt("expires_at", new Date().toISOString())
      .order("expires_at", { ascending: true })
      .range(offset, offset + limit - 1);
      
    let listMsg = `**📜 Active Users (Page ${page}):**\n\n`;
    if (!activeUsers || !activeUsers.length) listMsg += "No users found.";
    else {
        activeUsers.forEach((u, i) => {
             const left = new Date(u.expires_at).getTime() - Date.now();
             // Show User Mention
             const userStr = u.discord_id ? `<@${u.discord_id}>` : "Unknown";
             listMsg += `**${offset + i + 1}.** \`${u.code}\` | ${userStr} | ${formatTime(left)}\n`;
        });
    }
    return interaction.editReply(listMsg);
  }

  // ... (Other admin commands remain same)
  if (commandName === "setexpiry") {
    await interaction.deferReply();
    const duration = interaction.options.getString("duration");
    const ms = parseDuration(duration);
    if (!ms) return interaction.editReply("❌ Invalid");
    const target = interaction.options.getString("target");
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.editReply("❌ Not Found");
    let newDate = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString();
    await supabase.from(TABLE).update({ verified: true, expires_at: newDate, is_banned: false }).eq("id", data.id);
    return interaction.editReply(`✅ Updated ${target} for ${formatTime(ms)}`);
  }
  if (commandName === "ban") {
      await interaction.deferReply();
      const target = interaction.options.getString("target");
      const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
      if (!data) return interaction.editReply("❌ Not Found");
      await supabase.from(TABLE).update({ is_banned: true, verified: false }).eq("id", data.id);
      return interaction.editReply(`🚫 Banned ${target}`);
  }
  if (commandName === "unban") {
      await interaction.deferReply();
      const target = interaction.options.getString("target");
      const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
      if (!data) return interaction.editReply("❌ Not Found");
      await supabase.from(TABLE).update({ is_banned: false }).eq("id", data.id);
      return interaction.editReply(`✅ Unbanned ${target}`);
  }
  if (commandName === "lookup") {
      await interaction.deferReply();
      const target = interaction.options.getString("target");
      const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
      if (!data) return interaction.editReply("❌ Not Found");
      const status = data.is_banned ? "🚫 BANNED" : (data.verified ? "✅ VERIFIED" : "❌ NOT VERIFIED");
      const expiry = data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime() / 1000)}:R>` : "No Session";
      return interaction.editReply(`**Details:**\nCode: \`${data.code}\`\nHWID: \`${data.hwid}\`\nStatus: ${status}\nExpiry: ${expiry}`);
  }
  if (commandName === "resetuser") {
      await interaction.deferReply();
      const target = interaction.options.getString("target");
      const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
      if (!data) return interaction.editReply("❌ Not Found");
      await supabase.from(TABLE).delete().eq("id", data.id);
      return interaction.editReply(`🗑️ Reset ${target}`);
  }
  if (commandName === "setrule") {
      await interaction.deferReply();
      const role = interaction.options.getRole("role");
      const duration = interaction.options.getString("duration");
      const { data: existing } = await supabase.from(RULES_TABLE).select("*").eq("role_id", role.id).maybeSingle();
      if (existing) await supabase.from(RULES_TABLE).update({ duration }).eq("id", existing.id);
      else await supabase.from(RULES_TABLE).insert([{ role_id: role.id, duration }]);
      return interaction.editReply(`✅ Rule Set: ${role.name} = ${duration}`);
  }
  if (commandName === "removerule") {
      await interaction.deferReply();
      const role = interaction.options.getRole("role");
      await supabase.from(RULES_TABLE).delete().eq("role_id", role.id);
      return interaction.editReply(`✅ Rule Removed: ${role.name}`);
  }
});

app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });
  const { data: existing } = await supabase.from(TABLE).select("*").eq("hwid", hwid).maybeSingle();
  if (existing) {
    if (existing.is_banned) return res.json({ status: "BANNED", message: "Contact Admin" });
    if (existing.verified && new Date(existing.expires_at) > new Date()) return res.json({ status: "VALID" });
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await supabase.from(TABLE).insert([{ hwid, code, verified: false, is_banned: false }]);
  return res.json({ status: "NEED_VERIFY", code });
});

app.get("/", (req, res) => res.send("System Online 🟢"));
client.login(process.env.DISCORD_BOT_TOKEN);
app.listen(PORT, () => console.log(`🚀 API Running on Port ${PORT}`));
