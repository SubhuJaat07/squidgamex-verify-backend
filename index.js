const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Routes, REST, SlashCommandBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { SETTINGS, supabase, isAdmin, createEmbed, safeReply, parseDuration, logToWebhook } = require("./config");
const { processVerification, handleGetRobloxId, handleLinkRoblox, handleActiveUsers, handleSetCode, handleBanSystem } = require("./verification");
const { handleWhitelist, handleWelcome, handleRewards, trackJoin } = require("./invite");

const app = express();
app.use(cors());
app.use(express.json());

// API
app.get("/", (req, res) => res.send("System Online 🟢"));
app.get("/check", async (req, res) => {
    if (SETTINGS.MAINTENANCE) return res.json({ status: "ERROR" });
    const { hwid } = req.query;
    if (!hwid) return res.json({ status: "ERROR" });
    try {
        const { data } = await supabase.from("verifications").select("*").eq("hwid", hwid).maybeSingle();
        if (data) {
            if (data.is_banned) return res.json({ status: "BANNED" });
            if (data.verified && new Date(data.expires_at) > new Date()) return res.json({ status: "VALID" });
            return res.json({ status: "NEED_VERIFY", code: data.code });
        }
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await supabase.from("verifications").insert([{ hwid, code, verified: false, is_banned: false }]);
        return res.json({ status: "NEED_VERIFY", code });
    } catch (e) { return res.json({ status: "ERROR" }); }
});
app.listen(SETTINGS.PORT, () => console.log(`🚀 API Port: ${SETTINGS.PORT}`));

const client = new Client({
    intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildModeration ],
    partials: [Partials.GuildMember, Partials.Channel]
});

// COMMANDS
const commands = [
    new SlashCommandBuilder().setName("verify").setDescription("Verify").addStringOption(o=>o.setName("code").setRequired(true).setDescription("Code")),
    new SlashCommandBuilder().setName("getid").setDescription("Get Roblox ID").addStringOption(o=>o.setName("username").setRequired(true).setDescription("User")),
    new SlashCommandBuilder().setName("linkroblox").setDescription("Link ID").addStringOption(o=>o.setName("roblox_id").setRequired(true).setDescription("ID")),
    new SlashCommandBuilder().setName("activeusers").setDescription("Active List"),
    new SlashCommandBuilder().setName("setcode").setDescription("Admin: Custom Code").addUserOption(o=>o.setName("user").setRequired(true).setDescription("User")).addStringOption(o=>o.setName("code").setRequired(true).setDescription("Code")),
    
    // BAN & WHITELIST
    new SlashCommandBuilder().setName("bansystem").setDescription("Ban Manage").addSubcommand(s=>s.setName("ban").setDescription("Ban").addStringOption(o=>o.setName("target").setRequired(true))).addSubcommand(s=>s.setName("unban").setDescription("Unban").addStringOption(o=>o.setName("target").setRequired(true))).addSubcommand(s=>s.setName("list").setDescription("List")),
    new SlashCommandBuilder().setName("whitelist").setDescription("Anti-Ping Whitelist").addSubcommand(s=>s.setName("add").setDescription("Add").addUserOption(o=>o.setName("user").setDescription("User")).addRoleOption(o=>o.setName("role").setDescription("Role"))).addSubcommand(s=>s.setName("list").setDescription("List")),

    // REWARDS & WELCOME
    new SlashCommandBuilder().setName("rewards").setDescription("Manage Rewards").addSubcommand(s=>s.setName("add").setDescription("Add").addIntegerOption(o=>o.setName("invites").setRequired(true)).addRoleOption(o=>o.setName("role").setRequired(true))).addSubcommand(s=>s.setName("list").setDescription("List")),
    new SlashCommandBuilder().setName("welcome").setDescription("Welcome Settings").addSubcommand(s=>s.setName("setchannel").setDescription("Set").addChannelOption(o=>o.setName("channel").setRequired(true))).addSubcommand(s=>s.setName("off").setDescription("Disable")),

    // POLLS
    new SlashCommandBuilder().setName("poll").setDescription("Create Poll")
        .addStringOption(o => o.setName("q").setRequired(true).setDescription("Question"))
        .addStringOption(o => o.setName("o1").setRequired(true).setDescription("Opt 1"))
        .addStringOption(o => o.setName("o2").setRequired(true).setDescription("Opt 2"))
        .addRoleOption(o => o.setName("punish_role").setDescription("Role for non-voters"))
        .addBooleanOption(o => o.setName("multiple").setDescription("Multi Vote")),
    new SlashCommandBuilder().setName("endpoll").setDescription("End Poll").addIntegerOption(o => o.setName("pollid").setRequired(true).setDescription("ID")).addStringOption(o => o.setName("punish_duration").setDescription("e.g. 2d")),
    
    // CONFIG
    new SlashCommandBuilder().setName("config").setDescription("Settings").addSubcommand(s=>s.setName("pingpunish").setDescription("Anti-Ping").addStringOption(o=>o.setName("type").setRequired(true).addChoices({name:'Role',value:'role'},{name:'Timeout',value:'timeout'})).addStringOption(o=>o.setName("value").setRequired(true).setDescription("RoleID or 1h")))

].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

// 🔥 INTERACTION
client.on("interactionCreate", async interaction => {
    try {
        if (interaction.isButton() && interaction.customId.startsWith('vote_')) {
            const [_, pid, ch] = interaction.customId.split('_');
            const pollId = parseInt(pid);
            await interaction.deferReply({ ephemeral: true });

            const { data: poll } = await supabase.from("polls").select("*").eq("id", pollId).single();
            if (!poll.is_active) return interaction.editReply("❌ Poll Ended!");

            // Multi Vote Logic
            if (!poll.allow_multiple) {
                await supabase.from("poll_votes").delete().eq("poll_id", pollId).eq("user_id", interaction.user.id);
            }
            await supabase.from("poll_votes").upsert({ poll_id: pollId, user_id: interaction.user.id, choice: parseInt(ch) });

            // Live Count
            const { count } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId);
            const embed = EmbedBuilder.from(interaction.message.embeds[0]).setFooter({ text: `Live Votes: ${count}` });
            await interaction.message.edit({ embeds: [embed] });

            return interaction.editReply("✅ Vote Recorded!");
        }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === "verify") {
            await interaction.deferReply();
            await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (opts) => interaction.editReply(opts));
        }
        if (interaction.commandName === "activeusers") await handleActiveUsers(interaction, 1);
        if (interaction.commandName === "setcode") await handleSetCode(interaction);
        if (interaction.commandName === "bansystem") await handleBanSystem(interaction);
        if (interaction.commandName === "whitelist") await handleWhitelist(interaction);
        if (interaction.commandName === "welcome") await handleWelcome(interaction);
        if (interaction.commandName === "rewards") await handleRewards(interaction);
        if (interaction.commandName === "getid") await handleGetRobloxId(interaction);
        if (interaction.commandName === "linkroblox") await handleLinkRoblox(interaction);

        // POLL END
        if (interaction.commandName === "endpoll") {
            await interaction.deferReply();
            const pid = interaction.options.getInteger("pollid");
            const duration = interaction.options.getString("punish_duration") || "1d";
            
            await supabase.from("polls").update({ is_active: false }).eq("id", pid);
            const { data: poll } = await supabase.from("polls").select("*").eq("id", pid).single();
            const { data: votes } = await supabase.from("poll_votes").select("user_id").eq("poll_id", pid);
            const voters = new Set(votes.map(v => v.user_id));
            
            let count = 0;
            if (poll.punish_role_id) {
                const role = interaction.guild.roles.cache.get(poll.punish_role_id);
                const members = await interaction.guild.members.fetch();
                
                // Punish Loop
                for (const [id, m] of members) {
                    if (!m.user.bot && !voters.has(id)) {
                        await m.roles.add(role).catch(()=>{});
                        try {
                            const dm = createEmbed("⚠️ Poll Punishment", `You missed Poll #${pid}!\n**Role:** ${role.name}\n**Duration:** ${duration}\n[View Poll](https://discord.com/channels/${SETTINGS.GUILD_ID}/${poll.channel_id})`, SETTINGS.COLOR_ERROR);
                            await m.send({ embeds: [dm] });
                        } catch(e){}
                        count++;
                    }
                }
            }
            return interaction.editReply({ embeds: [createEmbed(`🛑 Poll #${pid} Ended`, `**Votes:** ${voters.size}\n**Punished:** ${count} users\n**Duration:** ${duration}`, SETTINGS.COLOR_WARN)] });
        }

        // CONFIG
        if (interaction.commandName === "config") {
            const sub = interaction.options.getSubcommand();
            if (sub === "pingpunish") {
                const type = interaction.options.getString("type");
                const val = interaction.options.getString("value");
                if (type === 'role') await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_punish_role: val });
                else await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_timeout_ms: parseDuration(val) }); // Store as text if preferred, but parse check is good
                return interaction.reply("✅ Updated");
            }
        }

    } catch (e) { console.error(e); }
});

// 🔥 ANTI-PING SYSTEM
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    
    if (message.mentions.users.has(SETTINGS.SUPER_OWNER_ID) && message.author.id !== SETTINGS.SUPER_OWNER_ID && !message.reference) {
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", message.guild.id).maybeSingle();
        const whitelist = config?.ping_whitelist || [];
        
        // Whitelist Check
        if (whitelist.includes(message.author.id) || message.member.roles.cache.some(r => whitelist.includes(r.id))) return;

        // Punish (Role or Timeout)
        if (message.member.moderatable) {
            if (config?.ping_punish_role) {
                await message.member.roles.add(config.ping_punish_role).catch(()=>{});
                message.reply("⚠️ **Don't ping Owner!** (Role Penalty)");
            } else {
                await message.member.timeout(SETTINGS.DEFAULT_PUNISH_MS, "Anti-Ping");
                message.reply("⚠️ **Don't ping Owner!** (Timeout)");
            }
        }
    }

    // Verify Text Command
    if (message.content.toLowerCase().startsWith("verify ")) {
        if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID || await isAdmin(message.author.id)) {
            await processVerification(message.author, message.content.split(" ")[1], message.guild, (opts) => message.reply(opts));
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
