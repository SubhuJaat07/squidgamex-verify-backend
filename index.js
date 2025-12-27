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

// --- 🗄️ SUPABASE SETUP 🗄️ ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- 🌐 EXPRESS SERVER (Keep Alive & API) 🌐 ---
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("System Online 🟢"));

// Verification Check API (Roblox Script calls this)
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });
  
  const { data: existing } = await supabase.from("verifications").select("*").eq("hwid", hwid).maybeSingle();
  
  if (existing) {
    if (existing.is_banned) return res.json({ status: "BANNED", message: "Contact Admin" });
    if (existing.verified && new Date(existing.expires_at) > new Date()) return res.json({ status: "VALID" });
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }
  
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await supabase.from("verifications").insert([{ hwid, code, verified: false, is_banned: false }]);
  return res.json({ status: "NEED_VERIFY", code });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Server Running on Port ${PORT}`);
});

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

// Global Caches
const inviteCache = new Collection();
const recentlySynced = new Set();

// --- 🛠️ HELPER FUNCTIONS 🛠️ ---

// 1. Time Parser (1d, 2h, etc.)
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

// 2. Time Formatter
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

// 3. Admin Check
async function isAdmin(userId) {
  if (userId === SUPER_OWNER_ID) return true;
  const { data } = await supabase.from("bot_admins").select("*").eq("discord_id", userId).maybeSingle();
  return !!data;
}

// 4. Welcome Message Formatter
function formatWelcomeMsg(text, member, inviterId, code) {
    if (!text) return "";
    return text
        .replace(/{user}/g, `${member}`)
        .replace(/{username}/g, member.user.username)
        .replace(/{inviter}/g, (inviterId && inviterId !== 'left_user') ? `<@${inviterId}>` : "**Someone**")
        .replace(/{code}/g, code || "N/A")
        .replace(/{count}/g, member.guild.memberCount);
}

// 5. Verification Duration Calculator (Complex Logic)
async function calculateUserDuration(member, rules) {
  let activeRules = rules.map(r => {
    const discordRole = member.roles.cache.get(r.role_id);
    return discordRole ? { ...r, roleName: discordRole.name } : null;
  }).filter(r => r !== null);

  if (activeRules.length === 0) {
    return { duration: DEFAULT_VERIFY_MS, ruleText: "Default (18h)", isPunished: false };
  }

  // Check Punishments first
  const punishments = activeRules.filter(r => r.roleName.toLowerCase().startsWith("punish"));
  if (punishments.length > 0) {
    let minMs = Infinity;
    let selectedRule = null;
    punishments.forEach(r => {
      const ms = parseDuration(r.duration);
      if (ms !== "LIFETIME" && ms < minMs) { minMs = ms; selectedRule = r; }
    });
    return { duration: minMs, ruleText: `🚫 ${selectedRule.roleName}`, isPunished: true };
  }

  // Base vs Bonus
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
  bonuses.forEach(r => totalBonus += parseDuration(r.duration));

  const finalDuration = maxBase + totalBonus;
  const bonusText = bonuses.length > 0 ? ` + ${bonuses.length} Boosts` : "";
  const ruleText = `✅ ${baseName}${bonusText}`;
  return { duration: finalDuration, ruleText, isPunished: false };
}

// 6. Invite Reward Checker
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

// --- 📜 COMMANDS REGISTRATION 📜 ---
const commands = [
  // VERIFICATION
  new SlashCommandBuilder().setName("verify").setDescription("🔐 Verify your game access instantly").addStringOption(o => o.setName("code").setDescription("Enter your 6-digit code").setRequired(true)),
  new SlashCommandBuilder().setName("status").setDescription("📅 Check your own verification status"),
  new SlashCommandBuilder().setName("boost").setDescription("🚀 Check your VIP role boosts"),
  
  // INVITE TRACKER
  new SlashCommandBuilder().setName("invites").setDescription("📊 Check invites").addUserOption(o => o.setName("user").setDescription("Select user")),
  new SlashCommandBuilder().setName("leaderboard").setDescription("🏆 Top 10 Inviters"),
  new SlashCommandBuilder().setName("whoinvited").setDescription("🕵️ Check who invited a user").addUserOption(o => o.setName("user").setDescription("Select user").setRequired(true)),
  new SlashCommandBuilder().setName("syncmissing").setDescription("🔄 Admin: Fix missing invite data"),
  new SlashCommandBuilder().setName("config").setDescription("⚙️ Admin: Setup Welcome/Rewards")
    .addSubcommand(s => s.setName("setchannel").setDescription("Set Welcome Channel").addChannelOption(o => o.setName("channel").setRequired(true).setDescription("Channel")))
    .addSubcommand(s => s.setName("setmessage").setDescription("Set Welcome Msg").addStringOption(o => o.setName("title").setRequired(true).setDescription("Title")).addStringOption(o => o.setName("description").setRequired(true).setDescription("Desc")))
    .addSubcommand(s => s.setName("addreward").setDescription("Add Role Reward").addIntegerOption(o => o.setName("invites").setRequired(true).setDescription("Count")).addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role"))),

  // ADMIN
  new SlashCommandBuilder().setName("announce").setDescription("📢 Send announcement").addStringOption(o => o.setName("title").setRequired(true).setDescription("Title")).addStringOption(o => o.setName("message").setRequired(true).setDescription("Msg")).addStringOption(o => o.setName("image").setDescription("Img URL")),
  new SlashCommandBuilder().setName("purge").setDescription("🧹 Clear messages").addIntegerOption(o => o.setName("amount").setRequired(true).setDescription("Amount")),
  new SlashCommandBuilder().setName("activeusers").setDescription("📜 Admin: List online users").addIntegerOption(o => o.setName("page").setDescription("Page")),
  new SlashCommandBuilder().setName("userinfo").setDescription("🕵️‍♂️ Admin: Check alt accounts").addUserOption(o => o.setName("user").setRequired(true).setDescription("User")),
  new SlashCommandBuilder().setName("setexpiry").setDescription("⚡ Admin: Add/Set Time").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time")),
  new SlashCommandBuilder().setName("ban").setDescription("🚫 Admin: Ban user").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("unban").setDescription("✅ Admin: Unban user").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("lookup").setDescription("🔍 Admin: Search DB").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
  new SlashCommandBuilder().setName("setrule").setDescription("⚙️ Admin: Set Role Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("Duration")),
  new SlashCommandBuilder().setName("removerule").setDescription("⚙️ Admin: Remove Role Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")),
  new SlashCommandBuilder().setName("listrules").setDescription("📜 Admin: Show rules"),
  new SlashCommandBuilder().setName("resetuser").setDescription("⚠️ Admin: Delete user").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

// --- 🚀 EVENTS: STARTUP & TRACKING 🚀 ---

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot Logged In as: ${client.user.tag}`);
  client.user.setActivity('Squid Game X', { type: ActivityType.Watching });
  
  // Register Slash Commands
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("🎉 SUCCESS: All Commands Registered!");
  } catch (error) { console.error("❌ Command Error:", error); }

  // Cache Invites (Critical for Tracker)
  for (const guild of client.guilds.cache.values()) {
        try {
            const invites = await guild.invites.fetch();
            inviteCache.set(guild.id, new Collection(invites.map(i => [i.code, i.uses])));
        } catch (e) { console.log(`❌ No Invite Perms: ${guild.name}`); }
  }
});

// Update Cache on Invite Create/Delete
client.on('inviteCreate', (invite) => { const invites = inviteCache.get(invite.guild.id); if (invites) invites.set(invite.code, invite.uses); });
client.on('inviteDelete', (invite) => { const invites = inviteCache.get(invite.guild.id); if (invites) invites.delete(invite.code); });

// --- 🚪 MEMBER JOIN (TRACKING + WELCOME) 🚪 ---
client.on("guildMemberAdd", async member => {
    // 1. TRACK INVITE
    const newInvites = await member.guild.invites.fetch().catch(() => new Collection());
    const oldInvites = inviteCache.get(member.guild.id);
    const usedInvite = newInvites.find(i => i.uses > (oldInvites?.get(i.code) || 0));
    inviteCache.set(member.guild.id, new Collection(newInvites.map(i => [i.code, i.uses])));

    let inviterId = null; let code = "Unknown";
    if (usedInvite) { inviterId = usedInvite.inviter?.id; code = usedInvite.code; }

    if (inviterId) {
        await supabase.from("joins").insert({ guild_id: member.guild.id, user_id: member.id, inviter_id: inviterId, code: code });
        const { data: existing } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", inviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({
            guild_id: member.guild.id, inviter_id: inviterId,
            total_invites: (existing?.total_invites || 0) + 1, real_invites: (existing?.real_invites || 0) + 1,
            fake_invites: existing?.fake_invites || 0, leaves: existing?.leaves || 0
        });
        await checkRewards(member.guild, inviterId);
    }

    // 2. WELCOME MESSAGE
    const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
    if (config?.welcome_channel) {
        const channel = member.guild.channels.cache.get(config.welcome_channel);
        if (channel) {
            const title = formatWelcomeMsg(config.welcome_title || "Welcome!", member, inviterId, code);
            const desc = formatWelcomeMsg(config.welcome_desc || `Welcome {user} to the server!`, member, inviterId, code);
            const embed = new EmbedBuilder().setColor('#0099ff').setTitle(title).setDescription(desc)
                .setThumbnail(member.user.displayAvatarURL()).setFooter({ text: `Member #${member.guild.memberCount}` }).setTimestamp();
            channel.send({ embeds: [embed] });
        }
    }
});

// --- 👋 MEMBER LEAVE ---
client.on("guildMemberRemove", async member => {
    const { data: join } = await supabase.from("joins").select("*").eq("guild_id", member.guild.id).eq("user_id", member.id).maybeSingle();
    if (join && join.inviter_id && join.inviter_id !== 'left_user') {
        const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id).maybeSingle();
        if (stats) {
            await supabase.from("invite_stats").update({
                real_invites: (stats.real_invites || 1) - 1, leaves: (stats.leaves || 0) + 1
            }).eq("guild_id", member.guild.id).eq("inviter_id", join.inviter_id);
        }
    }
});

// --- 🔒 CHAT LOCK & AUTO MOD 🔒 ---
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  
  if (message.channel.id === VERIFY_CHANNEL_ID) {
      const isCmd = message.content.toLowerCase().startsWith("verify");
      const isAdminUser = await isAdmin(message.author.id);
      
      // Delete non-verify messages (unless admin)
      if (!isCmd && !isAdminUser) {
          try { await message.delete(); } catch (e) {} 
          return;
      }
      
      // Auto-reply for text verify
      if (isCmd) {
         const r = await message.reply({ content: "⚠️ **Please use Slash Command** `/verify <code>` for better security!", allowedMentions: { repliedUser: true } });
         setTimeout(() => r.delete().catch(()=>{}), 8000);
      }
  }
  
  if (message.content === "😎" && message.author.id === SUPER_OWNER_ID) {
      message.reply("System faad denge sir! 🔥");
  }
});

// --- 🎮 INTERACTION HANDLER 🎮 ---
client.on("interactionCreate", async interaction => {
    
    // 1. SYNC MISSING (Button Handling)
    if ((interaction.isUserSelectMenu() && interaction.customId === 'sync_select_inviter') || 
        (interaction.isButton() && interaction.customId === 'sync_user_left')) {
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

    // --- TRACKER COMMANDS ---
    if (commandName === "invites") {
        await interaction.deferReply();
        const user = interaction.options.getUser("user") || interaction.user;
        const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", user.id).maybeSingle();
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#2b2d31').setTitle(`📊 Invites: ${user.username}`).addFields({ name: '✅ Real', value: `${data?.real_invites || 0}`, inline: true }, { name: '📊 Total', value: `${data?.total_invites || 0}`, inline: true }, { name: '❌ Fake', value: `${data?.fake_invites || 0}`, inline: true })] });
    }

    if (commandName === "leaderboard") {
        await interaction.deferReply();
        const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).limit(10);
        const lb = data?.map((u, i) => `**#${i + 1}** <@${u.inviter_id}>: ${u.real_invites} Invites`).join("\n") || "No data.";
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor('#FFD700').setTitle('🏆 Top 10 Inviters').setDescription(lb)] });
    }

    if (commandName === "whoinvited") {
        await interaction.deferReply();
        const target = interaction.options.getUser("user");
        const { data: joinData } = await supabase.from("joins").select("*").eq("guild_id", interaction.guild.id).eq("user_id", target.id).maybeSingle();
        const inviterText = joinData ? (joinData.inviter_id === 'left_user' ? "Left Server" : `<@${joinData.inviter_id}>`) : "Unknown";
        return interaction.editReply({ content: `**${target.username}** was invited by: ${inviterText}` });
    }

    // --- VERIFICATION COMMAND ---
    if (commandName === "verify") {
        await interaction.deferReply();
        const code = interaction.options.getString("code");
        const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
        
        if (!userData) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("❌ Invalid Code").setDescription("Check Roblox Game for Code")] });
        if (userData.is_banned) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x000000).setTitle("🚫 BANNED")] });

        // Calculate Logic
        let calculation;
        try {
            const member = await interaction.guild.members.fetch(interaction.user.id);
            const { data: rules } = await supabase.from("role_rules").select("*");
            calculation = await calculateUserDuration(member, rules || []);
        } catch (e) { calculation = { duration: DEFAULT_VERIFY_MS, ruleText: "Default", isPunished: false }; }

        const { duration, ruleText, isPunished } = calculation;
        let expiryTime;
        if (duration === "LIFETIME") {
            const d = new Date(); d.setFullYear(d.getFullYear() + 100); expiryTime = d.toISOString();
        } else { expiryTime = new Date(Date.now() + duration).toISOString(); }

        await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: interaction.user.id }).eq("id", userData.id);

        const embed = new EmbedBuilder()
            .setColor(isPunished ? 0xFF0000 : 0x00FF00)
            .setTitle(isPunished ? "⚠️ Restricted Access" : "✅ Verification Successful")
            .addFields(
                { name: "Code", value: `\`${code}\``, inline: true },
                { name: "Validity", value: formatTime(duration), inline: true },
                { name: "Rule", value: ruleText, inline: false }
            )
            .setThumbnail(interaction.user.displayAvatarURL());
        
        return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === "boost") {
        await interaction.deferReply();
        const member = await interaction.guild.members.fetch(interaction.user.id);
        const { data: rules } = await supabase.from("role_rules").select("*");
        const calc = await calculateUserDuration(member, rules || []);
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFFA500).setTitle("🚀 Boost Status").addFields({ name: "Logic", value: calc.ruleText }, { name: "Time", value: formatTime(calc.duration) })] });
    }
    
    if (commandName === "status") {
        await interaction.deferReply({ ephemeral: true });
        const { data: accounts } = await supabase.from("verifications").select("*").eq("discord_id", interaction.user.id);
        if (!accounts?.length) return interaction.editReply("❌ Not verified.");
        const embed = new EmbedBuilder().setTitle("📅 Status").setColor(0x00FF00);
        accounts.forEach((a,i) => {
            const left = new Date(a.expires_at).getTime() - Date.now();
            embed.addFields({ name: `Device ${i+1}`, value: `Code: \`${a.code}\`\nTime: ${formatTime(left)}` });
        });
        return interaction.editReply({ embeds: [embed] });
    }

    // --- ADMIN COMMANDS ---
    if (!await isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Admins Only", ephemeral: true });

    // ✅ ACTIVE USERS (CLICKABLE NAME FIX)
    if (commandName === "activeusers") {
        await interaction.deferReply(); 
        const limit = 10; 
        const page = interaction.options.getInteger("page") || 1;
        const offset = (page - 1) * limit;
        
        const { data: activeUsers } = await supabase.from("verifications")
            .select("code, expires_at, discord_id")
            .eq("verified", true)
            .gt("expires_at", new Date().toISOString())
            .order("expires_at", { ascending: true })
            .range(offset, offset + limit - 1);
    
        if (!activeUsers?.length) return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("❌ No Active Users")] });
    
        const embed = new EmbedBuilder().setColor(0x0099FF).setTitle(`📜 Active Users (Page ${page})`).setTimestamp();
        
        const fields = [];
        for (const [i, u] of activeUsers.entries()) {
            const left = new Date(u.expires_at).getTime() - Date.now();
            // 👇 THIS IS THE CLICKABLE NAME FIX (Markdown Link)
            let userDisplay = u.discord_id ? `[Open Profile](https://discord.com/users/${u.discord_id})` : "`Unknown`";
            
            // Try fetching name if cached
            if(u.discord_id) {
                const user = client.users.cache.get(u.discord_id);
                if(user) userDisplay = `[${user.username}](https://discord.com/users/${u.discord_id})`;
            }

            fields.push({ 
                name: `#${offset + i + 1} (${u.code})`, 
                value: `👤 ${userDisplay}\n⏳ ${formatTime(left)}`, 
                inline: true 
            });
        }
        embed.addFields(fields);
        return interaction.editReply({ embeds: [embed] });
    }

    if (commandName === "config") {
        await interaction.deferReply();
        const sub = interaction.options.getSubcommand();
        if (sub === "setchannel") {
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, welcome_channel: interaction.options.getChannel("channel").id });
            return interaction.editReply("✅ Channel Set.");
        }
        if (sub === "setmessage") {
             const { data: ex } = await supabase.from("guild_config").select("welcome_channel").eq("guild_id", interaction.guild.id).maybeSingle();
             await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, welcome_channel: ex?.welcome_channel, welcome_title: interaction.options.getString("title"), welcome_desc: interaction.options.getString("description") });
             return interaction.editReply("✅ Message Set.");
        }
        if (sub === "addreward") {
            await supabase.from("invite_rewards").insert({ guild_id: interaction.guild.id, invites_required: interaction.options.getInteger("invites"), role_id: interaction.options.getRole("role").id });
            return interaction.editReply("✅ Reward Added.");
        }
    }

    if (commandName === "announce") {
        const embed = new EmbedBuilder().setColor('#FFD700').setTitle(interaction.options.getString("title")).setDescription(interaction.options.getString("message"));
        if (interaction.options.getString("image")) embed.setImage(interaction.options.getString("image"));
        await interaction.channel.send({ embeds: [embed] });
        return interaction.reply({ content: "✅ Sent", ephemeral: true });
    }

    if (commandName === "purge") {
        const amount = interaction.options.getInteger("amount");
        if (amount > 100) return interaction.reply({ content: "Max 100", ephemeral: true });
        await interaction.channel.bulkDelete(amount, true);
        return interaction.reply({ content: `🧹 Deleted ${amount}`, ephemeral: true });
    }

    // Other Admin Commands (SetExpiry, Ban, Lookup etc.)
    if (commandName === "setexpiry") {
        await interaction.deferReply();
        const ms = parseDuration(interaction.options.getString("duration"));
        if (!ms) return interaction.editReply("❌ Invalid Duration");
        const target = interaction.options.getString("target");
        const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
        if (!data) return interaction.editReply("❌ Not Found");
        const newDate = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString();
        await supabase.from("verifications").update({ verified: true, expires_at: newDate }).eq("id", data.id);
        return interaction.editReply(`✅ Updated ${target}`);
    }

    if (commandName === "lookup") {
        await interaction.deferReply();
        const target = interaction.options.getString("target");
        const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
        if (!data) return interaction.editReply("❌ Not Found");
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0x00FFFF).setTitle("🔍 Lookup").addFields(
            { name: "Code", value: data.code, inline: true },
            { name: "HWID", value: data.hwid, inline: true },
            { name: "User", value: data.discord_id ? `<@${data.discord_id}>` : "None", inline: true },
            { name: "Status", value: data.is_banned ? "🚫 BANNED" : "Active" }
        )] });
    }

    // Ban/Unban/Userinfo/Rules (Standard logic)
    if (commandName === "ban") {
        await interaction.deferReply();
        const target = interaction.options.getString("target");
        await supabase.from("verifications").update({ is_banned: true, verified: false }).or(`code.eq.${target},hwid.eq.${target}`);
        return interaction.editReply(`🚫 Banned ${target}`);
    }
});

// --- FINAL LOGIN ---
client.login(process.env.DISCORD_BOT_TOKEN);
