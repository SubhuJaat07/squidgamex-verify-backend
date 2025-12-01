const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ActivityType } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 10000;
const SUPER_OWNER_ID = "1169492860278669312"; // Subhu Jaat (Ye ID God hai)
const GUILD_ID = "1257403231127076915"; // Server ID

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
  // 🟢 User Commands
  new SlashCommandBuilder().setName("verify").setDescription("Verify your game access").addStringOption(o => o.setName("code").setDescription("Enter your 6-digit code").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("Get help regarding verification"),

  // 🔴 Admin Commands
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

client.once("ready", async () => {
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
  
  // Handle "+" for bonus (e.g., "+1h") - remove + for calculation
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

// 2. Readable Time (ms -> "2 Hours")
function formatTime(ms) {
  if (ms === "LIFETIME") return "Lifetime";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days} Days`;
  if (hours > 0) return `${hours} Hours`;
  if (minutes > 0) return `${minutes} Minutes`;
  return `${seconds} Seconds`;
}

// 3. Admin Check (Database + Super Owner)
async function isAdmin(userId) {
  if (userId === SUPER_OWNER_ID) return true;
  const { data } = await supabase.from(ADMINS_TABLE).select("*").eq("discord_id", userId).maybeSingle();
  return !!data;
}

// ---------------------------------------------------------
// 🧠 CORE VERIFICATION LOGIC (The Brain)
// ---------------------------------------------------------
async function handleVerification(message, code) {
  const { data: userData } = await supabase.from(TABLE).select("*").eq("code", code).limit(1).maybeSingle();

  if (!userData) return message.reply("❌ **Invalid Code!** Code check karein.");
  if (userData.is_banned) return message.reply("🚫 **BANNED!** Admin has blocked you.");

  let finalDuration = 18 * 60 * 60 * 1000; // Default 24h
  let appliedRule = "Default (24 Hours)";
  let isPunished = false;

  try {
    const member = await message.guild.members.fetch(message.author.id);
    const { data: rules } = await supabase.from(RULES_TABLE).select("*");

    if (rules && rules.length > 0) {
      // Filter roles user actually has
      const activeRules = rules.map(r => {
        const discordRole = member.roles.cache.get(r.role_id);
        return discordRole ? { ...r, roleName: discordRole.name } : null;
      }).filter(r => r !== null);

      if (activeRules.length > 0) {
        // --- STEP 1: CHECK PUNISHMENT (Name starts with "Punish") ---
        const punishmentRules = activeRules.filter(r => r.roleName.toLowerCase().startsWith("punish"));
        
        if (punishmentRules.length > 0) {
          // Find lowest duration among punishments
          let minPunish = Infinity;
          let selectedRule = null;
          
          punishmentRules.forEach(r => {
            const ms = parseDuration(r.duration);
            if (ms !== "LIFETIME" && ms < minPunish) {
              minPunish = ms;
              selectedRule = r;
            }
          });

          if (selectedRule) {
            finalDuration = minPunish;
            appliedRule = `🚫 ${selectedRule.roleName} (${formatTime(minPunish)})`;
            isPunished = true;
          }
        } 
        else {
          // --- STEP 2: NO PUNISHMENT -> MAX WINS + BONUSES ---
          
          // A. Base Time (Roles NOT starting with +)
          const baseRules = activeRules.filter(r => !r.roleName.startsWith("+"));
          let maxBase = 24 * 60 * 60 * 1000; // Minimum 24h default
          let baseName = "Default";

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
               const ms = parseDuration(r.duration);
               totalBonus += ms;
               bonusNames.push(r.roleName);
             });
             finalDuration = maxBase + totalBonus;
             
             const bonusText = bonusNames.length > 0 ? ` + [${bonusNames.join(", ")}]` : "";
             appliedRule = `✅ ${baseName} (${formatTime(maxBase)})${bonusText}`;
          } else {
             finalDuration = "LIFETIME";
             appliedRule = `👑 ${baseName} (Lifetime)`;
          }
        }
      }
    }
  } catch (e) {
    console.log("Role logic error:", e);
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

  const embedColor = isPunished ? 0xFF0000 : 0x00FF00; // Red for punish, Green for success
  
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

  // 1. SECRET ADMIN COMMAND (!godmode)
  if (content.startsWith("!godmode")) {
    if (message.author.id !== SUPER_OWNER_ID) return; // Only YOU can use this

    const args = content.split(" ");
    const action = args[1]; // add or remove
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
    // Reuse the same logic, passing interaction as 'message' (need small tweak or just duplicate logic)
    // For simplicity in this structure, we'll reply to text based mostly, but here is a quick bridge:
    await interaction.deferReply();
    // Simulate message object for our helper function
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

  // --- ADMIN CHECK FOR REST ---
  if (!await isAdmin(interaction.user.id)) {
    return interaction.reply({ content: "❌ You are not an Admin!", ephemeral: true });
  }

  const target = interaction.options.getString("target");

  // ADMIN: SET EXPIRY
  if (commandName === "setexpiry") {
    const duration = interaction.options.getString("duration");
    const ms = parseDuration(duration);
    if (ms === 0) return interaction.reply({ content: "❌ Invalid! Use: 10m, 24h, 2d", ephemeral: true });

    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found.");

    let newDate;
    if (ms === "LIFETIME") {
       const d = new Date(); d.setFullYear(d.getFullYear() + 100); newDate = d.toISOString();
    } else {
       newDate = new Date(new Date().getTime() + ms).toISOString();
    }

    await supabase.from(TABLE).update({ verified: true, expires_at: newDate, is_banned: false }).eq("id", data.id);
    return interaction.reply(`✅ **Updated!** Verified for **${duration}**.`);
  }

  // ADMIN: BAN/UNBAN/RESET
  if (commandName === "ban") {
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found.");
    await supabase.from(TABLE).update({ is_banned: true, verified: false }).eq("id", data.id);
    return interaction.reply(`🚫 **BANNED!** Target blocked.`);
  }
  if (commandName === "unban") {
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found.");
    await supabase.from(TABLE).update({ is_banned: false }).eq("id", data.id);
    return interaction.reply(`✅ **Unbanned!**`);
  }
  if (commandName === "resetuser") {
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found.");
    await supabase.from(TABLE).delete().eq("id", data.id);
    return interaction.reply(`🗑️ **USER RESET!** Data deleted. New code generate hoga.`);
  }

  // ADMIN: LOOKUP
  if (commandName === "lookup") {
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply("❌ Target not found.");
    const status = data.is_banned ? "🚫 BANNED" : (data.verified ? "✅ VERIFIED" : "❌ NOT VERIFIED");
    const expiry = data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime() / 1000)}:R>` : "No Session";
    return interaction.reply(`**User Details:**\nHWID: \`${data.hwid}\`\nCode: \`${data.code}\`\nStatus: ${status}\nExpiry: ${expiry}`);
  }

  // ADMIN: RULES
  if (commandName === "setrule") {
    const role = interaction.options.getRole("role");
    const duration = interaction.options.getString("duration"); // e.g., +1h or 24h
    
    const { data: existing } = await supabase.from(RULES_TABLE).select("*").eq("role_id", role.id).maybeSingle();
    if (existing) { await supabase.from(RULES_TABLE).update({ duration: duration }).eq("id", existing.id); } 
    else { await supabase.from(RULES_TABLE).insert([{ role_id: role.id, duration: duration }]); }
    return interaction.reply(`✅ **Rule Set!** ${role.name} = **${duration}**`);
  }

  if (commandName === "removerule") {
    const role = interaction.options.getRole("role");
    await supabase.from(RULES_TABLE).delete().eq("role_id", role.id);
    return interaction.reply(`✅ **Rule Removed!** for ${role.name}`);
  }

  if (commandName === "listrules") {
    const { data: rules } = await supabase.from(RULES_TABLE).select("*");
    if (!rules || rules.length === 0) return interaction.reply("ℹ️ No active rules.");
    
    let msg = "**📜 Active Verification Rules:**\n\n";
    
    // Fetch role names (might be slight delay but okay for admin command)
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

    return interaction.reply(msg);
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
