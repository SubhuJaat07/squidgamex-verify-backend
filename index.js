/**********************************************************************
 * 🚀 SQUID GAME X - FINAL STABLE ANTI-CRASH EDITION
 * Fixes: 10062 (Timeout), 40060 (Double Reply), App Crash
 * Features: Verification, Invite Tracker, Gift System, Auto Mod,
 * Clickable Active Users, Admin Tools.
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
const VERIFY_CHANNEL_ID = "1444769950421225542"; 
const DEFAULT_VERIFY_MS = 18 * 60 * 60 * 1000; // 18 Hours

let MAINTENANCE_MODE = false;

// --- 🗄️ SUPABASE SETUP 🗄️ ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- 🌐 EXPRESS SERVER 🌐 ---
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send(`System Online 🟢 | Maintenance: ${MAINTENANCE_MODE ? "ON" : "OFF"}`));

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

// --- 🤖 DISCORD CLIENT 🤖 ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites
  ],
  partials: [Partials.GuildMember, Partials.Channel]
});

// Caches
const inviteCache = new Collection();
const recentlySynced = new Set();

// --- 🛠️ HELPER FUNCTIONS 🛠️ ---

function parseDuration(durationStr) {
  if (!durationStr) return 0;
  if (durationStr.toLowerCase() === "lifetime") return "LIFETIME";
  const cleanStr = durationStr.startsWith("+") ? durationStr.substring(1) : durationStr;
  const match = cleanStr.match(/^(\d+)([mhdw])$/);
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
  if (ms === "LIFETIME") return "Lifetime 👑";
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

function formatWelcomeMsg(text, member, inviterId, code) {
    if (!text) return "";
    return text
        .replace(/{user}/g, `${member}`)
        .replace(/{username}/g, member.user.username)
        .replace(/{inviter}/g, (inviterId && inviterId !== 'left_user') ? `<@${inviterId}>` : "**Someone**")
        .replace(/{code}/g, code || "N/A")
        .replace(/{count}/g, member.guild.memberCount);
}

// 🛡️ SAFE REPLY HANDLER (Prevents 10062 & 40060)
async function safeReply(interaction, options) {
    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.editReply(options);
        } else {
            await interaction.reply(options);
        }
    } catch (e) {
        console.error("SafeReply Error (Ignored):", e.message);
    }
}

// 📄 ACTIVE USERS PAYLOAD
async function generateActiveUsersPayload(page) {
    const limit = 10;
    const offset = (page - 1) * limit;

    const { data: activeUsers, count } = await supabase.from("verifications")
        .select("code, expires_at, discord_id", { count: 'exact' })
        .eq("verified", true)
        .gt("expires_at", new Date().toISOString())
        .order("expires_at", { ascending: true })
        .range(offset, offset + limit - 1);

    if (!activeUsers || activeUsers.length === 0) {
        return { embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("❌ No Active Users")], components: [] };
    }

    const totalPages = Math.ceil((count || 0) / limit);
    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`📜 Active Users (Page ${page}/${totalPages})`)
        .setDescription(`**Total Online:** ${count}`)
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
        desc += `**${offset + i + 1}.** ${nameLink} \n   └ 🔑 \`${u.code}\` | ⏳ ${formatTime(left)}\n\n`;
    }
    embed.setDescription(desc);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`active_prev_${page}`).setLabel('◀').setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
        new ButtonBuilder().setCustomId(`active_next_${page}`).setLabel('▶').setStyle(ButtonStyle.Primary).setDisabled(page >= totalPages)
    );

    return { embeds: [embed], components: [row] };
}

async function calculateUserDuration(member, rules) {
  let activeRules = rules.map(r => {
    const discordRole = member.roles.cache.get(r.role_id);
    return discordRole ? { ...r, roleName: discordRole.name } : null;
  }).filter(r => r !== null);

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

  let totalBonus = 0;
  bonuses.forEach(r => totalBonus += parseDuration(r.duration));
  return { duration: maxBase + totalBonus, ruleText: `✅ ${baseName} + ${bonuses.length} Boosts`, isPunished: false };
}

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
            const { data: already } = await supabase.from("reward_logs").select("*").eq("guild_id", guild.id).eq("user_id", inviterId).eq("invites_required", reward.invites_required).maybeSingle();
            if (already) continue;
            const role = guild.roles.cache.get(reward.role_id);
            if (role) await member.roles.add(role).catch(() => {});
            await supabase.from("reward_logs").insert({ guild_id: guild.id, user_id: inviterId, invites_required: reward.invites_required });
        }
    }
}

// --- 📜 COMMANDS ---
const commands = [
  new SlashCommandBuilder().setName("verify").setDescription("🔐 Verify access").addStringOption(o => o.setName("code").setDescription("6-digit code").setRequired(true)),
  new SlashCommandBuilder().setName("status").setDescription("📅 Check status"),
  new SlashCommandBuilder().setName("boost").setDescription("🚀 Check boosts"),
  new SlashCommandBuilder().setName("invites").setDescription("📊 Check invites").addUserOption(o => o.setName("user").setDescription("User")),
  new SlashCommandBuilder().setName("leaderboard").setDescription("🏆 Top 10 Inviters"),
  new SlashCommandBuilder().setName("whoinvited").setDescription("🕵️ Check inviter").addUserOption(o => o.setName("user").setDescription("User").setRequired(true)),
  new SlashCommandBuilder().setName("redeem").setDescription("🎁 Redeem a Gift Key").addStringOption(o => o.setName("key").setDescription("Enter Gift Key").setRequired(true)),

  new SlashCommandBuilder().setName("admin").setDescription("🛠️ All Admin Tools")
    .addSubcommand(s => s.setName("say").setDescription("🤡 Anonymous Bot Msg").addStringOption(o => o.setName("message").setRequired(true).setDescription("Message")))
    .addSubcommand(s => s.setName("announce").setDescription("📢 Announcement").addStringOption(o => o.setName("title").setRequired(true).setDescription("Title")).addStringOption(o => o.setName("message").setRequired(true).setDescription("Msg")).addStringOption(o => o.setName("image").setDescription("Img URL")))
    .addSubcommand(s => s.setName("purge").setDescription("🧹 Clear messages").addIntegerOption(o => o.setName("amount").setRequired(true).setDescription("Amount")))
    .addSubcommand(s => s.setName("banlist").setDescription("🚫 Show Banned Users"))
    .addSubcommand(s => s.setName("stats").setDescription("📊 Server/Bot Statistics"))
    .addSubcommand(s => s.setName("generate").setDescription("🎁 Generate Gift Key").addStringOption(o => o.setName("duration").setRequired(true).setDescription("e.g. 7d, 1m")))
    .addSubcommand(s => s.setName("maintenance").setDescription("🚧 Toggle Maintenance Mode").addStringOption(o => o.setName("status").setRequired(true).setDescription("on / off").addChoices({name:'ON',value:'on'},{name:'OFF',value:'off'}))),
  
  new SlashCommandBuilder().setName("activeusers").setDescription("📜 Admin: List users"),
  new SlashCommandBuilder().setName("userinfo").setDescription("🕵️‍♂️ Admin: Check alts").addUserOption(o => o.setName("user").setRequired(true).setDescription("User")),
  new SlashCommandBuilder().setName("syncmissing").setDescription("🔄 Admin: Fix data"),
  new SlashCommandBuilder().setName("config").setDescription("⚙️ Admin: Setup")
    .addSubcommand(s => s.setName("setchannel").setDescription("Set Channel").addChannelOption(o => o.setName("channel").setRequired(true).setDescription("Channel")))
    .addSubcommand(s => s.setName("setmessage").setDescription("Set Msg").addStringOption(o => o.setName("title").setRequired(true).setDescription("Title")).addStringOption(o => o.setName("description").setRequired(true).setDescription("Desc")))
    .addSubcommand(s => s.setName("addreward").setDescription("Add Reward").addIntegerOption(o => o.setName("invites").setRequired(true).setDescription("Count")).addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role"))),

  new SlashCommandBuilder().setName("setexpiry").setDescription("⚡ Admin: Add Time").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time")),
  new SlashCommandBuilder().setName("ban").setDescription("🚫 Admin: Ban").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("unban").setDescription("✅ Admin: Unban").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("lookup").setDescription("🔍 Admin: Search").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("setrule").setDescription("⚙️ Admin: Set Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("Duration")),
  new SlashCommandBuilder().setName("removerule").setDescription("⚙️ Admin: Remove Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")),
  new SlashCommandBuilder().setName("listrules").setDescription("📜 Admin: Show rules"),
  new SlashCommandBuilder().setName("resetuser").setDescription("⚠️ Admin: Delete user").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

// --- 🚀 EVENTS 🚀 ---

client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  client.user.setActivity('Squid Game X', { type: ActivityType.Watching });
  try { await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands }); console.log("🎉 Commands Deployed!"); } catch (e) { console.error(e); }
  for (const guild of client.guilds.cache.values()) { try { const invites = await guild.invites.fetch(); inviteCache.set(guild.id, new Collection(invites.map(i => [i.code, i.uses]))); } catch (e) {} }
});

client.on('inviteCreate', (invite) => { const invites = inviteCache.get(invite.guild.id); if (invites) invites.set(invite.code, invite.uses); });
client.on('inviteDelete', (invite) => { const invites = inviteCache.get(invite.guild.id); if (invites) invites.delete(invite.code); });

// TRACKER + WELCOME
client.on("guildMemberAdd", async member => {
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
            await checkRewards(member.guild, inviterId);
        }
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
        if (config?.welcome_channel) {
            const ch = member.guild.channels.cache.get(config.welcome_channel);
            if (ch) ch.send({ embeds: [new EmbedBuilder().setColor('#0099ff').setTitle(formatWelcomeMsg(config.welcome_title, member, inviterId, code)).setDescription(formatWelcomeMsg(config.welcome_desc, member, inviterId, code)).setThumbnail(member.user.displayAvatarURL()).setFooter({ text: `Member #${member.guild.memberCount}` }).setTimestamp()] });
        }
    } catch (e) { console.error("Join Error:", e); }
});

client.on("guildMemberRemove", async member => {
    try {
        const { data: join } = await supabase.from("joins").select("*").eq("guild_id", member.guild.id).eq("user_id", member.id).maybeSingle();
        if (join && join.inviter_id && join.inviter_id !== 'left_user') {
            const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id).maybeSingle();
            if (stats) await supabase.from("invite_stats").update({ real_invites: (stats.real_invites || 1) - 1, leaves: (stats.leaves || 0) + 1 }).eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id);
        }
    } catch (e) { console.error("Leave Error:", e); }
});

// Chat Lock
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.id === VERIFY_CHANNEL_ID) {
      const isCmd = message.content.toLowerCase().startsWith("verify");
      if (!isCmd && !(await isAdmin(message.author.id))) { try { await message.delete(); } catch (e) {} return; }
      if (isCmd) { const r = await message.reply("⚠️ Use `/verify <code>`"); setTimeout(() => r.delete().catch(()=>{}), 5000); }
  }
});

// --- 🎮 INTERACTION HANDLER 🎮 ---
client.on("interactionCreate", async interaction => {
    // 🛡️ ANTI-CRASH WRAPPER for all interactions
    try {
        // Handle Buttons (Pagination)
        if (interaction.isButton()) {
            if (interaction.customId.startsWith('active_')) {
                const [_, direction, currentPage] = interaction.customId.split('_');
                let newPage = parseInt(currentPage) + (direction === 'next' ? 1 : -1);
                await interaction.deferUpdate();
                const payload = await generateActiveUsersPayload(newPage);
                await interaction.editReply(payload);
                return;
            }
        }

        // Handle Sync Tracker
        if ((interaction.isUserSelectMenu() && interaction.customId === 'sync_select_inviter') || (interaction.isButton() && interaction.customId === 'sync_user_left')) {
            const inviterId = interaction.isButton() ? 'left_user' : interaction.values[0];
            const targetUserId = interaction.message.embeds[0].footer.text.replace("TargetID: ", "");
            recentlySynced.add(targetUserId);
            await interaction.deferUpdate();
            await supabase.from("joins").upsert({ guild_id: interaction.guild.id, user_id: targetUserId, inviter_id: inviterId, code: "manual" });
            if (inviterId !== 'left_user') {
                const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", inviterId).maybeSingle();
                await supabase.from("invite_stats").upsert({ guild_id: interaction.guild.id, inviter_id: inviterId, total_invites: (ex?.total_invites || 0) + 1, real_invites: (ex?.real_invites || 0) + 1 });
            }
            await interaction.editReply({ content: "✅ Synced!", components: [] });
            return;
        }

        if (!interaction.isChatInputCommand()) return;
        const { commandName } = interaction;

        // Admin Commands
        if (commandName === "admin") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin Only", ephemeral: true });
            
            const sub = interaction.options.getSubcommand();
            if (sub === "say") {
                 const msg = interaction.options.getString("message");
                 await interaction.channel.send(msg);
                 return safeReply(interaction, { content: "✅ Sent", ephemeral: true });
            }
            if (sub === "stats") {
                 await interaction.deferReply();
                 const { count: verifiedCount } = await supabase.from("verifications").select("*", { count: 'exact', head: true }).eq("verified", true);
                 const { count: bannedCount } = await supabase.from("verifications").select("*", { count: 'exact', head: true }).eq("is_banned", true);
                 const { count: totalKeys } = await supabase.from("verifications").select("*", { count: 'exact', head: true });
                 
                 const statsEmbed = new EmbedBuilder().setColor(0x00FFFF).setTitle("📊 Server Statistics")
                    .addFields(
                        { name: "Verified Users", value: `${verifiedCount}`, inline: true },
                        { name: "Banned Users", value: `${bannedCount}`, inline: true },
                        { name: "Total Keys", value: `${totalKeys}`, inline: true },
                        { name: "Maintenance", value: MAINTENANCE_MODE ? "🔴 ON" : "🟢 OFF", inline: true }
                    );
                 return interaction.editReply({ embeds: [statsEmbed] });
            }
            if (sub === "generate") {
                 const durationStr = interaction.options.getString("duration");
                 const code = "GIFT-" + Math.random().toString(36).substring(2, 10).toUpperCase();
                 await supabase.from("gift_keys").insert({ code, duration: durationStr, created_by: interaction.user.username });
                 return safeReply(interaction, { content: `🎁 **Gift Key:** \`${code}\`\n⏳ Duration: ${durationStr}`, ephemeral: true });
            }
            if (sub === "maintenance") {
                 const status = interaction.options.getString("status");
                 MAINTENANCE_MODE = status === 'on';
                 return safeReply(interaction, { content: `🚧 Maintenance Mode: **${status.toUpperCase()}**`, ephemeral: true });
            }
            if (sub === "announce") {
                 const embed = new EmbedBuilder().setColor('#FFD700').setTitle(interaction.options.getString("title")).setDescription(interaction.options.getString("message"));
                 if (interaction.options.getString("image")) embed.setImage(interaction.options.getString("image"));
                 await interaction.channel.send({ embeds: [embed] });
                 return safeReply(interaction, { content: "✅ Sent", ephemeral: true });
            }
            if (sub === "purge") {
                 const amount = interaction.options.getInteger("amount");
                 if (amount > 100) return safeReply(interaction, { content: "Max 100", ephemeral: true });
                 await interaction.channel.bulkDelete(amount, true);
                 return safeReply(interaction, { content: `🧹 Deleted ${amount}`, ephemeral: true });
            }
        }

        if (commandName === "activeusers") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admins Only", ephemeral: true });
            await interaction.deferReply(); 
            const payload = await generateActiveUsersPayload(1);
            return interaction.editReply(payload);
        }

        if (commandName === "redeem") {
            await interaction.deferReply({ ephemeral: true });
            if (MAINTENANCE_MODE) return interaction.editReply("🚧 Maintenance.");
            
            const key = interaction.options.getString("key");
            const { data: gift } = await supabase.from("gift_keys").select("*").eq("code", key).eq("is_redeemed", false).maybeSingle();
            if (!gift) return interaction.editReply("❌ Invalid/Used Key.");
            
            const ms = parseDuration(gift.duration);
            const { data: user } = await supabase.from("verifications").select("*").eq("discord_id", interaction.user.id).limit(1).maybeSingle();
            if (!user) return interaction.editReply("❌ Verify first.");
            
            const newDate = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString();
            await supabase.from("verifications").update({ verified: true, expires_at: newDate }).eq("id", user.id);
            await supabase.from("gift_keys").update({ is_redeemed: true }).eq("id", gift.id);
            return interaction.editReply(`✅ **Redeemed!** Time Added: ${gift.duration}`);
        }

        // Verification
        if (commandName === "verify") {
            if (MAINTENANCE_MODE) return safeReply(interaction, { content: "🚧 Maintenance.", ephemeral: true });
            await interaction.deferReply();
            const code = interaction.options.getString("code");
            const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
            if (!userData) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("❌ Invalid Code")] });
            if (userData.is_banned) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x000000).setTitle("🚫 BANNED")] });
            let calculation;
            try { const member = await interaction.guild.members.fetch(interaction.user.id); const { data: rules } = await supabase.from("role_rules").select("*"); calculation = await calculateUserDuration(member, rules || []); } catch (e) { calculation = { duration: DEFAULT_VERIFY_MS, ruleText: "Default", isPunished: false }; }
            const { duration, ruleText, isPunished } = calculation;
            const expiryTime = duration === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + duration).toISOString();
            await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: interaction.user.id }).eq("id", userData.id);
            return interaction.editReply({ embeds: [new EmbedBuilder().setColor(isPunished ? 0xFF0000 : 0x00FF00).setTitle(isPunished ? "⚠️ Restricted Access" : "✅ Verification Successful").addFields({ name: "Code", value: `\`${code}\``, inline: true }, { name: "Validity", value: formatTime(duration), inline: true }, { name: "Rule", value: ruleText, inline: false }).setThumbnail(interaction.user.displayAvatarURL())] });
        }

        // Standard Tracker Commands
        if (commandName === "invites") { await interaction.deferReply(); const user = interaction.options.getUser("user") || interaction.user; const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", user.id).maybeSingle(); return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#2b2d31').setTitle(`📊 Invites: ${user.username}`).addFields({ name: '✅ Real', value: `${data?.real_invites || 0}`, inline: true }, { name: '📊 Total', value: `${data?.total_invites || 0}`, inline: true }, { name: '❌ Fake', value: `${data?.fake_invites || 0}`, inline: true })] }); }
        if (commandName === "leaderboard") { await interaction.deferReply(); const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).limit(10); const lb = data?.map((u, i) => `**#${i + 1}** <@${u.inviter_id}>: ${u.real_invites} Invites`).join("\n") || "No data."; return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Top 10 Inviters').setDescription(lb)] }); }
        if (commandName === "whoinvited") { await interaction.deferReply(); const target = interaction.options.getUser("user"); const { data: joinData } = await supabase.from("joins").select("*").eq("guild_id", interaction.guild.id).eq("user_id", target.id).maybeSingle(); return interaction.editReply({ content: `**${target.username}** was invited by: ${joinData ? (joinData.inviter_id === 'left_user' ? "Left Server" : `<@${joinData.inviter_id}>`) : "Unknown"}` }); }
        
        // Config & DB Tools
        if (commandName === "config") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admins Only", ephemeral: true });
            await interaction.deferReply();
            const sub = interaction.options.getSubcommand();
            if (sub === "setchannel") { await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, welcome_channel: interaction.options.getChannel("channel").id }); return interaction.editReply("✅ Channel Set."); }
            if (sub === "setmessage") { const { data: ex } = await supabase.from("guild_config").select("welcome_channel").eq("guild_id", interaction.guild.id).maybeSingle(); await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, welcome_channel: ex?.welcome_channel, welcome_title: interaction.options.getString("title"), welcome_desc: interaction.options.getString("description") }); return interaction.editReply("✅ Message Set."); }
            if (sub === "addreward") { await supabase.from("invite_rewards").insert({ guild_id: interaction.guild.id, invites_required: interaction.options.getInteger("invites"), role_id: interaction.options.getRole("role").id }); return interaction.editReply("✅ Reward Added."); }
        }
        if (commandName === "setexpiry") { await interaction.deferReply(); const ms = parseDuration(interaction.options.getString("duration")); const target = interaction.options.getString("target"); const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle(); if (!data) return interaction.editReply("❌ Not Found"); const newDate = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString(); await supabase.from("verifications").update({ verified: true, expires_at: newDate }).eq("id", data.id); return interaction.editReply(`✅ Updated ${target}`); }
        if (commandName === "lookup") { await interaction.deferReply(); const target = interaction.options.getString("target"); const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle(); if (!data) return interaction.editReply("❌ Not Found"); return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00FFFF).setTitle("🔍 Lookup").addFields({ name: "Code", value: data.code, inline: true }, { name: "HWID", value: data.hwid, inline: true }, { name: "User", value: data.discord_id ? `<@${data.discord_id}>` : "None", inline: true }, { name: "Status", value: data.is_banned ? "🚫 BANNED" : "Active" })] }); }
        if (commandName === "ban") { await interaction.deferReply(); const target = interaction.options.getString("target"); await supabase.from("verifications").update({ is_banned: true, verified: false }).or(`code.eq.${target},hwid.eq.${target}`); return interaction.editReply(`🚫 Banned ${target}`); }
        if (commandName === "unban") { await interaction.deferReply(); const target = interaction.options.getString("target"); await supabase.from("verifications").update({ is_banned: false }).or(`code.eq.${target},hwid.eq.${target}`); return interaction.editReply(`✅ Unbanned ${target}`); }

    } catch (err) {
        console.error("Critical Interaction Error:", err);
        // Try to inform the user if possible
        try { if(!interaction.replied && !interaction.deferred) await interaction.reply({ content: "⚠️ System Error. Try again.", ephemeral: true }); } catch(e){}
    }
});

// 🛡️ GLOBAL ANTI-CRASH HANDLERS
process.on('unhandledRejection', (reason, p) => {
    console.log(' [antiCrash] :: Unhandled Rejection/Catch');
    console.log(reason, p);
});
process.on("uncaughtException", (err, origin) => {
    console.log(' [antiCrash] :: Uncaught Exception/Catch');
    console.log(err, origin);
});
process.on('uncaughtExceptionMonitor', (err, origin) => {
    console.log(' [antiCrash] :: Uncaught Exception/Catch (MONITOR)');
    console.log(err, origin);
});

client.login(process.env.DISCORD_BOT_TOKEN);
