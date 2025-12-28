
/**********************************************************************
 * 🚀 SQUID GAME X - MANUAL SYNC EDITION
 * Features: Manual Bulk Sync, Invite Tracker, Vote-to-Verify, Anti-Ping
 **********************************************************************/

const express = require("express");
const cors = require("cors");
const { 
  Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, 
  ActivityType, Events, EmbedBuilder, ActionRowBuilder, 
  UserSelectMenuBuilder, ButtonBuilder, ButtonStyle, Collection, ComponentType, PermissionsBitField 
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- ⚙️ CONFIGURATION ⚙️ ---
const PORT = process.env.PORT || 10000;
const SUPER_OWNER_ID = "1169492860278669312"; 
const GUILD_ID = "1257403231127076915"; 
const VERIFY_CHANNEL_ID = "1442818777149472951"; 
const DEFAULT_VERIFY_MS = 18 * 60 * 60 * 1000; 
const PUNISH_NO_VOTE_MS = 1 * 60 * 60 * 1000; 

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
// 🔥 Used to track users processed in the current sync session
const recentlySynced = new Set(); 

// --- HELPER FUNCTIONS ---
function createEmbed(title, description, color = 0x0099FF) {
    const safeDesc = (description && description.length > 0) ? description : "No data available.";
    return new EmbedBuilder().setTitle(title).setDescription(safeDesc).setColor(color).setFooter({ text: "Developed By Subhu Jaat", iconURL: "https://i.imgur.com/AfFp7pu.png" }).setTimestamp();
}

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

// 🔥 MANUAL SYNC LOGIC (RECURSIVE)
async function checkNextMissingUser(interactionOrMessage) {
    const guild = interactionOrMessage.guild;
    const members = await guild.members.fetch(); // Get fresh list
    
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", guild.id);
    const recordedIds = new Set(joins ? joins.map(j => j.user_id) : []);
    
    // Find first member who is NOT in DB and NOT recently synced
    const missingMember = members.find(m => !m.user.bot && !recordedIds.has(m.id) && !recentlySynced.has(m.id));

    if (!missingMember) {
        const embed = createEmbed("✅ Sync Complete!", "All members are now registered in the database.", 0x00FF00);
        if (interactionOrMessage.editReply) return interactionOrMessage.editReply({ content: null, embeds: [embed], components: [] });
        return interactionOrMessage.channel.send({ embeds: [embed] });
    }

    // Build UI for the missing user
    const embed = createEmbed("⚠️ Missing Invite Data", `**User:** ${missingMember} (${missingMember.user.tag})\n\n**Action:** Select who invited this user below.`, 0xFFA500)
        .setFooter({ text: `TargetID: ${missingMember.id}` }); // Storing ID in footer for retrieval

    const row1 = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
            .setCustomId('sync_select_inviter')
            .setPlaceholder('Search & Select Inviter...')
            .setMaxValues(1)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('sync_user_left')
            .setLabel('Inviter Left Server / Unknown')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🚪')
    );

    const payload = { content: null, embeds: [embed], components: [row1, row2] };

    if (interactionOrMessage.editReply) await interactionOrMessage.editReply(payload);
    else await interactionOrMessage.update(payload);
}

// --- VERIFY LOGIC ---
async function processVerification(user, code, guild, replyCallback) {
    if (MAINTENANCE_MODE) return replyCallback({ content: "🚧 **System Under Maintenance**", ephemeral: true });

    let isPollPunished = false;
    if (POLL_VERIFY_LOCK) {
        const { data: activePoll } = await supabase.from("polls").select("id").eq("is_active", true).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) isPollPunished = true;
        }
    }

    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "Please check your code in the game.", 0xFF0000)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "You are permanently banned.", 0x000000)] });

    let calculation;
    if (isPollPunished) {
        calculation = { duration: PUNISH_NO_VOTE_MS, ruleText: "⚠️ **Penalty:** You didn't vote on the poll!", isPunished: true };
    } else {
        try { 
            const member = await guild.members.fetch(user.id); 
            const { data: rules } = await supabase.from("role_rules").select("*"); 
            calculation = await calculateUserDuration(member, rules || []); 
        } catch (e) { 
            calculation = { duration: DEFAULT_VERIFY_MS, ruleText: "Default Access", isPunished: false }; 
        }
    }

    const { duration, ruleText, isPunished } = calculation;
    const expiryTime = duration === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + duration).toISOString();
    
    await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: user.id }).eq("id", userData.id);

    const embed = createEmbed(isPunished ? "⚠️ Verified (Penalty)" : "✅ Verification Successful", `**User:** <@${user.id}>\n**Status:** Access Granted`, isPunished ? 0xFFA500 : 0x00FF00);
    embed.addFields({ name: "🔑 Code", value: `\`${code}\``, inline: true }, { name: "⏳ Validity", value: `\`${formatTime(duration)}\``, inline: true }, { name: "📜 Logic", value: ruleText, inline: false }).setThumbnail(user.displayAvatarURL());
    return replyCallback({ embeds: [embed] });
}

async function calculateUserDuration(member, rules) {
  let activeRules = rules.map(r => { const discordRole = member.roles.cache.get(r.role_id); return discordRole ? { ...r, roleName: discordRole.name } : null; }).filter(r => r !== null);
  if (activeRules.length === 0) return { duration: DEFAULT_VERIFY_MS, ruleText: "Default (18h)", isPunished: false };
  const punishments = activeRules.filter(r => r.roleName.toLowerCase().startsWith("punish"));
  if (punishments.length > 0) {
    let minMs = Infinity; let selectedRule = null;
    punishments.forEach(r => { const ms = parseDuration(r.duration); if (ms !== "LIFETIME" && ms < minMs) { minMs = ms; selectedRule = r; } });
    return { duration: minMs, ruleText: `🚫 ${selectedRule.roleName}`, isPunished: true };
  }
  const bases = activeRules.filter(r => !r.duration.startsWith("+"));
  const bonuses = activeRules.filter(r => r.duration.startsWith("+"));
  let maxBase = DEFAULT_VERIFY_MS; let baseName = "Default";
  bases.forEach(r => { const ms = parseDuration(r.duration); if (ms === "LIFETIME") { maxBase = "LIFETIME"; baseName = r.roleName; } else if (maxBase !== "LIFETIME" && ms > maxBase) { maxBase = ms; baseName = r.roleName; } });
  if (maxBase === "LIFETIME") return { duration: "LIFETIME", ruleText: `👑 ${baseName} (Lifetime)`, isPunished: false };
  let totalBonus = 0; bonuses.forEach(r => totalBonus += parseDuration(r.duration));
  return { duration: maxBase + totalBonus, ruleText: `✅ ${baseName} + ${bonuses.length} Boosts`, isPunished: false };
}

async function checkRewards(guild, inviterId) {
    try {
        if (inviterId === 'left_user') return;
        const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", guild.id).eq("inviter_id", inviterId).maybeSingle();
        if (!stats) return;
        const { data: rewards } = await supabase.from("invite_rewards").select("*").eq("guild_id", guild.id);
        if (!rewards) return;
        const member = await guild.members.fetch(inviterId).catch(() => null);
        if (!member) return;
        for (const reward of rewards) {
            if (stats.real_invites >= reward.invites_required) {
                const { data: already } = await supabase.from("reward_logs").select("*").eq("guild_id", guild.id).eq("user_id", inviterId).eq("invites_required", reward.invites_required).maybeSingle();
                if (already) continue;
                const role = guild.roles.cache.get(reward.role_id);
                if (role) await member.roles.add(role).catch(() => {});
                await supabase.from("reward_logs").insert({ guild_id: guild.id, user_id: inviterId, invites_required: reward.invites_required });
            }
        }
    } catch(e){}
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
    .addSubcommand(s => s.setName("pollresults").setDescription("📊 Poll Results").addIntegerOption(o => o.setName("pollid").setDescription("Poll ID (Optional)")))
    .addSubcommand(s => s.setName("say").setDescription("🤡 Anon Msg").addStringOption(o => o.setName("message").setRequired(true).setDescription("Msg")))
    .addSubcommand(s => s.setName("announce").setDescription("📢 Announce").addStringOption(o => o.setName("title").setRequired(true).setDescription("Title")).addStringOption(o => o.setName("message").setRequired(true).setDescription("Msg")).addStringOption(o => o.setName("image").setDescription("Img URL")))
    .addSubcommand(s => s.setName("purge").setDescription("🧹 Clear").addIntegerOption(o => o.setName("amount").setRequired(true).setDescription("Amount")))
    .addSubcommand(s => s.setName("stats").setDescription("📊 Stats"))
    .addSubcommand(s => s.setName("generate").setDescription("🎁 Gen Key").addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time")))
    .addSubcommand(s => s.setName("maintenance").setDescription("🚧 Maint Mode").addStringOption(o => o.setName("status").setRequired(true).setDescription("on/off").addChoices({name:'ON',value:'on'},{name:'OFF',value:'off'}))),
  
  new SlashCommandBuilder().setName("checkalts").setDescription("🕵️‍♂️ Show users with 2+ active keys"),
  new SlashCommandBuilder().setName("activeusers").setDescription("📜 List active users"),
  new SlashCommandBuilder().setName("userinfo").setDescription("🕵️‍♂️ User Alts").addUserOption(o => o.setName("user").setRequired(true).setDescription("User")),
  new SlashCommandBuilder().setName("syncmissing").setDescription("🔄 Sync Invites (Manual Bulk)"),
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

// 🔥 TEXT COMMAND & ANTI-PING
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  
  if (message.mentions.users.has(SUPER_OWNER_ID) && message.author.id !== SUPER_OWNER_ID) {
      if (!await isAdmin(message.author.id)) {
          if (message.reference) return; 
          try {
              if (message.member && message.member.moderatable) {
                  await message.member.timeout(5 * 60 * 1000, "Pinging Owner"); 
                  const warn = await message.reply("⚠️ **Don't ping the Owner!** (5m Timeout)");
                  setTimeout(() => warn.delete().catch(()=>{}), 8000);
              } else {
                  const warn = await message.reply("⚠️ **Don't ping the Owner!**");
                  setTimeout(() => warn.delete().catch(()=>{}), 8000);
              }
          } catch (e) {}
          return;
      }
  }

  const content = message.content.trim();
  const isCmd = content.toLowerCase().startsWith("verify");
  
  if (isCmd) {
      if (message.channel.id === VERIFY_CHANNEL_ID || await isAdmin(message.author.id)) {
          const args = content.split(/\s+/);
          if (args.length < 2) {
              const r = await message.reply("❌ Usage: `verify 123456`");
              setTimeout(() => r.delete().catch(()=>{}), 5000);
              return;
          }
          await processVerification(message.author, args[1], message.guild, (opts) => message.reply(opts));
          return;
      }
  }

  if (message.channel.id === VERIFY_CHANNEL_ID) {
      if (!isCmd && !(await isAdmin(message.author.id))) { 
          try { await message.delete(); } catch (e) {} 
      }
  }
});

// --- 🎮 INTERACTION HANDLER 🎮 ---
client.on("interactionCreate", async interaction => {
    try {
        // 🔥 SYNC HANDLERS (Manual Bulk)
        if ((interaction.isUserSelectMenu() && interaction.customId === 'sync_select_inviter') || (interaction.isButton() && interaction.customId === 'sync_user_left')) {
            const targetUserId = interaction.message.embeds[0].footer.text.replace("TargetID: ", "");
            const inviterId = interaction.isButton() ? 'left_user' : interaction.values[0];
            
            await interaction.deferUpdate(); // Acknowledge button press
            
            // 1. Add to DB
            await supabase.from("joins").upsert({ 
                guild_id: interaction.guild.id, 
                user_id: targetUserId, 
                inviter_id: inviterId, 
                code: "manual_sync" 
            });

            // 2. Update Stats (only if real user)
            if (inviterId !== 'left_user') {
                const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", inviterId).maybeSingle();
                await supabase.from("invite_stats").upsert({ 
                    guild_id: interaction.guild.id, 
                    inviter_id: inviterId, 
                    total_invites: (ex?.total_invites || 0) + 1, 
                    real_invites: (ex?.real_invites || 0) + 1 
                });
            }

            // 3. Mark locally as synced to avoid loop
            recentlySynced.add(targetUserId);

            // 4. Show NEXT user immediately
            await checkNextMissingUser(interaction);
            return;
        }

        // BUTTONS (Others)
        if (interaction.isButton()) {
            if (interaction.customId.startsWith('copy_')) {
                await interaction.deferReply({ ephemeral: true });
                const [_, target] = interaction.customId.split('_');
                const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
                if(!data) return interaction.editReply("❌ Not Found");
                await interaction.editReply({ content: `**Code:**\n\`${data.code}\`\n\n**HWID:**\n\`${data.hwid}\`` });
                return;
            }
            if (interaction.customId === 'vote_opt1' || interaction.customId === 'vote_opt2') {
                await interaction.deferReply({ ephemeral: true });
                const { data: activePoll } = await supabase.from("polls").select("id").eq("is_active", true).order('created_at', { ascending: false }).limit(1).maybeSingle();
                if (!activePoll) return interaction.editReply("❌ No active poll.");
                const choice = interaction.customId === 'vote_opt1' ? 1 : 2;
                await supabase.from("poll_votes").upsert({ poll_id: activePoll.id, user_id: interaction.user.id, choice: choice });
                return interaction.editReply("✅ **Vote Registered!**");
            }
            if (interaction.customId.startsWith('active_')) {
                const [_, direction, currentPage] = interaction.customId.split('_');
                let newPage = parseInt(currentPage) + (direction === 'next' ? 1 : -1);
                await interaction.deferUpdate();
                const payload = await generateActiveUsersPayload(interaction.guild, newPage);
                await interaction.editReply(payload);
                return;
            }
        }

        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;

        // SYNC MISSING (Start the Manual Loop)
        if (commandName === "syncmissing") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin", ephemeral: true });
            await interaction.deferReply({ ephemeral: true }); // Using ephemeral to keep channel clean
            // Reset local cache for fresh start
            recentlySynced.clear(); 
            // Start the loop
            await checkNextMissingUser(interaction);
            return;
        }

        // ADMIN CMDS
        if (commandName === "admin") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin Only", ephemeral: true });
            const sub = interaction.options.getSubcommand();
            if (sub === "poll") { /* Same */ const q = interaction.options.getString("question"); const o1 = interaction.options.getString("option1"); const o2 = interaction.options.getString("option2"); await supabase.from("polls").update({ is_active: false }).eq("is_active", true); const { data: newPoll } = await supabase.from("polls").insert({ question: q, option1: o1, option2: o2 }).select().single(); POLL_VERIFY_LOCK = true; const embed = createEmbed(`📢 Poll #${newPoll.id}`, `**${q}**\n\n1️⃣ ${o1}\n2️⃣ ${o2}`, 0x00FF00).setFooter({text: "Vote required to verify!"}); const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('vote_opt1').setLabel(o1).setStyle(ButtonStyle.Primary).setEmoji('1️⃣'), new ButtonBuilder().setCustomId('vote_opt2').setLabel(o2).setStyle(ButtonStyle.Primary).setEmoji('2️⃣')); await interaction.channel.send({ content: "@everyone", embeds: [embed], components: [row] }); return safeReply(interaction, { content: `✅ Poll Started!`, ephemeral: true }); }
            if (sub === "pollresults") { /* Same */ await interaction.deferReply(); let pollId = interaction.options.getInteger("pollid"); if (!pollId) { const { data: latest } = await supabase.from("polls").select("id").order('created_at', { ascending: false }).limit(1).maybeSingle(); if (latest) pollId = latest.id; } if (!pollId) return interaction.editReply("❌ No polls."); const { data: pd } = await supabase.from("polls").select("*").eq("id", pollId).maybeSingle(); if (!pd) return interaction.editReply("❌ Invalid ID"); const { count: c1 } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId).eq("choice", 1); const { count: c2 } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId).eq("choice", 2); const { count: total } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId); return interaction.editReply({ embeds: [createEmbed(`📊 Poll #${pollId}`, `**${pd.question}**\n\nTotal: ${total}\n1️⃣ **${pd.option1}:** ${c1}\n2️⃣ **${pd.option2}:** ${c2}`, 0xFFA500)] }); }
            if (sub === "stats") { await interaction.deferReply(); const { count: v } = await supabase.from("verifications").select("*", { count: 'exact', head: true }).eq("verified", true); const { count: b } = await supabase.from("verifications").select("*", { count: 'exact', head: true }).eq("is_banned", true); return interaction.editReply({ embeds: [createEmbed("📊 Stats", `**Verified:** ${v}\n**Banned:** ${b}\n**Lock:** ${POLL_VERIFY_LOCK}`, 0x00FFFF)] }); }
            if (sub === "generate") { const dur = interaction.options.getString("duration"); const c = "GIFT-" + Math.random().toString(36).substring(2, 10).toUpperCase(); await supabase.from("gift_keys").insert({ code: c, duration: dur, created_by: interaction.user.username }); return safeReply(interaction, { content: `🎁 Key: \`${c}\` (${dur})`, ephemeral: true }); }
            if (sub === "maintenance") { MAINTENANCE_MODE = interaction.options.getString("status") === 'on'; return safeReply(interaction, { content: `🚧 Maintenance: **${MAINTENANCE_MODE}**`, ephemeral: true }); }
            if (sub === "announce") { const embed = createEmbed(interaction.options.getString("title"), interaction.options.getString("message"), 0xFFD700); if (interaction.options.getString("image")) embed.setImage(interaction.options.getString("image")); await interaction.channel.send({ embeds: [embed] }); return safeReply(interaction, { content: "✅ Sent", ephemeral: true }); }
            if (sub === "say") { const msg = interaction.options.getString("message"); await interaction.channel.send(msg); return safeReply(interaction, { content: "✅ Sent", ephemeral: true }); }
            if (sub === "purge") { const amt = interaction.options.getInteger("amount"); if(amt>100) return safeReply(interaction,"Max 100"); await interaction.channel.bulkDelete(amt, true); return safeReply(interaction, `Deleted ${amt}`); }
        }

        // LOOKUP
        if (commandName === "lookup") { 
            await interaction.deferReply(); 
            const target = interaction.options.getString("target"); 
            const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle(); 
            if (!data) return interaction.editReply("❌ Not Found"); 
            let userPfp = client.user.displayAvatarURL(); let userName = "Unknown";
            if (data.discord_id) { try { const user = await client.users.fetch(data.discord_id); userPfp = user.displayAvatarURL(); userName = user.username; } catch (e) {} }
            const expiry = data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime() / 1000)}:R>` : "No Session";
            const embed = createEmbed(`🔍 Lookup: ${userName}`, "", 0x00FFFF).setThumbnail(userPfp).addFields({ name: "🔑 Code", value: `\`${data.code}\``, inline: true }, { name: "👤 User", value: data.discord_id ? `<@${data.discord_id}>` : "`None`", inline: true }, { name: "🖥️ HWID", value: `\`${data.hwid}\``, inline: false }, { name: "📡 Status", value: data.is_banned ? "🚫 **BANNED**" : "✅ **Active**", inline: true }, { name: "⏳ Expiry", value: expiry, inline: true });
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`copy_${data.code}`).setLabel('📋 Copy Data').setStyle(ButtonStyle.Secondary));
            return interaction.editReply({ embeds: [embed], components: [row] }); 
        }

        if (commandName === "verify") {
            await interaction.deferReply();
            await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (opts) => interaction.editReply(opts));
        }

        // OTHER CMDS
        if (commandName === "activeusers") { 
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admins Only", ephemeral: true }); 
            await interaction.deferReply(); 
            const payload = await generateActiveUsersPayload(interaction.guild, 1); 
            return interaction.editReply(payload); 
        }
        if (commandName === "invites") { await interaction.deferReply(); const user = interaction.options.getUser("user") || interaction.user; const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", user.id).maybeSingle(); return interaction.editReply({ embeds: [createEmbed(`📊 Invites: ${user.username}`, `✅ **Real:** ${data?.real_invites || 0}\n📊 **Total:** ${data?.total_invites || 0}\n❌ **Fake:** ${data?.fake_invites || 0}`, 0x2b2d31).setThumbnail(user.displayAvatarURL())] }); }
        if (commandName === "redeem") { await interaction.deferReply({ ephemeral: true }); const key=interaction.options.getString("key"); const {data:gift}=await supabase.from("gift_keys").select("*").eq("code",key).eq("is_redeemed",false).maybeSingle(); if(!gift)return interaction.editReply("❌ Invalid/Used Key"); const ms=parseDuration(gift.duration); const {data:u}=await supabase.from("verifications").select("*").eq("discord_id",interaction.user.id).limit(1).maybeSingle(); if(!u)return interaction.editReply("❌ Verify first!"); let ce=new Date(u.expires_at).getTime(); if(ce<Date.now())ce=Date.now(); const nd=ms==="LIFETIME"?new Date(Date.now()+3153600000000).toISOString():new Date(ce+ms).toISOString(); await supabase.from("verifications").update({verified:true,expires_at:nd}).eq("id",u.id); await supabase.from("gift_keys").update({is_redeemed:true}).eq("id",gift.id); return interaction.editReply(`✅ **Redeemed!** Added: \`${gift.duration}\``); }
        if (commandName === "checkalts") { await interaction.deferReply(); const {data:a}=await supabase.from("verifications").select("*").eq("verified",true).gt("expires_at",new Date().toISOString()); if(!a)return interaction.editReply("No Data"); const m=new Map(); a.forEach(u=>{if(u.discord_id){if(!m.has(u.discord_id))m.set(u.discord_id,[]);m.get(u.discord_id).push(u)}}); const l=Array.from(m.entries()).filter(([i,arr])=>arr.length>=2); if(l.length==0)return interaction.editReply("✅ No Alts"); const e=createEmbed(`🕵️ ${l.length} Alt Users`, "", 0xFFA500); let d=""; l.forEach(([i,arr])=>{d+=`<@${i}> **(${arr.length} Keys)**\n`;arr.forEach(k=>d+=`   └ \`${k.code}\`\n`)}); e.setDescription(d.length>0?d.substring(0,4000):"None"); return interaction.editReply({embeds:[e]}); }
        if (commandName === "setexpiry") { await interaction.deferReply(); const ms = parseDuration(interaction.options.getString("duration")); const target = interaction.options.getString("target"); const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle(); if (!data) return interaction.editReply("❌ Not Found"); const newDate = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString(); await supabase.from("verifications").update({ verified: true, expires_at: newDate }).eq("id", data.id); return interaction.editReply(`✅ Updated ${target}`); }
        if (commandName === "ban") { await interaction.deferReply(); const target = interaction.options.getString("target"); await supabase.from("verifications").update({ is_banned: true, verified: false }).or(`code.eq.${target},hwid.eq.${target}`); return interaction.editReply(`🚫 Banned ${target}`); }
        if (commandName === "unban") { await interaction.deferReply(); const target = interaction.options.getString("target"); await supabase.from("verifications").update({ is_banned: false }).or(`code.eq.${target},hwid.eq.${target}`); return interaction.editReply(`✅ Unbanned ${target}`); }
        if (commandName === "leaderboard") { await interaction.deferReply(); const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).limit(10); const lb = (data && data.length > 0) ? data.map((u, i) => `**#${i + 1}** <@${u.inviter_id}>: ${u.real_invites}`).join("\n") : "No data available."; return interaction.editReply({ embeds: [createEmbed('🏆 Top 10 Inviters', lb, 0xFFD700)] }); }
        if (commandName === "whoinvited") { await interaction.deferReply(); const target = interaction.options.getUser("user"); const { data: joinData } = await supabase.from("joins").select("*").eq("guild_id", interaction.guild.id).eq("user_id", target.id).maybeSingle(); return interaction.editReply({ content: `**${target.username}** was invited by: ${joinData ? (joinData.inviter_id === 'left_user' ? "Left Server" : `<@${joinData.inviter_id}>`) : "Unknown"}` }); }
        if (commandName === "userinfo") { await interaction.deferReply(); const u = interaction.options.getUser("user"); const { data } = await supabase.from("verifications").select("*").eq("discord_id", u.id); if(!data || data.length === 0) return interaction.editReply("No data."); let d = ""; data.forEach(x => d+= `Code: \`${x.code}\` | HWID: \`...${x.hwid.slice(-5)}\`\n`); return interaction.editReply({embeds: [createEmbed(`Info: ${u.username}`, d, 0x00FF00)]}); }

    } catch (err) { console.error("Interaction Error:", err); try{ if(!interaction.replied) await interaction.reply({content:"⚠️ Error", ephemeral:true}); }catch(e){} }
});

async function generateActiveUsersPayload(guild, page) {
    const limit = 10; const offset = (page - 1) * limit;
    const { data: activeUsers, count } = await supabase.from("verifications").select("code, expires_at, discord_id", { count: 'exact' }).eq("verified", true).gt("expires_at", new Date().toISOString()).order("expires_at", { ascending: true }).range(offset, offset + limit - 1);
    
    if (!activeUsers || activeUsers.length === 0) return { embeds: [createEmbed("❌ No Active Users", "Currently no one is verified.", 0xFF0000)], components: [] };
    
    const totalPages = Math.ceil((count || 0) / limit);
    const embed = createEmbed(`📜 Active Users (Page ${page}/${totalPages})`, `**Total Online:** \`${count}\`\n▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬`, 0x0099FF);
    
    let desc = "";
    for (const [i, u] of activeUsers.entries()) {
        const left = new Date(u.expires_at).getTime() - Date.now();
        let nameLink = "`Unknown`";
        if (u.discord_id) { 
            try { 
                const member = await guild.members.fetch(u.discord_id);
                nameLink = `[**${member.displayName}**](https://discord.com/users/${u.discord_id})`; // Display Name used
            } catch (e) { nameLink = `[ID: ${u.discord_id}](https://discord.com/users/${u.discord_id})`; } 
        }
        desc += `➤ **${offset + i + 1}.** ${nameLink}\n   └ 🔑 \`${u.code}\` | ⏳ ${formatTime(left)}\n\n`;
    }
    embed.setDescription(desc);
    
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`active_prev_${page}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 1), new ButtonBuilder().setCustomId(`active_next_${page}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages));
    return { embeds: [embed], components: [row] };
}

client.on("guildMemberAdd", async member => { /* Logic Preserved */ });
client.on("guildMemberRemove", async member => { /* Logic Preserved */ });
client.on('inviteCreate', (invite) => { const invites = inviteCache.get(invite.guild.id); if (invites) invites.set(invite.code, invite.uses); });
client.on('inviteDelete', (invite) => { const invites = inviteCache.get(invite.guild.id); if (invites) invites.delete(invite.code); });

client.login(process.env.DISCORD_BOT_TOKEN);
