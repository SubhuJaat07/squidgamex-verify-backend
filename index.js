/**********************************************************************
 * 🚀 SQUID GAME X - HISTORY EDITION (POLL FIX + TEXT CMD BACK)
 **********************************************************************/

const express = require("express");
const cors = require("cors");
const { 
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, 
  ActivityType, Events, EmbedBuilder, ActionRowBuilder, 
  UserSelectMenuBuilder, ButtonBuilder, ButtonStyle, Collection, PermissionsBitField 
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- ⚙️ CONFIGURATION ⚙️ ---
const PORT = process.env.PORT || 10000;
const SUPER_OWNER_ID = "1169492860278669312"; 
const GUILD_ID = "1257403231127076915"; 
const VERIFY_CHANNEL_ID = "1444769950421225542"; 
const DEFAULT_VERIFY_MS = 18 * 60 * 60 * 1000; // 18 Hours
const PUNISH_NO_VOTE_MS = 1 * 60 * 60 * 1000; // 1 Hour (Agar vote nahi kiya to)

let MAINTENANCE_MODE = false;
let POLL_VERIFY_LOCK = false; 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send(`System Online 🟢`));
app.get("/check", async (req, res) => {
  if (MAINTENANCE_MODE) return res.json({ status: "ERROR", message: "Maintenance Break 🚧" });
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });
  try {
      const { data: existing } = await supabase.from("verifications").select("*").eq("hwid", hwid).maybeSingle();
      if (existing) {
        if (existing.is_banned) return res.json({ status: "BANNED", message: "Contact Admin" });
        if (existing.verified && new Date(existing.expires_at) > new Date()) return res.json({ status: "VALID" });
        return res.json({ status: "NEED_VERIFY", code: existing.code });
      }
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      await supabase.from("verifications").insert([{ hwid, code, verified: false, is_banned: false }]);
      return res.json({ status: "NEED_VERIFY", code });
  } catch (e) { return res.json({ status: "ERROR", message: "DB Error" }); }
});
app.listen(PORT, "0.0.0.0", () => { console.log(`🚀 Server Running on Port ${PORT}`); });

const client = new Client({
  intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites ],
  partials: [Partials.GuildMember, Partials.Channel]
});

const inviteCache = new Collection();
const recentlySynced = new Set();

// --- HELPER FUNCTIONS ---
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

async function isAdmin(userId) {
  if (userId === SUPER_OWNER_ID) return true;
  const { data } = await supabase.from("bot_admins").select("*").eq("discord_id", userId).maybeSingle();
  return !!data;
}

async function safeReply(interaction, options) {
    try { if (interaction.replied || interaction.deferred) await interaction.editReply(options); else await interaction.reply(options); } catch (e) {}
}

// --- 🧠 CORE VERIFICATION LOGIC (REUSABLE) ---
async function processVerification(user, code, guild, replyCallback) {
    if (MAINTENANCE_MODE) return replyCallback({ content: "🚧 Maintenance Mode ON.", ephemeral: true });

    // 1. Check Poll Status (Punishment Logic)
    let isPollPunished = false;
    if (POLL_VERIFY_LOCK) {
        // Get Latest Active Poll
        const { data: activePoll } = await supabase.from("polls").select("id").eq("is_active", true).order('created_at', { ascending: false }).limit(1).maybeSingle();
        
        if (activePoll) {
            // Check if user voted on THIS specific poll
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) {
                isPollPunished = true; // Vote nahi kiya, to punishment milegi
            }
        }
    }

    // 2. Validate Code
    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("❌ Invalid Code")] });
    if (userData.is_banned) return replyCallback({ embeds: [new EmbedBuilder().setColor(0x000000).setTitle("🚫 BANNED")] });

    // 3. Calculate Time
    let calculation;
    if (isPollPunished) {
        // Punishment Logic: Fixed small time (e.g. 1 Hour)
        calculation = { duration: PUNISH_NO_VOTE_MS, ruleText: "⚠️ **No Vote Penalty** (Vote on Poll #polls for full time)", isPunished: true };
    } else {
        // Normal Role Logic
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
    
    // 4. Update DB
    await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: user.id }).eq("id", userData.id);

    // 5. Send Reply
    const embed = new EmbedBuilder()
        .setColor(isPunished ? 0xFFA500 : 0x00FF00) // Orange for Punish, Green for Success
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

async function calculateUserDuration(member, rules) {
  let activeRules = rules.map(r => { const discordRole = member.roles.cache.get(r.role_id); return discordRole ? { ...r, roleName: discordRole.name } : null; }).filter(r => r !== null);
  if (activeRules.length === 0) return { duration: DEFAULT_VERIFY_MS, ruleText: "Default (18h)", isPunished: false };
  // Check punishments
  const punishments = activeRules.filter(r => r.roleName.toLowerCase().startsWith("punish"));
  if (punishments.length > 0) {
    let minMs = Infinity; let selectedRule = null;
    punishments.forEach(r => { const ms = parseDuration(r.duration); if (ms !== "LIFETIME" && ms < minMs) { minMs = ms; selectedRule = r; } });
    return { duration: minMs, ruleText: `🚫 ${selectedRule.roleName}`, isPunished: true };
  }
  // Check Boosts
  const bases = activeRules.filter(r => !r.duration.startsWith("+"));
  const bonuses = activeRules.filter(r => r.duration.startsWith("+"));
  let maxBase = DEFAULT_VERIFY_MS; let baseName = "Default";
  bases.forEach(r => { const ms = parseDuration(r.duration); if (ms === "LIFETIME") { maxBase = "LIFETIME"; baseName = r.roleName; } else if (maxBase !== "LIFETIME" && ms > maxBase) { maxBase = ms; baseName = r.roleName; } });
  if (maxBase === "LIFETIME") return { duration: "LIFETIME", ruleText: `👑 ${baseName} (Lifetime)`, isPunished: false };
  let totalBonus = 0; bonuses.forEach(r => totalBonus += parseDuration(r.duration));
  return { duration: maxBase + totalBonus, ruleText: `✅ ${baseName} + ${bonuses.length} Boosts`, isPunished: false };
}

// --- 📜 COMMANDS ---
const commands = [
  new SlashCommandBuilder().setName("verify").setDescription("🔐 Verify access").addStringOption(o => o.setName("code").setDescription("6-digit code").setRequired(true)),
  new SlashCommandBuilder().setName("status").setDescription("📅 Check status"),
  new SlashCommandBuilder().setName("invites").setDescription("📊 Check invites").addUserOption(o => o.setName("user").setDescription("User")),
  new SlashCommandBuilder().setName("leaderboard").setDescription("🏆 Top 10 Inviters"),
  new SlashCommandBuilder().setName("whoinvited").setDescription("🕵️ Check inviter").addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
  new SlashCommandBuilder().setName("redeem").setDescription("🎁 Redeem Gift Key").addStringOption(o => o.setName("key").setDescription("Gift Key").setRequired(true)),

  new SlashCommandBuilder().setName("admin").setDescription("🛠️ Admin Tools")
    .addSubcommand(s => s.setName("poll").setDescription("🗳️ Start New Poll").addStringOption(o => o.setName("question").setRequired(true).setDescription("Question")).addStringOption(o => o.setName("option1").setRequired(true).setDescription("Opt 1")).addStringOption(o => o.setName("option2").setRequired(true).setDescription("Opt 2")))
    .addSubcommand(s => s.setName("pollresults").setDescription("📊 See Old Poll Results").addIntegerOption(o => o.setName("pollid").setDescription("Poll ID (Optional)").setRequired(false)))
    .addSubcommand(s => s.setName("say").setDescription("🤡 Anon Msg").addStringOption(o => o.setName("message").setRequired(true).setDescription("Msg")))
    .addSubcommand(s => s.setName("announce").setDescription("📢 Announce").addStringOption(o => o.setName("title").setRequired(true).setDescription("Title")).addStringOption(o => o.setName("message").setRequired(true).setDescription("Msg")).addStringOption(o => o.setName("image").setDescription("Img URL")))
    .addSubcommand(s => s.setName("purge").setDescription("🧹 Clear").addIntegerOption(o => o.setName("amount").setRequired(true).setDescription("Amount")))
    .addSubcommand(s => s.setName("stats").setDescription("📊 Stats"))
    .addSubcommand(s => s.setName("generate").setDescription("🎁 Gen Key").addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time")))
    .addSubcommand(s => s.setName("maintenance").setDescription("🚧 Maint Mode").addStringOption(o => o.setName("status").setRequired(true).setDescription("on/off").addChoices({name:'ON',value:'on'},{name:'OFF',value:'off'}))),
  
  new SlashCommandBuilder().setName("checkalts").setDescription("🕵️‍♂️ Show users with 2+ active keys"),
  new SlashCommandBuilder().setName("activeusers").setDescription("📜 List active users"),
  new SlashCommandBuilder().setName("userinfo").setDescription("🕵️‍♂️ User Alts").addUserOption(o => o.setName("user").setRequired(true).setDescription("User")),
  new SlashCommandBuilder().setName("syncmissing").setDescription("🔄 Sync Invites"),
  new SlashCommandBuilder().setName("config").setDescription("⚙️ Setup")
    .addSubcommand(s => s.setName("setchannel").setDescription("Set Channel").addChannelOption(o => o.setName("channel").setRequired(true).setDescription("Ch")))
    .addSubcommand(s => s.setName("setmessage").setDescription("Set Msg").addStringOption(o => o.setName("title").setRequired(true).setDescription("T")).addStringOption(o => o.setName("description").setRequired(true).setDescription("D")))
    .addSubcommand(s => s.setName("addreward").setDescription("Add Reward").addIntegerOption(o => o.setName("invites").setRequired(true).setDescription("N")).addRoleOption(o => o.setName("role").setRequired(true).setDescription("R"))),

  new SlashCommandBuilder().setName("setexpiry").setDescription("⚡ Add Time").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time")),
  new SlashCommandBuilder().setName("ban").setDescription("🚫 Ban").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("unban").setDescription("✅ Unban").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("lookup").setDescription("🔍 Search").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("resetuser").setDescription("⚠️ Delete User").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

// --- 🚀 EVENTS 🚀 ---
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  try { await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands }); } catch (e) { console.error(e); }
  for (const guild of client.guilds.cache.values()) { try { const invites = await guild.invites.fetch(); inviteCache.set(guild.id, new Collection(invites.map(i => [i.code, i.uses]))); } catch (e) {} }
});

client.on('inviteCreate', (invite) => { const invites = inviteCache.get(invite.guild.id); if (invites) invites.set(invite.code, invite.uses); });
client.on('inviteDelete', (invite) => { const invites = inviteCache.get(invite.guild.id); if (invites) invites.delete(invite.code); });

// TRACKER
client.on("guildMemberAdd", async member => {
    // ... (Same tracker logic) ...
    try {
        const newInvites = await member.guild.invites.fetch().catch(() => new Collection());
        const oldInvites = inviteCache.get(member.guild.id);
        const usedInvite = newInvites.find(i => i.uses > (oldInvites?.get(i.code) || 0));
        inviteCache.set(member.guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));
        let inviterId = null; let code = "Unknown";
        if (usedInvite) { inviterId = usedInvite.inviter?.id; code = usedInvite.code; }
        if (inviterId) {
            await supabase.from("joins").insert({ guild_id: member.guild.id, user_id: member.id, inviter_id: inviterId, code: code });
            const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", inviterId).maybeSingle();
            await supabase.from("invite_stats").upsert({ guild_id: member.guild.id, inviter_id: inviterId, total_invites: (ex?.total_invites || 0) + 1, real_invites: (ex?.real_invites || 0) + 1, fake_invites: ex?.fake_invites || 0, leaves: ex?.leaves || 0 });
        }
    } catch (e) {}
});

// 🔥 TEXT COMMAND SUPPORT IS BACK!
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  
  if (message.channel.id === VERIFY_CHANNEL_ID) {
      const content = message.content.trim();
      const isCmd = content.toLowerCase().startsWith("verify");
      
      // If not verify command and not admin -> Delete
      if (!isCmd && !(await isAdmin(message.author.id))) { 
          try { await message.delete(); } catch (e) {} 
          return;
      }
      
      // Handle "verify 123456"
      if (isCmd) {
          const args = content.split(/\s+/);
          if (args.length < 2) {
              const r = await message.reply("❌ **Usage:** `verify 123456`");
              setTimeout(() => r.delete().catch(()=>{}), 5000);
              return;
          }
          const code = args[1];
          // Use reusable function
          await processVerification(message.author, code, message.guild, (opts) => message.reply(opts));
      }
  }
});

// --- 🎮 INTERACTION HANDLER 🎮 ---
client.on("interactionCreate", async interaction => {
    try {
        // 🔥 VOTING BUTTONS
        if (interaction.isButton() && (interaction.customId === 'vote_opt1' || interaction.customId === 'vote_opt2')) {
            await interaction.deferReply({ ephemeral: true });
            
            // Get Latest Poll ID first
            const { data: activePoll } = await supabase.from("polls").select("id").eq("is_active", true).order('created_at', { ascending: false }).limit(1).maybeSingle();
            
            if (!activePoll) return interaction.editReply("❌ No active poll found.");

            const choice = interaction.customId === 'vote_opt1' ? 1 : 2;
            await supabase.from("poll_votes").upsert({ 
                poll_id: activePoll.id, 
                user_id: interaction.user.id, 
                choice: choice 
            });
            
            return interaction.editReply("✅ **Vote Registered!** Thank you.");
        }

        // Active Users Pagination
        if (interaction.isButton() && interaction.customId.startsWith('active_')) {
            const [_, direction, currentPage] = interaction.customId.split('_');
            let newPage = parseInt(currentPage) + (direction === 'next' ? 1 : -1);
            await interaction.deferUpdate();
            const { data: activeUsers, count } = await supabase.from("verifications").select("code, expires_at, discord_id", { count: 'exact' }).eq("verified", true).gt("expires_at", new Date().toISOString()).order("expires_at", { ascending: true }).range((newPage-1)*10, (newPage-1)*10 + 9);
            const totalPages = Math.ceil((count || 0) / 10);
            const embed = new EmbedBuilder().setColor(0x0099FF).setTitle(`📜 Active Users (Page ${newPage}/${totalPages})`).setDescription(`**Online:** ${count}`).setTimestamp();
            let desc = "";
            for (const [i, u] of activeUsers.entries()) {
                const left = new Date(u.expires_at).getTime() - Date.now();
                let nameLink = "`Unknown`";
                if (u.discord_id) { try { const user = client.users.cache.get(u.discord_id) || await client.users.fetch(u.discord_id); nameLink = `[**${user.username}**](https://discord.com/users/${u.discord_id})`; } catch (e) { nameLink = `[ID: ${u.discord_id}](https://discord.com/users/${u.discord_id})`; } }
                desc += `➤ **${((newPage-1)*10) + i + 1}.** ${nameLink}\n   └ 🔑 \`${u.code}\` | ⏳ ${formatTime(left)}\n\n`;
            }
            embed.setDescription(desc || "No users.");
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`active_prev_${newPage}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(newPage === 1), new ButtonBuilder().setCustomId(`active_next_${newPage}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(newPage >= totalPages));
            return interaction.editReply({ embeds: [embed], components: [row] });
        }

        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;

        if (commandName === "admin") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin Only", ephemeral: true });
            const sub = interaction.options.getSubcommand();
            
            // 🗳️ START NEW POLL
            if (sub === "poll") {
                 const q = interaction.options.getString("question");
                 const o1 = interaction.options.getString("option1");
                 const o2 = interaction.options.getString("option2");
                 
                 // Deactivate old polls
                 await supabase.from("polls").update({ is_active: false }).eq("is_active", true);
                 // Create new poll
                 const { data: newPoll } = await supabase.from("polls").insert({ question: q, option1: o1, option2: o2 }).select().single();
                 
                 POLL_VERIFY_LOCK = true; 
                 const embed = new EmbedBuilder().setColor('#00FF00').setTitle(`📢 Poll #${newPoll.id}`).setDescription(`**${q}**\n\n1️⃣ ${o1}\n2️⃣ ${o2}`).setFooter({text: "Vote required to verify!"});
                 const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vote_opt1').setLabel(o1).setStyle(ButtonStyle.Primary).setEmoji('1️⃣'), new ButtonBuilder().setCustomId('vote_opt2').setLabel(o2).setStyle(ButtonStyle.Primary).setEmoji('2️⃣'));
                 await interaction.channel.send({ content: "@everyone", embeds: [embed], components: [row] });
                 return safeReply(interaction, { content: `✅ Poll #${newPoll.id} Started!`, ephemeral: true });
            }
            
            // 📊 POLL RESULTS (History Support)
            if (sub === "pollresults") {
                await interaction.deferReply();
                let pollId = interaction.options.getInteger("pollid");
                
                // Get latest if no ID provided
                if (!pollId) {
                    const { data: latest } = await supabase.from("polls").select("id").order('created_at', { ascending: false }).limit(1).maybeSingle();
                    if (latest) pollId = latest.id;
                }

                if (!pollId) return interaction.editReply("❌ No polls found.");

                const { data: pollData } = await supabase.from("polls").select("*").eq("id", pollId).maybeSingle();
                if (!pollData) return interaction.editReply("❌ Invalid Poll ID.");

                const { count: c1 } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId).eq("choice", 1);
                const { count: c2 } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId).eq("choice", 2);
                const { count: total } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId);

                return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFA500).setTitle(`📊 Results: Poll #${pollId}`).setDescription(`**Q:** ${pollData.question}\n\n**Total Votes:** ${total}\n\n1️⃣ **${pollData.option1}:** ${c1}\n2️⃣ **${pollData.option2}:** ${c2}`)] });
            }

            // Stats, Generate, Etc.
            if (sub === "stats") { await interaction.deferReply(); const { count: v } = await supabase.from("verifications").select("*", { count: 'exact', head: true }).eq("verified", true); const { count: b } = await supabase.from("verifications").select("*", { count: 'exact', head: true }).eq("is_banned", true); const embed = new EmbedBuilder().setColor(0x00FFFF).setTitle("📊 Stats").addFields({name:"Verified",value:`${v}`,inline:true},{name:"Banned",value:`${b}`,inline:true},{name:"Poll Lock",value:POLL_VERIFY_LOCK?"ON":"OFF",inline:true}); return interaction.editReply({ embeds: [embed] }); }
            if (sub === "generate") { const dur = interaction.options.getString("duration"); const c = "GIFT-" + Math.random().toString(36).substring(2, 10).toUpperCase(); await supabase.from("gift_keys").insert({ code: c, duration: dur, created_by: interaction.user.username }); return safeReply(interaction, { content: `🎁 Key: \`${c}\` (${dur})`, ephemeral: true }); }
            if (sub === "maintenance") { MAINTENANCE_MODE = interaction.options.getString("status") === 'on'; return safeReply(interaction, { content: `🚧 Maintenance: **${MAINTENANCE_MODE}**`, ephemeral: true }); }
            if (sub === "announce") { const embed = new EmbedBuilder().setColor('#FFD700').setTitle(interaction.options.getString("title")).setDescription(interaction.options.getString("message")); if (interaction.options.getString("image")) embed.setImage(interaction.options.getString("image")); await interaction.channel.send({ embeds: [embed] }); return safeReply(interaction, { content: "✅ Sent", ephemeral: true }); }
            if (sub === "say") { const msg = interaction.options.getString("message"); await interaction.channel.send(msg); return safeReply(interaction, { content: "✅ Sent", ephemeral: true }); }
            if (sub === "purge") { const amt = interaction.options.getInteger("amount"); if(amt>100) return safeReply(interaction,"Max 100"); await interaction.channel.bulkDelete(amt, true); return safeReply(interaction, `Deleted ${amt}`); }
        }

        // VERIFY (USING REUSABLE FUNCTION)
        if (commandName === "verify") {
            await interaction.deferReply();
            const code = interaction.options.getString("code");
            await processVerification(interaction.user, code, interaction.guild, (opts) => interaction.editReply(opts));
        }

        // REDEEM (FIXED: ADDS TIME)
        if (commandName === "redeem") {
            await interaction.deferReply({ ephemeral: true });
            const key = interaction.options.getString("key");
            const { data: gift } = await supabase.from("gift_keys").select("*").eq("code", key).eq("is_redeemed", false).maybeSingle();
            if (!gift) return interaction.editReply("❌ Invalid/Used Key");
            const ms = parseDuration(gift.duration);
            const { data: user } = await supabase.from("verifications").select("*").eq("discord_id", interaction.user.id).limit(1).maybeSingle();
            if (!user) return interaction.editReply("❌ Verify first!");
            
            // Logic: Add time to existing expiry
            let currentExpiry = new Date(user.expires_at).getTime();
            if (currentExpiry < Date.now()) currentExpiry = Date.now();
            const newDate = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(currentExpiry + ms).toISOString();
            
            await supabase.from("verifications").update({ verified: true, expires_at: newDate }).eq("id", user.id);
            await supabase.from("gift_keys").update({ is_redeemed: true }).eq("id", gift.id);
            return interaction.editReply(`✅ **Redeemed!** Added: \`${gift.duration}\``);
        }

        // Other Commands (Shortened)
        if (commandName === "activeusers") { if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admins Only", ephemeral: true }); await interaction.deferReply(); const { data: activeUsers, count } = await supabase.from("verifications").select("code, expires_at, discord_id", { count: 'exact' }).eq("verified", true).gt("expires_at", new Date().toISOString()).order("expires_at", { ascending: true }).range(0, 9); const totalPages = Math.ceil((count || 0) / 10); const embed = new EmbedBuilder().setColor(0x0099FF).setTitle(`📜 Active Users (Page 1/${totalPages})`).setDescription(`**Online:** ${count}`).setTimestamp(); let desc = ""; for (const [i, u] of activeUsers.entries()) { const left = new Date(u.expires_at).getTime() - Date.now(); let nameLink = "`Unknown`"; if (u.discord_id) { try { const user = client.users.cache.get(u.discord_id) || await client.users.fetch(u.discord_id); nameLink = `[**${user.username}**](https://discord.com/users/${u.discord_id})`; } catch (e) { nameLink = `[ID: ${u.discord_id}](https://discord.com/users/${u.discord_id})`; } } desc += `➤ **${i + 1}.** ${nameLink}\n   └ 🔑 \`${u.code}\` | ⏳ ${formatTime(left)}\n\n`; } embed.setDescription(desc || "None"); const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`active_prev_1`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(true), new ButtonBuilder().setCustomId(`active_next_1`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(1 >= totalPages)); return interaction.editReply({ embeds: [embed], components: [row] }); }
        if (commandName === "checkalts") { await interaction.deferReply(); const {data:a}=await supabase.from("verifications").select("*").eq("verified",true).gt("expires_at",new Date().toISOString()); const m=new Map(); a.forEach(u=>{if(u.discord_id){if(!m.has(u.discord_id))m.set(u.discord_id,[]);m.get(u.discord_id).push(u)}}); const l=Array.from(m.entries()).filter(([i,arr])=>arr.length>=2); if(l.length==0)return interaction.editReply("✅ No Alts"); const e=new EmbedBuilder().setColor(0xFFA500).setTitle(`🕵️ ${l.length} Alt Users`); let d=""; l.forEach(([i,arr])=>{d+=`<@${i}> **(${arr.length} Keys)**\n`;arr.forEach(k=>d+=`   └ \`${k.code}\`\n`)}); e.setDescription(d.substring(0,4000)); return interaction.editReply({embeds:[e]}); }
        if (commandName === "lookup") { await interaction.deferReply(); const target = interaction.options.getString("target"); const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle(); if (!data) return interaction.editReply("❌ Not Found"); let userPfp = client.user.displayAvatarURL(); let userName = "Unknown"; if (data.discord_id) { try { const user = await client.users.fetch(data.discord_id); userPfp = user.displayAvatarURL(); userName = user.username; } catch (e) {} } const embed = new EmbedBuilder().setColor(0x00FFFF).setTitle(`🔍 Lookup: ${userName}`).setThumbnail(userPfp).addFields({ name: "🔑 Code", value: `\`${data.code}\``, inline: true }, { name: "👤 User", value: data.discord_id ? `<@${data.discord_id}>` : "`None`", inline: true }, { name: "🖥️ HWID", value: `\`${data.hwid}\``, inline: false }, { name: "📡 Status", value: data.is_banned ? "🚫 **BANNED**" : "✅ **Active**", inline: true }); return interaction.editReply({ embeds: [embed] }); }
        if (commandName === "ban") { await interaction.deferReply(); const target = interaction.options.getString("target"); await supabase.from("verifications").update({ is_banned: true, verified: false }).or(`code.eq.${target},hwid.eq.${target}`); return interaction.editReply(`🚫 Banned ${target}`); }
    } catch (err) { console.error("Err:", err); }
});

client.login(process.env.DISCORD_BOT_TOKEN);
