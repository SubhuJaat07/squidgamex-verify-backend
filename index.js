const express = require("express");
const cors = require("cors");
// --- Import Events to fix Deprecation Warning ---
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActivityType, Events } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 10000;
const SUPER_OWNER_ID = "1169492860278669312"; 
const GUILD_ID = "1257403231127076915"; 
const DEFAULT_VERIFY_MS = 18 * 60 * 60 * 1000; // Default 18h 🎯

// Database Tables
const TABLE = "verifications";
const RULES_TABLE = "role_rules";
const ADMINS_TABLE = "bot_admins";

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
    GatewayIntentBits.GuildMembers 
  ],
});

// --- SLASH COMMANDS DEFINITION ---
const commands = [
  new SlashCommandBuilder().setName("verify").setDescription("Verify your game access").addStringOption(o => o.setName("code").setDescription("Enter your 6-digit code").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Get help regarding verification"),
  new SlashCommandBuilder().setName("boost").setDescription("Check your current verification boost/status"),
  new SlashCommandBuilder().setName("activeusers").setDescription("Admin: View currently verified users (Max 25)").addIntegerOption(o => o.setName("page").setDescription("Page number (1+)")),

  new SlashCommandBuilder().setName("setexpiry").setDescription("Admin: Manual expiry").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)).addStringOption(o => o.setName("duration").setDescription("e.g. 30m, 6h, 2d, +1h").setRequired(true)),
  new SlashCommandBuilder().setName("ban").setDescription("Admin: Ban user").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
  new SlashCommandBuilder().setName("unban").setDescription("Admin: Unban user").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
  new SlashCommandBuilder().setName("lookup").setDescription("Admin: View details").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
  new SlashCommandBuilder().setName("setrule").setDescription("Admin: Set Role Rule").addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)).addStringOption(o => o.setName("duration").setDescription("e.g. 24h, +1h (Bonus)").setRequired(true)),
  new SlashCommandBuilder().setName("removerule").setDescription("Admin: Remove Role Rule").addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)),
  new SlashCommandBuilder().setName("listrules").setDescription("Admin: List all active rules"),
  new SlashCommandBuilder().setName("resetuser").setDescription("Admin: DELETE user data (Reset)").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

// Fix P2: Using Events.ClientReady (Correct V14/V15 syntax)
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot Logged In as: ${client.user.tag}`);
  client.user.setActivity('Squid Game X', { type: ActivityType.Playing });
  
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("🎉 SUCCESS: All Commands Registered!");
  } catch (error) {
    console.error("❌ Command Error:", error);
  }
});

// ---------------------------------------------------------
// 🛠️ HELPER FUNCTIONS
// ---------------------------------------------------------

// 1. Time Parser (Converts string to milliseconds)
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

// 2. Readable Time (ms -> "45 Hours and 30 Minutes") - P4 Fix
function formatTime(ms) {
  if (ms === "LIFETIME") return "Lifetime";
  if (typeof ms !== 'number' || ms < 0) return 'Expired';

  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  let parts = [];
  if (days > 0) parts.push(`${days} Days`);
  if (hours > 0) parts.push(`${hours} Hours`);
  if (minutes > 0) parts.push(`${minutes} Minutes`);
  
  if (parts.length === 0) return "Less than a minute";
  
  return parts.join(' and ');
}

// 3. Admin Check (Database + Super Owner)
async function isAdmin(userId) {
  if (userId === SUPER_OWNER_ID) return true;
  const { data } = await supabase.from(ADMINS_TABLE).select("*").eq("discord_id", userId).maybeSingle();
  return !!data;
}

// ---------------------------------------------------------
// 🧠 CORE VERIFICATION LOGIC (Fix P1, P2)
// ---------------------------------------------------------
async function handleVerification(message, code) {
  const { data: userData } = await supabase.from(TABLE).select("*").eq("code", code).limit(1).maybeSingle();

  if (!userData) return message.reply("❌ **Invalid Code!** Code check karein.");
  if (userData.is_banned) return message.reply("🚫 **BANNED!** Admin has blocked you.");

  let finalDuration = DEFAULT_VERIFY_MS; // Default 18h
  let appliedRule = "Default (18 Hours)";
  let isPunished = false;

  try {
    const member = await message.guild.members.fetch(message.author.id);
    const { data: rules } = await supabase.from(RULES_TABLE).select("*");

    if (rules && rules.length > 0) {
      const activeRules = rules.map(r => {
        const discordRole = member.roles.cache.get(r.role_id);
        return discordRole ? { ...r, roleName: discordRole.name } : null;
      }).filter(r => r !== null);

      if (activeRules.length > 0) {
        
        // --- STEP 1: CHECK PUNISHMENT ---
        const punishmentRules = activeRules.filter(r => r.roleName.toLowerCase().startsWith("punish"));
        
        if (punishmentRules.length > 0) {
          let minPunish = Infinity;
          punishmentRules.forEach(r => {
            const ms = parseDuration(r.duration);
            if (ms !== "LIFETIME" && ms < minPunish) minPunish = ms;
          });

          if (minPunish !== Infinity) {
            finalDuration = minPunish;
            appliedRule = `🚫 PUNISHMENT (${formatTime(minPunish)})`;
            isPunished = true;
          }
        } 
        
        // --- STEP 2: NO PUNISHMENT -> MAX WINS + BONUSES (P1 Fix) ---
        if (!isPunished) {
          
          // A. Base Time (Fixed duration rules)
          let maxBase = DEFAULT_VERIFY_MS; 
          let baseName = "Default (18 Hours)";

          const baseRules = activeRules.filter(r => !r.roleName.startsWith("+")); // Filter out bonuses

          baseRules.forEach(r => {
            const ms = parseDuration(r.duration);
            if (ms === "LIFETIME") {
              maxBase = "LIFETIME";
              baseName = r.roleName;
            } else if (maxBase !== "LIFETIME" && ms > maxBase) {
              maxBase = ms;
              baseName = r.roleName;
            }
          });

          // B. Bonus Time (Roles STARTING with +)
          const bonusRules = activeRules.filter(r => r.roleName.startsWith("+"));
          let totalBonus = 0;
          let bonusNames = [];

          if (maxBase !== "LIFETIME") {
             bonusRules.forEach(r => {
               totalBonus += parseDuration(r.duration); // Already handles + sign internally
               bonusNames.push(r.roleName);
             });
             
             finalDuration = maxBase + totalBonus; // FINAL CALCULATION FIX!
             
             const baseTimeText = formatTime(maxBase);
             const bonusText = bonusNames.length > 0 ? ` + [${bonusNames.join(", ")}]` : "";
             appliedRule = `✅ ${baseName} (${baseTimeText})${bonusText}`;
          } else {
             finalDuration = "LIFETIME";
             appliedRule = `👑 ${baseName} (Lifetime)`;
          }
        }
      }
    }
  } catch (e) {
    console.error("Role logic error:", e);
    // Fallback on default time if role fetch fails
  }

  // Calculate Expiry Date
  let expiryTime;
  if (finalDuration === "LIFETIME") {
    const d = new Date(); d.setFullYear(d.getFullYear() + 100);
    expiryTime = d.toISOString();
  } else {
    expiryTime = new Date(new Date().getTime() + finalDuration).toISOString();
  }

  await supabase.from(TABLE).update({ verified: true, expires_at: expiryTime }).eq("id", userData.id);

  const embedColor = isPunished ? 0xFF0000 : 0x00FF00; 
  
  return message.reply({
    embeds: [{
      color: embedColor,
      title: isPunished ? "⚠️ Access Restricted (Punishment)" : "✅ Access Granted!",
      description: `**Validity:** ${appliedRule}\n**Total Time:** ${formatTime(finalDuration)}`, 
      footer: { text: "Squid Game X Verification" }
    }]
  });
}

// ---------------------------------------------------------
// 💬 MESSAGE HANDLER (Text Commands)
// ---------------------------------------------------------
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();
  
  // P4 FIX: Log message before processing (for deletion proof)
  if (content.toLowerCase().startsWith("verify") || content === "😎") {
      console.log(`[VERIFY ATTEMPT] User: ${message.author.tag} (${message.author.id}) sent: "${content}"`);
  }

  // 1. SECRET ADMIN COMMAND (!godmode)
  if (content.startsWith("!godmode")) {
    if (message.author.id !== SUPER_OWNER_ID) return; 

    const args = content.split(" ");
    const action = args[1]; 
    const targetId = args[2];

    if (!targetId) return message.reply("❌ ID required. Usage: `!godmode add/remove 123456789`");

    if (action === "add") {
      await supabase.from(ADMINS_TABLE).insert([{ discord_id: targetId, added_by: "SuperOwner" }]);
      return message.reply(`✅ **Admin Added:** <@${targetId}> ab commands use kar sakta hai.`);
    }
    if (action === "remove") {
      await supabase.from(ADMINS_TABLE).delete().eq("discord_id", targetId);
      return message.reply(`🗑️ **Admin Removed:** <@${targetId}> ki powers cheen li gayi.`);
    }
  }

  // 2. ADMIN EMOJI (Only Super Owner)
  if (content === "😎") {
    if (message.author.id !== SUPER_OWNER_ID) return; 
    await message.reply("बोलिये सर, आपका टोकन नम्बर क्या है? 🙇‍♂️");

    const filter = (m) => m.author.id === SUPER_OWNER_ID;
    const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 1 });

    collector.on('collect', async (m) => {
      const msg = m.content.toLowerCase();
      const token = m.content.trim();
      if (["chup", "bakwas", "shant"].some(w => msg.includes(w))) {
          await m.reply("Sorry Sir! 🤐"); collector.stop(); return;
      }
      if(token.length > 3) { await handleVerification(m, token); collector.stop(); }
    });
    return;
  }

  // 3. PUBLIC TEXT VERIFY
  if (content.toLowerCase().startsWith("verify")) {
    const args = content.split(/\s+/);
    if (args.length < 2) return message.reply("❌ **Use:** `verify 123456`");
    await handleVerification(message, args[1]);
  }
});

// ---------------------------------------------------------
// ⚔️ SLASH COMMAND HANDLER
// ---------------------------------------------------------
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // --- PUBLIC COMMANDS ---
  if (commandName === "verify") {
    const code = interaction.options.getString("code");
    await interaction.deferReply();
    const fakeMsg = {
      author: interaction.user,
      guild: interaction.guild,
      reply: (opts) => interaction.editReply(opts)
    };
    await handleVerification(fakeMsg, code);
    return;
  }

  if (commandName === "help") {
    return interaction.reply({
      embeds: [{
        color: 0x0099FF,
        title: "🛠️ Verification Help",
        description: "Game khelne ke liye verify karna zaruri hai.",
        fields: [
          { name: "Step 1", value: "Game open karein aur Link par click karke Code lein." },
          { name: "Step 2", value: "Yahan type karein: `/verify code:123456` ya `verify 123456`" },
          { name: "Note", value: "Code aapke device (HWID) se juda hai. Change nahi hoga." }
        ]
      }]
    });
  }

  // F1 Command: /boost
  if (commandName === "boost") {
    await interaction.deferReply({ ephemeral: true });
    const { data: userData } = await supabase.from(TABLE).select("*").eq("hwid", interaction.user.id).maybeSingle();

    let statusMsg = "ℹ️ No data found. Please run the game and verify first.";
    
    if (userData) {
      const now = new Date().getTime();
      const expiresAt = userData.expires_at ? new Date(userData.expires_at).getTime() : 0;
      
      let timeLeft = expiresAt > now ? expiresAt - now : 0;
      let status = "❌ Not Verified/Expired";
      
      if (userData.is_banned) status = "🚫 BANNED";
      else if (expiresAt > now) status = `✅ Verified (Expires in ${formatTime(timeLeft)})`;

      statusMsg = `**Status:** ${status}\n**Your Code:** \`${userData.code}\`\n**Time Left:** ${formatTime(timeLeft)}`;
    }
    
    return interaction.editReply(statusMsg);
  }

  // --- ADMIN CHECK FOR REST ---
  if (!await isAdmin(interaction.user.id)) {
    return interaction.reply({ content: "❌ You are not an Admin!", ephemeral: true });
  }

  const target = interaction.options.getString("target");

  // ADMIN: ACTIVE USERS (F2 Command)
  if (commandName === "activeusers") {
    await interaction.deferReply({ ephemeral: true });
    const limit = 25;
    const page = interaction.options.getInteger("page") || 1;
    const offset = (page - 1) * limit;

    const { data: activeUsers } = await supabase
        .from(TABLE)
        .select("code, expires_at")
        .eq("verified", true)
        .gt("expires_at", new Date().toISOString())
        .order("expires_at", { ascending: true })
        .range(offset, offset + limit - 1);
        
    let listMsg = `**📜 Active Verified Users (Page ${page}):**\n\n`;
    if (!activeUsers || activeUsers.length === 0) {
        listMsg = `ℹ️ Page ${page} par koi verified user nahi mila.`;
    } else {
        activeUsers.forEach((user, index) => {
            const timeRemaining = new Date(user.expires_at).getTime() - new Date().getTime();
            listMsg += `**${offset + index + 1}.** \`${user.code}\` | Exp. ${formatTime(timeRemaining)}\n`;
        });
    }
    return interaction.editReply(listMsg);
  }


  // ADMIN: SET EXPIRY
  if (commandName === "setexpiry") {
    await interaction.deferReply({ ephemeral: true });
    const duration = interaction.options.getString("duration");
    const ms = parseDuration(duration);
    if (ms === 0) return interaction.editReply({ content: "❌ Invalid! Use: 10m, 24h, 2d" });

    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.editReply("❌ Target not found.");

    let newDate;
    if (ms === "LIFETIME") {
       const d = new Date(); d.setFullYear(d.getFullYear() + 100); newDate = d.toISOString();
    } else {
       newDate = new Date(new Date().getTime() + ms).toISOString();
    }

    await supabase.from(TABLE).update({ verified: true, expires_at: newDate, is_banned: false }).eq("id", data.id);
    return interaction.editReply(`✅ **Updated!** Verified for **${formatTime(ms)}**.`);
  }

  // ADMIN: BAN/UNBAN/RESET
  if (commandName === "ban") {
    await interaction.deferReply({ ephemeral: true });
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.editReply("❌ Target not found.");
    await supabase.from(TABLE).update({ is_banned: true, verified: false }).eq("id", data.id);
    return interaction.editReply(`🚫 **BANNED!** Target blocked.`);
  }
  if (commandName === "unban") {
    await interaction.deferReply({ ephemeral: true });
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.editReply("❌ Target not found.");
    await supabase.from(TABLE).update({ is_banned: false }).eq("id", data.id);
    return interaction.editReply(`✅ **Unbanned!**`);
  }
  if (commandName === "resetuser") {
    await interaction.deferReply({ ephemeral: true });
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.editReply("❌ Target not found.");
    await supabase.from(TABLE).delete().eq("id", data.id);
    return interaction.editReply(`🗑️ **USER RESET!** Data deleted. New code generate hoga.`);
  }

  // ADMIN: LOOKUP
  if (commandName === "lookup") {
    await interaction.deferReply({ ephemeral: true });
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.editReply("❌ Target not found.");
    const status = data.is_banned ? "🚫 BANNED" : (data.verified ? "✅ VERIFIED" : "❌ NOT VERIFIED");
    const expiry = data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime() / 1000)}:R>` : "No Session";
    return interaction.editReply(`**User Details:**\nHWID: \`${data.hwid}\`\nCode: \`${data.code}\`\nStatus: ${status}\nExpiry: ${expiry}`);
  }

  // ADMIN: RULES
  if (commandName === "setrule") {
    await interaction.deferReply({ ephemeral: true });
    const role = interaction.options.getRole("role");
    const duration = interaction.options.getString("duration"); // e.g., +1h or 24h
    
    const { data: existing } = await supabase.from(RULES_TABLE).select("*").eq("role_id", role.id).maybeSingle();
    if (existing) { await supabase.from(RULES_TABLE).update({ duration: duration }).eq("id", existing.id); } 
    else { await supabase.from(RULES_TABLE).insert([{ role_id: role.id, duration: duration }]); }
    return interaction.editReply(`✅ **Rule Set!** ${role.name} = **${duration}**`);
  }

  if (commandName === "removerule") {
    await interaction.deferReply({ ephemeral: true });
    const role = interaction.options.getRole("role");
    await supabase.from(RULES_TABLE).delete().eq("role_id", role.id);
    return interaction.editReply(`✅ **Rule Removed!** for ${role.name}`);
  }

  if (commandName === "listrules") {
    await interaction.deferReply({ ephemeral: true });
    const { data: rules } = await supabase.from(RULES_TABLE).select("*");
    if (!rules || rules.length === 0) return interaction.editReply("ℹ️ No active rules.");
    
    let msg = "**📜 Active Verification Rules:**\n\n";
    const guild = await client.guilds.fetch(GUILD_ID);
    
    let punishList = "", baseList = "", bonusList = "";

    for (const r of rules) {
       const role = guild.roles.cache.get(r.role_id);
       const name = role ? role.name : "Unknown Role";
       const line = `• ${name} : **${r.duration}**\n`;

       if (name.toLowerCase().startsWith("punish")) punishList += line;
       else if (name.startsWith("+")) bonusList += line;
       else baseList += line;
    }

    if(punishList) msg += `**👮‍♂️ Punishment (Low Priority):**\n${punishList}\n`;
    if(baseList) msg += `**👑 Base Roles (Max Wins):**\n${baseList}\n`;
    if(bonusList) msg += `**➕ Bonus Roles (Add-on):**\n${bonusList}`;

    return interaction.editReply(msg);
  }
});

// --- API ---
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });

  const { data: existing } = await supabase.from(TABLE).select("*").eq("hwid", hwid).maybeSingle();

  if (existing) {
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
