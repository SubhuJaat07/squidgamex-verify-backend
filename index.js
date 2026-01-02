const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Routes, REST, SlashCommandBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, AuditLogEvent } = require("discord.js");
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
            const now = new Date();
            if (data.verified && new Date(data.expires_at) > now) return res.json({ status: "VALID" });
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
    new SlashCommandBuilder().setName("bansystem").setDescription("Ban Manage")
        .addSubcommand(s=>s.setName("ban").setDescription("Ban").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")))
        .addSubcommand(s=>s.setName("unban").setDescription("Unban").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")))
        .addSubcommand(s=>s.setName("list").setDescription("List")),
    
    new SlashCommandBuilder().setName("whitelist").setDescription("Anti-Ping Whitelist")
        .addSubcommand(s=>s.setName("add").setDescription("Add").addUserOption(o=>o.setName("user").setDescription("User")).addRoleOption(o=>o.setName("role").setDescription("Role")))
        .addSubcommand(s=>s.setName("list").setDescription("List")),

    // REWARDS & WELCOME
    new SlashCommandBuilder().setName("rewards").setDescription("Manage Rewards")
        .addSubcommand(s=>s.setName("add").setDescription("Add").addIntegerOption(o=>o.setName("invites").setRequired(true).setDescription("Invites")).addRoleOption(o=>o.setName("role").setRequired(true).setDescription("Role")))
        .addSubcommand(s=>s.setName("list").setDescription("List"))
        .addSubcommand(s=>s.setName("remove").setDescription("Remove").addIntegerOption(o=>o.setName("reward_id").setRequired(true).setDescription("ID"))),
        
    new SlashCommandBuilder().setName("welcome").setDescription("Welcome Settings")
        .addSubcommand(s=>s.setName("setchannel").setDescription("Set").addChannelOption(o=>o.setName("channel").setRequired(true).setDescription("Channel")))
        .addSubcommand(s=>s.setName("off").setDescription("Disable")),

    // POLLS
    new SlashCommandBuilder().setName("poll").setDescription("Create Poll")
        .addStringOption(o => o.setName("q").setRequired(true).setDescription("Question"))
        .addStringOption(o => o.setName("o1").setRequired(true).setDescription("Opt 1"))
        .addStringOption(o => o.setName("o2").setRequired(true).setDescription("Opt 2"))
        .addStringOption(o => o.setName("o3").setDescription("Opt 3"))
        .addStringOption(o => o.setName("o4").setDescription("Opt 4"))
        .addStringOption(o => o.setName("o5").setDescription("Opt 5"))
        .addRoleOption(o => o.setName("punish_role").setDescription("Role for non-voters"))
        .addBooleanOption(o => o.setName("multiple").setDescription("Multi Vote")),
    new SlashCommandBuilder().setName("endpoll").setDescription("End Poll").addIntegerOption(o => o.setName("pollid").setRequired(true).setDescription("ID")).addStringOption(o => o.setName("punish_duration").setDescription("e.g. 2d")),
    new SlashCommandBuilder().setName("pollresults").setDescription("Detailed Results").addIntegerOption(o => o.setName("pollid").setDescription("ID")),

    // CONFIG
    new SlashCommandBuilder().setName("config").setDescription("Settings")
        .addSubcommand(s=>s.setName("pingpunish").setDescription("Anti-Ping").addStringOption(o=>o.setName("type").setRequired(true).setDescription("Type").addChoices({name:'Role',value:'role'},{name:'Timeout',value:'timeout'})).addStringOption(o=>o.setName("value").setRequired(true).setDescription("RoleID or 1h"))),

    new SlashCommandBuilder().setName("rules").setDescription("Rule System")
        .addSubcommand(s => s.setName("set").setDescription("Set Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time")))
        .addSubcommand(s => s.setName("remove").setDescription("Remove Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")))
        .addSubcommand(s => s.setName("list").setDescription("List Rules")),

    new SlashCommandBuilder().setName("syncmissing").setDescription("Admin: Sync DB"),
    new SlashCommandBuilder().setName("leaderboard").setDescription("Invite Leaderboard"),
    new SlashCommandBuilder().setName("lookup").setDescription("Admin: Lookup").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")),
    new SlashCommandBuilder().setName("setexpiry").setDescription("Admin: Add Time").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")).addStringOption(o=>o.setName("duration").setRequired(true).setDescription("Time")).addStringOption(o=>o.setName("note").setDescription("Note"))

].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

// 🔥 INTERACTION
client.on("interactionCreate", async interaction => {
    try {
        if (interaction.customId?.startsWith('sync_')) { await handleBatchSync(interaction); return; }
        if (interaction.customId?.startsWith('active_')) {
            const page = parseInt(interaction.customId.split('_')[2]);
            await handleActiveUsers(interaction, page);
            return;
        }

        // 🔥 POLL VOTE LOGIC
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

            const { count } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId);
            const embed = EmbedBuilder.from(interaction.message.embeds[0]).setFooter({ text: `Squid Game X • Live Total Votes: ${count}` });
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
        if (interaction.commandName === "rules") await handleRules(interaction);
        if (interaction.commandName === "syncmissing") { await interaction.deferReply({ ephemeral: true }); await showBatchSync(interaction); }
        if (interaction.commandName === "leaderboard") await handleLeaderboard(interaction);
        if (interaction.commandName === "lookup") await handleLookup(interaction);

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

        if (interaction.commandName === "pollresults") {
            await interaction.deferReply();
            const pid = interaction.options.getInteger("pollid");
            const { data: poll } = await supabase.from("polls").select("*").eq("id", pid).maybeSingle();
            if(!poll) return interaction.editReply("❌ Not Found");
            
            const { data: votes } = await supabase.from("poll_votes").select("user_id, choice").eq("poll_id", pid);
            let desc = `**Q: ${poll.question}**\n\n`;
            
            [poll.option1, poll.option2, poll.option3, poll.option4, poll.option5].filter(o=>o).forEach((opt, i) => {
                const idx = i+1;
                const vList = votes.filter(v=>v.choice===idx);
                desc += `**${idx}. ${opt} (${vList.length}):**\n${vList.map(v=>`<@${v.user_id}>`).join(", ") || "None"}\n\n`;
            });
            return interaction.editReply({ embeds: [createEmbed(`📊 Detailed Results #${pid}`, desc, SETTINGS.COLOR_INFO)] });
        }

        // CONFIG
        if (interaction.commandName === "config") {
            const sub = interaction.options.getSubcommand();
            if (sub === "pingpunish") {
                const type = interaction.options.getString("type");
                const val = interaction.options.getString("value");
                if (type === 'role') await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_punish_role: val });
                else await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_timeout_ms: parseDuration(val) });
                return interaction.reply("✅ Updated");
            }
        }
        
        // SET EXPIRY
        if (interaction.commandName === "setexpiry") {
            if(!await isAdmin(interaction.user.id)) return interaction.reply("❌ Admin Only");
            await interaction.deferReply();
            const ms = parseDuration(interaction.options.getString("duration"));
            const target = interaction.options.getString("target");
            const note = interaction.options.getString("note") || null;
            const expiry = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString();
            
            await supabase.from("verifications").update({ verified: true, expires_at: expiry, note: note }).or(`code.eq.${target},hwid.eq.${target}`);
            return interaction.editReply(`✅ Updated ${target} (Note: ${note})`);
        }

    } catch (e) { console.error(e); }
});

// 🔥 ANTI-PING SYSTEM
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    
    if (message.mentions.users.has(SETTINGS.SUPER_OWNER_ID) && message.author.id !== SETTINGS.SUPER_OWNER_ID && !message.reference) {
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", message.guild.id).maybeSingle();
        const whitelist = config?.ping_whitelist || [];
        
        if (whitelist.includes(message.author.id) || message.member.roles.cache.some(r => whitelist.includes(r.id))) return;

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

    if (message.content.toLowerCase().startsWith("verify ")) {
        if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID || await isAdmin(message.author.id)) {
            await processVerification(message.author, message.content.split(" ")[1], message.guild, (opts) => message.reply(opts));
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
