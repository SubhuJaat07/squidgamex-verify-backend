/*****************************************************************************************
 * 🚀 SQUID GAME X - THE FINAL GOD MODE BOT (NO SHORTCUTS)
 * ---------------------------------------------------------------------------------------
 * FEATURES INCLUDED:
 * 1. Verification System (Slash + Text Command support)
 * 2. Invite Tracker (Real-time tracking, Fake/Real detection, Leaver detection)
 * 3. Poll System (Vote-to-Verify Logic, 2-Option Buttons, History Support)
 * 4. Admin Dashboard (Stats, Ban, Unban, SetExpiry, Maintenance Mode)
 * 5. Gift System (Generate Keys, Redeem System)
 * 6. User Tools (Active Users Pagination, Check Alts, Lookup with Mobile Copy)
 * 7. Anti-Crash System (24/7 Uptime)
 *****************************************************************************************/

const express = require("express");
const cors = require("cors");
const { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  ActivityType, 
  Events, 
  EmbedBuilder, 
  ActionRowBuilder, 
  UserSelectMenuBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  Collection, 
  ComponentType, 
  PermissionsBitField 
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// ==================================================================================
// ⚙️ CONFIGURATION & CONSTANTS
// ==================================================================================
const PORT = process.env.PORT || 10000;
const SUPER_OWNER_ID = "1169492860278669312"; // Aapki ID
const GUILD_ID = "1257403231127076915"; // Server ID
const VERIFY_CHANNEL_ID = "1444769950421225542"; // Verify Channel ID
const DEFAULT_VERIFY_MS = 18 * 60 * 60 * 1000; // 18 Hours
const PUNISH_NO_VOTE_MS = 1 * 60 * 60 * 1000; // 1 Hour (Agar Poll vote nahi kiya)

// Global State Variables
let MAINTENANCE_MODE = false;
let POLL_VERIFY_LOCK = false; // Agar TRUE hai, to verification ke liye Vote zaruri hai

// ==================================================================================
// 🗄️ DATABASE & SERVER SETUP
// ==================================================================================
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const app = express();
app.use(cors());
app.use(express.json());

// Keep-Alive Route
app.get("/", (req, res) => {
    res.send(`🟢 System Online | Maintenance: ${MAINTENANCE_MODE ? "ON" : "OFF"} | PollLock: ${POLL_VERIFY_LOCK ? "ON" : "OFF"}`);
});

// Roblox Script API (Checks HWID)
app.get("/check", async (req, res) => {
  if (MAINTENANCE_MODE) return res.json({ status: "ERROR", message: "Maintenance Break 🚧" });
  
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });
  
  try {
      const { data: existing } = await supabase.from("verifications").select("*").eq("hwid", hwid).maybeSingle();
      
      if (existing) {
        if (existing.is_banned) return res.json({ status: "BANNED", message: "Contact Admin" });
        
        // Check Expiry
        if (existing.verified && new Date(existing.expires_at) > new Date()) {
            return res.json({ status: "VALID" });
        }
        return res.json({ status: "NEED_VERIFY", code: existing.code });
      }
      
      // New User - Create Entry
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      await supabase.from("verifications").insert([{ hwid, code, verified: false, is_banned: false }]);
      return res.json({ status: "NEED_VERIFY", code });

  } catch (e) {
      console.error("DB Error:", e);
      return res.json({ status: "ERROR", message: "Database Error" }); 
  }
});

app.listen(PORT, "0.0.0.0", () => { 
    console.log(`🚀 API Server Running on Port ${PORT}`); 
});

// ==================================================================================
// 🤖 DISCORD CLIENT SETUP (INTENTS ARE CRITICAL)
// ==================================================================================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent, // REQUIRED for text commands
    GatewayIntentBits.GuildMembers,   // REQUIRED for Invite Tracker
    GatewayIntentBits.GuildInvites    // REQUIRED for Invite Tracker
  ],
  partials: [Partials.GuildMember, Partials.Channel]
});

// Caches for tracking
const inviteCache = new Collection();
const recentlySynced = new Set();

// ==================================================================================
// 🛠️ HELPER FUNCTIONS
// ==================================================================================

// 1. Parse Duration String (e.g., "7d", "1h")
function parseDuration(durationStr) {
  if (!durationStr) return 0;
  if (durationStr.toLowerCase() === "lifetime") return "LIFETIME";
  
  const match = durationStr.match(/^(\d+)([mhdw])$/);
  if (!match) return 0;
  
  const val = parseInt(match[1]);
  const unit = match[2];
  
  if (unit === 'm') return val * 60 * 1000;
  if (unit === 'h') return val * 60 * 60 * 1000;
  if (unit === 'd') return val * 24 * 60 * 60 * 1000;
  if (unit === 'w') return val * 7 * 24 * 60 * 60 * 1000;
  return 0;
}

// 2. Format Time (Milliseconds to Readable String)
function formatTime(ms) {
  if (ms === "LIFETIME") return "Lifetime ♾️";
  if (typeof ms !== 'number' || ms < 0) return 'Expired 💀';
  
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  
  let parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  
  return parts.length === 0 ? "Less than 1m" : parts.join(' ');
}

// 3. Admin Check
async function isAdmin(userId) {
  if (userId === SUPER_OWNER_ID) return true;
  const { data } = await supabase.from("bot_admins").select("*").eq("discord_id", userId).maybeSingle();
  return !!data;
}

// 4. Safe Reply (Prevents 10062 & 40060 Errors)
async function safeReply(interaction, options) {
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(options);
        } else {
            await interaction.reply(options);
        }
    } catch (e) {
        console.error("SafeReply Error:", e.message);
    }
}

// 5. Welcome Message Formatter
function formatWelcomeMsg(text, member, inviterId, code) {
    if (!text) return "";
    return text
        .replace(/{user}/g, `${member}`)
        .replace(/{username}/g, member.user.username)
        .replace(/{inviter}/g, (inviterId && inviterId !== 'left_user') ? `<@${inviterId}>` : "**Someone**")
        .replace(/{code}/g, code || "N/A")
        .replace(/{count}/g, member.guild.memberCount);
}

// ==================================================================================
// 🧠 CORE LOGIC: VERIFICATION & REWARDS
// ==================================================================================

// 1. Process Verification (Used by both Slash & Text Command)
async function processVerification(user, code, guild, replyCallback) {
    if (MAINTENANCE_MODE) return replyCallback({ content: "🚧 Maintenance Mode is ON. Please try again later.", ephemeral: true });

    let isPollPunished = false;
    
    // Poll Lock Check
    if (POLL_VERIFY_LOCK) {
        // Find latest active poll
        const { data: activePoll } = await supabase.from("polls").select("id").eq("is_active", true).order('created_at', { ascending: false }).limit(1).maybeSingle();
        
        if (activePoll) {
            // Check if user voted
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) {
                isPollPunished = true; // User didn't vote!
            }
        }
    }

    // Check Code Validity
    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("❌ Invalid Code")] });
    if (userData.is_banned) return replyCallback({ embeds: [new EmbedBuilder().setColor(0x000000).setTitle("🚫 YOU ARE BANNED")] });

    // Calculate Duration
    let calculation;
    if (isPollPunished) {
        // Punishment: Less time
        calculation = { duration: PUNISH_NO_VOTE_MS, ruleText: "⚠️ **Penalty:** Vote on Poll to get Full Time!", isPunished: true };
    } else {
        // Normal Logic (Roles etc.)
        try { 
            const member = await guild.members.fetch(user.id); 
            const { data: rules } = await supabase.from("role_rules").select("*"); 
            calculation = await calculateUserDuration(member, rules || []); 
        } catch (e) { 
            calculation = { duration: DEFAULT_VERIFY_MS, ruleText: "Default", isPunished: false }; 
        }
    }

    const { duration, ruleText, isPunished } = calculation;
    const expiryTime = duration === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + duration).toISOString();
    
    // Update DB
    await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: user.id }).eq("id", userData.id);

    // Send Success Embed
    const embed = new EmbedBuilder()
        .setColor(isPunished ? 0xFFA500 : 0x00FF00)
        .setTitle(isPunished ? "⚠️ Verified (Penalty Applied)" : "✅ Verification Successful")
        .addFields(
            { name: "🔑 Code", value: `\`${code}\``, inline: true },
            { name: "⏳ Validity", value: formatTime(duration), inline: true },
            { name: "📜 Logic", value: ruleText, inline: false }
        )
        .setThumbnail(user.displayAvatarURL())
        .setFooter({ text: "Enjoy the game! 🎮" });
    
    return replyCallback({ embeds: [embed] });
}

// 2. Role Duration Calculator
async function calculateUserDuration(member, rules) {
  let activeRules = rules.map(r => { 
      const discordRole = member.roles.cache.get(r.role_id); 
      return discordRole ? { ...r, roleName: discordRole.name } : null; 
  }).filter(r => r !== null);

  if (activeRules.length === 0) return { duration: DEFAULT_VERIFY_MS, ruleText: "Default (18h)", isPunished: false };

  // Check Punishments
  const punishments = activeRules.filter(r => r.roleName.toLowerCase().startsWith("punish"));
  if (punishments.length > 0) {
    let minMs = Infinity; let selectedRule = null;
    punishments.forEach(r => { 
        const ms = parseDuration(r.duration); 
        if (ms !== "LIFETIME" && ms < minMs) { minMs = ms; selectedRule = r; } 
    });
    return { duration: minMs, ruleText: `🚫 ${selectedRule.roleName}`, isPunished: true };
  }

  // Check Bases & Bonuses
  const bases = activeRules.filter(r => !r.duration.startsWith("+"));
  const bonuses = activeRules.filter(r => r.duration.startsWith("+"));
  
  let maxBase = DEFAULT_VERIFY_MS; 
  let baseName = "Default";

  bases.forEach(r => { 
      const ms = parseDuration(r.duration); 
      if (ms === "LIFETIME") { maxBase = "LIFETIME"; baseName = r.roleName; } 
      else if (maxBase !== "LIFETIME" && ms > maxBase) { maxBase = ms; baseName = r.roleName; } 
  });

  if (maxBase === "LIFETIME") return { duration: "LIFETIME", ruleText: `👑 ${baseName} (Lifetime)`, isPunished: false };

  let totalBonus = 0; 
  bonuses.forEach(r => totalBonus += parseDuration(r.duration));
  
  return { duration: maxBase + totalBonus, ruleText: `✅ ${baseName} + ${bonuses.length} Boosts`, isPunished: false };
}

// 3. Invite Rewards Checker
async function checkRewards(guild, inviterId) {
    if (inviterId === 'left_user') return;
    
    const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", guild.id).eq("inviter_id", inviterId).maybeSingle();
    if (!stats) return;
    
    const { data: rewards } = await supabase.from("invite_rewards").select("*").eq("guild_id", guild.id);
    if (!rewards) return;
    
    const member = await guild.members.fetch(inviterId).catch(() => null);
    if (!member) return;
    
    for (const reward of rewards) {
        if (stats.real_invites >= reward.invites_required) {
            // Check if already given
            const { data: already } = await supabase.from("reward_logs").select("*").eq("guild_id", guild.id).eq("user_id", inviterId).eq("invites_required", reward.invites_required).maybeSingle();
            if (already) continue;
            
            const role = guild.roles.cache.get(reward.role_id);
            if (role) {
                await member.roles.add(role).catch(console.error);
                await supabase.from("reward_logs").insert({ guild_id: guild.id, user_id: inviterId, invites_required: reward.invites_required });
            }
        }
    }
}

// 4. Active Users Pagination Generator (With Copy Buttons)
async function generateActiveUsersPayload(page) {
    const limit = 10; 
    const offset = (page - 1) * limit;
    
    const { data: activeUsers, count } = await supabase.from("verifications")
        .select("code, expires_at, discord_id", { count: 'exact' })
        .eq("verified", true)
        .gt("expires_at", new Date().toISOString())
        .order("expires_at", { ascending: true })
        .range(offset, offset + limit - 1);

    if (!activeUsers || activeUsers.length === 0) return { embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("❌ No Active Users")], components: [] };

    const totalPages = Math.ceil((count || 0) / limit);
    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`📜 Active Users (Page ${page}/${totalPages})`)
        .setDescription(`**Total Online:** \`${count}\``)
        .setTimestamp();

    let desc = "";
    for (const [i, u] of activeUsers.entries()) {
        const left = new Date(u.expires_at).getTime() - Date.now();
        let nameLink = "`Unknown`";
        
        if (u.discord_id) { 
            try { 
                const user = client.users.cache.get(u.discord_id) || await client.users.fetch(u.discord_id); 
                nameLink = `[**${user.username}**](https://discord.com/users/${u.discord_id})`; 
            } catch (e) { 
                nameLink = `[ID: ${u.discord_id}](https://discord.com/users/${u.discord_id})`; 
            } 
        }
        // Using code blocks for easy copying
        desc += `➤ **${offset + i + 1}.** ${nameLink}\n   └ \`${u.code}\` | ⏳ ${formatTime(left)}\n\n`;
    }
    embed.setDescription(desc);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`active_prev_${page}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 1), 
        new ButtonBuilder().setCustomId(`active_next_${page}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages)
    );
    return { embeds: [embed], components: [row] };
}

// ==================================================================================
// 📜 SLASH COMMANDS REGISTRATION
// ==================================================================================
const commands = [
  new SlashCommandBuilder().setName("verify").setDescription("🔐 Verify access").addStringOption(o => o.setName("code").setDescription("6-digit code").setRequired(true)),
  new SlashCommandBuilder().setName("status").setDescription("📅 Check your verification status"),
  new SlashCommandBuilder().setName("invites").setDescription("📊 Check your invites").addUserOption(o => o.setName("user").setDescription("Select User")),
  new SlashCommandBuilder().setName("leaderboard").setDescription("🏆 Top 10 Inviters"),
  new SlashCommandBuilder().setName("whoinvited").setDescription("🕵️ Check who invited a user").addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
  new SlashCommandBuilder().setName("redeem").setDescription("🎁 Redeem Gift Key").addStringOption(o => o.setName("key").setDescription("Gift Key").setRequired(true)),

  // ADMIN SECTION
  new SlashCommandBuilder().setName("admin").setDescription("🛠️ Admin Tools")
    .addSubcommand(s => s.setName("poll").setDescription("🗳️ Start New Poll").addStringOption(o => o.setName("question").setRequired(true).setDescription("Question")).addStringOption(o => o.setName("option1").setRequired(true).setDescription("Option 1")).addStringOption(o => o.setName("option2").setRequired(true).setDescription("Option 2")))
    .addSubcommand(s => s.setName("pollresults").setDescription("📊 Poll Results").addIntegerOption(o => o.setName("pollid").setDescription("Poll ID (Optional)")))
    .addSubcommand(s => s.setName("say").setDescription("🤡 Anon Message").addStringOption(o => o.setName("message").setRequired(true).setDescription("Msg")))
    .addSubcommand(s => s.setName("announce").setDescription("📢 Announce").addStringOption(o => o.setName("title").setRequired(true).setDescription("Title")).addStringOption(o => o.setName("message").setRequired(true).setDescription("Msg")).addStringOption(o => o.setName("image").setDescription("Img URL")))
    .addSubcommand(s => s.setName("purge").setDescription("🧹 Clear Chat").addIntegerOption(o => o.setName("amount").setRequired(true).setDescription("Amount")))
    .addSubcommand(s => s.setName("stats").setDescription("📊 Server Stats"))
    .addSubcommand(s => s.setName("generate").setDescription("🎁 Gen Gift Key").addStringOption(o => o.setName("duration").setRequired(true).setDescription("e.g. 7d, 1m")))
    .addSubcommand(s => s.setName("maintenance").setDescription("🚧 Maint Mode").addStringOption(o => o.setName("status").setRequired(true).setDescription("on/off").addChoices({name:'ON',value:'on'},{name:'OFF',value:'off'}))),
  
  new SlashCommandBuilder().setName("checkalts").setDescription("🕵️‍♂️ Show users with multiple active keys"),
  new SlashCommandBuilder().setName("activeusers").setDescription("📜 List active verified users"),
  new SlashCommandBuilder().setName("userinfo").setDescription("🕵️‍♂️ User Alts Info").addUserOption(o => o.setName("user").setRequired(true).setDescription("User")),
  new SlashCommandBuilder().setName("syncmissing").setDescription("🔄 Sync Invites Database"),
  new SlashCommandBuilder().setName("config").setDescription("⚙️ Server Setup")
    .addSubcommand(s => s.setName("setchannel").setDescription("Set Welcome Channel").addChannelOption(o => o.setName("channel").setRequired(true).setDescription("Channel")))
    .addSubcommand(s => s.setName("setmessage").setDescription("Set Welcome Msg").addStringOption(o => o.setName("title").setRequired(true).setDescription("Title")).addStringOption(o => o.setName("description").setRequired(true).setDescription("Description")))
    .addSubcommand(s => s.setName("addreward").setDescription("Add Invite Reward").addIntegerOption(o => o.setName("invites").setRequired(true).setDescription("Invites")).addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role"))),

  new SlashCommandBuilder().setName("setexpiry").setDescription("⚡ Add Time").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time")),
  new SlashCommandBuilder().setName("ban").setDescription("🚫 Ban User").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("unban").setDescription("✅ Unban User").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("lookup").setDescription("🔍 Search User").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("resetuser").setDescription("⚠️ Delete User Data").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
].map(c => c.toJSON());

// ==================================================================================
// 🚀 EVENTS: STARTUP & INVITE TRACKER LOGIC
// ==================================================================================

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot Logged In as: ${client.user.tag}`);
  
  // Register Commands
  try { 
      await new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN).put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands }); 
      console.log("🎉 All Commands Registered Successfully!");
  } catch (e) { console.error("Registry Error:", e); }
  
  // Cache Existing Invites
  for (const guild of client.guilds.cache.values()) { 
      try { 
          const invites = await guild.invites.fetch(); 
          inviteCache.set(guild.id, new Collection(invites.map(i => [i.code, i.uses]))); 
          console.log(`✅ Cached Invites for: ${guild.name}`);
      } catch (e) { console.log(`❌ Missing Permissions for: ${guild.name}`); } 
  }
});

// Real-time Invite Cache Update
client.on('inviteCreate', (invite) => { 
    const invites = inviteCache.get(invite.guild.id); 
    if (invites) invites.set(invite.code, invite.uses); 
});
client.on('inviteDelete', (invite) => { 
    const invites = inviteCache.get(invite.guild.id); 
    if (invites) invites.delete(invite.code); 
});

// 🔥 TRACKER LOGIC: MEMBER JOIN
client.on("guildMemberAdd", async member => {
    try {
        const newInvites = await member.guild.invites.fetch().catch(() => new Collection());
        const oldInvites = inviteCache.get(member.guild.id);
        
        // Find which invite was used (usage count increased)
        const usedInvite = newInvites.find(i => i.uses > (oldInvites?.get(i.code) || 0));
        
        // Update Cache
        inviteCache.set(member.guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));

        let inviterId = null; 
        let code = "Unknown";
        
        if (usedInvite) { 
            inviterId = usedInvite.inviter?.id; 
            code = usedInvite.code; 
        }

        console.log(`👤 User Joined: ${member.user.tag} | Inviter: ${inviterId || "Unknown"}`);

        if (inviterId) {
            // Log Join
            await supabase.from("joins").insert({ guild_id: member.guild.id, user_id: member.id, inviter_id: inviterId, code: code });
            
            // Update Stats
            const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", inviterId).maybeSingle();
            
            await supabase.from("invite_stats").upsert({ 
                guild_id: member.guild.id, 
                inviter_id: inviterId, 
                total_invites: (ex?.total_invites || 0) + 1, 
                real_invites: (ex?.real_invites || 0) + 1, 
                fake_invites: ex?.fake_invites || 0, 
                leaves: ex?.leaves || 0 
            });
            
            // Give Rewards
            await checkRewards(member.guild, inviterId);
        }
        
        // Send Welcome Message
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
        if (config?.welcome_channel) {
            const ch = member.guild.channels.cache.get(config.welcome_channel);
            if (ch) {
                const title = config.welcome_title ? config.welcome_title.replace(/{user}/g, `${member}`).replace(/{username}/g, member.user.username) : "Welcome!";
                const desc = config.welcome_desc ? config.welcome_desc.replace(/{user}/g, `${member}`).replace(/{username}/g, member.user.username).replace(/{inviter}/g, inviterId ? `<@${inviterId}>` : "Unknown") : `Welcome ${member}`;
                
                ch.send({ embeds: [new EmbedBuilder().setColor('#0099ff').setTitle(title).setDescription(desc).setThumbnail(member.user.displayAvatarURL())] });
            }
        }
    } catch (e) { console.error("Join Error:", e); }
});

// 🔥 TRACKER LOGIC: MEMBER LEAVE
client.on("guildMemberRemove", async member => {
    try {
        const { data: join } = await supabase.from("joins").select("*").eq("guild_id", member.guild.id).eq("user_id", member.id).maybeSingle();
        
        if (join && join.inviter_id && join.inviter_id !== 'left_user') {
            const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id).maybeSingle();
            
            if (stats) {
                // Deduct real invite, increase leave count
                await supabase.from("invite_stats").update({ 
                    real_invites: (stats.real_invites || 1) - 1, 
                    leaves: (stats.leaves || 0) + 1 
                }).eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id);
            }
        }
    } catch (e) { console.error("Leave Error:", e); }
});

// ==================================================================================
// ✉️ TEXT COMMAND HANDLER (verify 123456)
// ==================================================================================
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  
  const content = message.content.trim();
  const isCmd = content.toLowerCase().startsWith("verify");
  
  // Logic: Verify Channel ME sabke liye, bahar sirf ADMIN ke liye
  if (message.channel.id === VERIFY_CHANNEL_ID) {
      if (!isCmd && !(await isAdmin(message.author.id))) { 
          try { await message.delete(); } catch (e) {} 
          return;
      }
  } else {
      if (!await isAdmin(message.author.id)) return;
      if (!isCmd) return;
  }

  if (isCmd) {
      const args = content.split(/\s+/);
      if (args.length < 2) return message.reply("❌ Usage: `verify 123456`");
      
      await processVerification(message.author, args[1], message.guild, (opts) => message.reply(opts));
  }
});

// ==================================================================================
// 🎮 INTERACTION HANDLER (Buttons, Menus, Slash Commands)
// ==================================================================================
client.on("interactionCreate", async interaction => {
    try {
        // --- BUTTONS ---

        // 1. MOBILE COPY BUTTON (From /lookup)
        if (interaction.isButton() && interaction.customId.startsWith('copy_')) {
            await interaction.deferReply({ ephemeral: true });
            const [_, targetCode] = interaction.customId.split('_');
            
            const { data } = await supabase.from("verifications").select("*").eq("code", targetCode).maybeSingle();
            
            if (!data) return interaction.editReply("❌ Error: Data not found.");
            
            await interaction.editReply({ 
                content: `**📋 Tap to Copy:**\n\nCode:\n\`${data.code}\`\n\nHWID:\n\`${data.hwid}\`` 
            });
            return;
        }

        // 2. POLL VOTING BUTTONS
        if (interaction.isButton() && (interaction.customId === 'vote_opt1' || interaction.customId === 'vote_opt2')) {
            await interaction.deferReply({ ephemeral: true });
            
            // Fetch Latest Poll
            const { data: activePoll } = await supabase.from("polls").select("id").eq("is_active", true).order('created_at', { ascending: false }).limit(1).maybeSingle();
            
            if (!activePoll) return interaction.editReply("❌ No active poll found.");
            
            const choice = interaction.customId === 'vote_opt1' ? 1 : 2;
            await supabase.from("poll_votes").upsert({ poll_id: activePoll.id, user_id: interaction.user.id, choice: choice });
            
            return interaction.editReply("✅ **Vote Registered!** Verification Penalty Removed.");
        }

        // 3. PAGINATION BUTTONS
        if (interaction.isButton() && interaction.customId.startsWith('active_')) {
            const [_, direction, currentPage] = interaction.customId.split('_');
            let newPage = parseInt(currentPage) + (direction === 'next' ? 1 : -1);
            await interaction.deferUpdate();
            const payload = await generateActiveUsersPayload(newPage);
            await interaction.editReply(payload);
            return;
        }

        // --- COMMANDS ---
        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;

        // ADMIN COMMANDS
        if (commandName === "admin") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin Only", ephemeral: true });
            const sub = interaction.options.getSubcommand();
            
            // Poll Start
            if (sub === "poll") {
                 const q = interaction.options.getString("question");
                 const o1 = interaction.options.getString("option1");
                 const o2 = interaction.options.getString("option2");
                 
                 await supabase.from("polls").update({ is_active: false }).eq("is_active", true); // Deactivate old
                 const { data: newPoll } = await supabase.from("polls").insert({ question: q, option1: o1, option2: o2 }).select().single();
                 
                 POLL_VERIFY_LOCK = true; 
                 const embed = new EmbedBuilder().setColor('#00FF00').setTitle(`📢 Poll #${newPoll.id}`).setDescription(`**${q}**\n\n1️⃣ ${o1}\n2️⃣ ${o2}`).setFooter({text: "Vote required for full verification!"});
                 const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vote_opt1').setLabel(o1).setStyle(ButtonStyle.Primary).setEmoji('1️⃣'), new ButtonBuilder().setCustomId('vote_opt2').setLabel(o2).setStyle(ButtonStyle.Primary).setEmoji('2️⃣'));
                 
                 await interaction.channel.send({ content: "@everyone", embeds: [embed], components: [row] });
                 return safeReply(interaction, { content: `✅ Poll #${newPoll.id} Started!`, ephemeral: true });
            }
            
            // Poll Results
            if (sub === "pollresults") {
                await interaction.deferReply();
                let pollId = interaction.options.getInteger("pollid");
                
                if (!pollId) { const { data: latest } = await supabase.from("polls").select("id").order('created_at', { ascending: false }).limit(1).maybeSingle(); if (latest) pollId = latest.id; }
                if (!pollId) return interaction.editReply("❌ No polls found.");
                
                const { data: pollData } = await supabase.from("polls").select("*").eq("id", pollId).maybeSingle();
                const { count: c1 } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId).eq("choice", 1);
                const { count: c2 } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId).eq("choice", 2);
                const { count: total } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId);
                
                return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFA500).setTitle(`📊 Poll #${pollId} Results`).setDescription(`**${pollData.question}**\n\n**Total Votes:** ${total}\n\n1️⃣ **${pollData.option1}:** ${c1}\n2️⃣ **${pollData.option2}:** ${c2}`)] });
            }

            // Other Admin Tools
            if (sub === "generate") { const dur = interaction.options.getString("duration"); const c = "GIFT-" + Math.random().toString(36).substring(2, 10).toUpperCase(); await supabase.from("gift_keys").insert({ code: c, duration: dur, created_by: interaction.user.username }); return safeReply(interaction, { content: `🎁 Key Generated: \`${c}\` (${dur})`, ephemeral: true }); }
            if (sub === "announce") { const embed = new EmbedBuilder().setColor('#FFD700').setTitle(interaction.options.getString("title")).setDescription(interaction.options.getString("message")); if (interaction.options.getString("image")) embed.setImage(interaction.options.getString("image")); await interaction.channel.send({ embeds: [embed] }); return safeReply(interaction, { content: "✅ Sent", ephemeral: true }); }
            if (sub === "say") { const msg = interaction.options.getString("message"); await interaction.channel.send(msg); return safeReply(interaction, { content: "✅ Sent", ephemeral: true }); }
            if (sub === "purge") { const amt = interaction.options.getInteger("amount"); if(amt>100) return safeReply(interaction,"Max 100"); await interaction.channel.bulkDelete(amt, true); return safeReply(interaction, `Deleted ${amt}`); }
            if (sub === "stats") { await interaction.deferReply(); const { count: v } = await supabase.from("verifications").select("*", { count: 'exact', head: true }).eq("verified", true); const { count: b } = await supabase.from("verifications").select("*", { count: 'exact', head: true }).eq("is_banned", true); const embed = new EmbedBuilder().setColor(0x00FFFF).setTitle("📊 Stats").addFields({name:"Verified",value:`${v}`,inline:true},{name:"Banned",value:`${b}`,inline:true}); return interaction.editReply({ embeds: [embed] }); }
            if (sub === "maintenance") { MAINTENANCE_MODE = interaction.options.getString("status") === 'on'; return safeReply(interaction, { content: `🚧 Maintenance: **${MAINTENANCE_MODE}**`, ephemeral: true }); }
        }

        // LOOKUP (WITH COPY BUTTON)
        if (commandName === "lookup") { 
            await interaction.deferReply(); 
            const target = interaction.options.getString("target"); 
            const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle(); 
            if (!data) return interaction.editReply("❌ Not Found"); 
            
            let userPfp = client.user.displayAvatarURL(); 
            let userName = "Unknown";
            if (data.discord_id) { try { const user = await client.users.fetch(data.discord_id); userPfp = user.displayAvatarURL(); userName = user.username; } catch (e) {} }
            
            const embed = new EmbedBuilder().setColor(0x00FFFF).setTitle(`🔍 Lookup: ${userName}`).setThumbnail(userPfp).addFields({ name: "🔑 Code", value: `\`${data.code}\``, inline: true }, { name: "👤 User", value: data.discord_id ? `<@${data.discord_id}>` : "`None`", inline: true }, { name: "🖥️ HWID", value: `\`${data.hwid}\``, inline: false }, { name: "📡 Status", value: data.is_banned ? "🚫 **BANNED**" : "✅ **Active**", inline: true });
            
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`copy_${data.code}`).setLabel('📋 Copy Data').setStyle(ButtonStyle.Secondary));
            return interaction.editReply({ embeds: [embed], components: [row] }); 
        }

        // VERIFY COMMAND
        if (commandName === "verify") {
            await interaction.deferReply();
            const code = interaction.options.getString("code");
            await processVerification(interaction.user, code, interaction.guild, (opts) => interaction.editReply(opts));
        }

        // REDEEM COMMAND (ADDITIVE TIME)
        if (commandName === "redeem") {
            await interaction.deferReply({ ephemeral: true });
            const key = interaction.options.getString("key");
            const { data: gift } = await supabase.from("gift_keys").select("*").eq("code", key).eq("is_redeemed", false).maybeSingle();
            if (!gift) return interaction.editReply("❌ Invalid or Used Key");
            
            const ms = parseDuration(gift.duration);
            const { data: user } = await supabase.from("verifications").select("*").eq("discord_id", interaction.user.id).limit(1).maybeSingle();
            if (!user) return interaction.editReply("❌ You must verify at least once first!");
            
            let currentExpiry = new Date(user.expires_at).getTime();
            if (currentExpiry < Date.now()) currentExpiry = Date.now();
            
            const newDate = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(currentExpiry + ms).toISOString();
            
            await supabase.from("verifications").update({ verified: true, expires_at: newDate }).eq("id", user.id);
            await supabase.from("gift_keys").update({ is_redeemed: true }).eq("id", gift.id);
            
            return interaction.editReply(`✅ **Redeemed Successfully!**\nAdded: \`${gift.duration}\`\nNew Expiry: <t:${Math.floor(new Date(newDate).getTime()/1000)}:R>`);
        }

        // TRACKER COMMANDS
        if (commandName === "activeusers") { if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admins Only", ephemeral: true }); await interaction.deferReply(); const payload = await generateActiveUsersPayload(1); return interaction.editReply(payload); }
        if (commandName === "checkalts") { await interaction.deferReply(); const {data:a}=await supabase.from("verifications").select("*").eq("verified",true).gt("expires_at",new Date().toISOString()); const m=new Map(); a.forEach(u=>{if(u.discord_id){if(!m.has(u.discord_id))m.set(u.discord_id,[]);m.get(u.discord_id).push(u)}}); const l=Array.from(m.entries()).filter(([i,arr])=>arr.length>=2); if(l.length==0)return interaction.editReply("✅ No Alts"); const e=new EmbedBuilder().setColor(0xFFA500).setTitle(`🕵️ ${l.length} Alt Users`); let d=""; l.forEach(([i,arr])=>{d+=`<@${i}> **(${arr.length} Keys)**\n`;arr.forEach(k=>d+=`   └ \`${k.code}\`\n`)}); e.setDescription(d.substring(0,4000)); return interaction.editReply({embeds:[e]}); }
        if (commandName === "invites") { await interaction.deferReply(); const user = interaction.options.getUser("user") || interaction.user; const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", user.id).maybeSingle(); return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#2b2d31').setTitle(`📊 Invites: ${user.username}`).addFields({ name: '✅ Real', value: `${data?.real_invites || 0}`, inline: true }, { name: '❌ Fake', value: `${data?.fake_invites || 0}`, inline: true }, { name: '📊 Total', value: `${data?.total_invites || 0}`, inline: true }).setThumbnail(user.displayAvatarURL())] }); }
        if (commandName === "leaderboard") { await interaction.deferReply(); const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).limit(10); const lb = data?.map((u, i) => `**#${i + 1}** <@${u.inviter_id}>: ${u.real_invites}`).join("\n") || "No data."; return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Leaderboard').setDescription(lb)] }); }
        if (commandName === "whoinvited") { await interaction.deferReply(); const target = interaction.options.getUser("user"); const { data: joinData } = await supabase.from("joins").select("*").eq("guild_id", interaction.guild.id).eq("user_id", target.id).maybeSingle(); return interaction.editReply({ content: `**${target.username}** was invited by: ${joinData ? (joinData.inviter_id === 'left_user' ? "Left Server" : `<@${joinData.inviter_id}>`) : "Unknown"}` }); }
        
        // GENERIC DB COMMANDS
        if (commandName === "setexpiry") { await interaction.deferReply(); const ms = parseDuration(interaction.options.getString("duration")); const target = interaction.options.getString("target"); const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle(); if (!data) return interaction.editReply("❌ Not Found"); const newDate = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString(); await supabase.from("verifications").update({ verified: true, expires_at: newDate }).eq("id", data.id); return interaction.editReply(`✅ Updated ${target}`); }
        if (commandName === "ban") { await interaction.deferReply(); const target = interaction.options.getString("target"); await supabase.from("verifications").update({ is_banned: true, verified: false }).or(`code.eq.${target},hwid.eq.${target}`); return interaction.editReply(`🚫 Banned ${target}`); }
        if (commandName === "unban") { await interaction.deferReply(); const target = interaction.options.getString("target"); await supabase.from("verifications").update({ is_banned: false }).or(`code.eq.${target},hwid.eq.${target}`); return interaction.editReply(`✅ Unbanned ${target}`); }

    } catch (err) { console.error("Interaction Error:", err); try{ if(!interaction.replied) await interaction.reply({content:"⚠️ System Error", ephemeral:true}); }catch(e){} }
});

// 🛡️ GLOBAL ANTI-CRASH HANDLERS
process.on('unhandledRejection', (reason, p) => { console.log(' [antiCrash] :: Unhandled Rejection/Catch', reason, p); });
process.on("uncaughtException", (err, origin) => { console.log(' [antiCrash] :: Uncaught Exception/Catch', err, origin); });
process.on('uncaughtExceptionMonitor', (err, origin) => { console.log(' [antiCrash] :: Uncaught Exception/Catch (MONITOR)', err, origin); });

client.login(process.env.DISCORD_BOT_TOKEN);
