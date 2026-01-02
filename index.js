const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Routes, REST, SlashCommandBuilder, AuditLogEvent, PermissionsBitField } = require("discord.js");
const { SETTINGS, supabase, isAdmin, createEmbed, safeReply, parseDuration } = require("./config");
const { processVerification, handleGetRobloxId, handleLinkRoblox, handleBanSystem, handleRules } = require("./verification");
const { showBatchSync, handleBatchSync, trackJoin } = require("./invite");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ API (HWID CHECK)
app.get("/", (req, res) => res.send("System Online 🟢"));
app.get("/check", async (req, res) => {
    if (SETTINGS.MAINTENANCE) return res.json({ status: "ERROR", message: "Maintenance" });
    const { hwid } = req.query;
    if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });
    const { data } = await supabase.from("verifications").select("*").eq("hwid", hwid).maybeSingle();
    if (data) {
        if (data.is_banned) return res.json({ status: "BANNED" });
        if (data.verified && new Date(data.expires_at) > new Date()) return res.json({ status: "VALID" });
        return res.json({ status: "NEED_VERIFY", code: data.code });
    }
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await supabase.from("verifications").insert([{ hwid, code, verified: false, is_banned: false }]);
    return res.json({ status: "NEED_VERIFY", code });
});
app.listen(SETTINGS.PORT, () => console.log(`🚀 API Port: ${SETTINGS.PORT}`));

const client = new Client({
    intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildModeration ],
    partials: [Partials.GuildMember, Partials.Channel]
});

// COMMANDS REGISTRATION
const commands = [
    new SlashCommandBuilder().setName("verify").setDescription("Verify").addStringOption(o=>o.setName("code").setRequired(true).setDescription("Code")),
    new SlashCommandBuilder().setName("getid").setDescription("Get Roblox ID").addStringOption(o=>o.setName("username").setRequired(true).setDescription("Username")),
    new SlashCommandBuilder().setName("linkroblox").setDescription("Link ID").addStringOption(o=>o.setName("roblox_id").setRequired(true).setDescription("ID")),
    new SlashCommandBuilder().setName("activeusers").setDescription("See active users"),
    new SlashCommandBuilder().setName("syncmissing").setDescription("Admin: Sync DB"),
    new SlashCommandBuilder().setName("whoinvited").setDescription("Who invited user").addUserOption(o=>o.setName("user").setRequired(true).setDescription("User")),
    new SlashCommandBuilder().setName("config").setDescription("Super Admin Setup").addSubcommand(s=>s.setName("setpunish").setDescription("Ping Timeout").addStringOption(o=>o.setName("duration").setRequired(true).setDescription("10m"))),
    
    // ADMIN TOOLS
    new SlashCommandBuilder().setName("admin").setDescription("Admin Tools")
        .addSubcommand(s => s.setName("say").setDescription("Bot Says").addStringOption(o => o.setName("msg").setRequired(true).setDescription("Message")))
        .addSubcommand(s => s.setName("announce").setDescription("Announcement").addStringOption(o => o.setName("title").setRequired(true).setDescription("Title")).addStringOption(o => o.setName("msg").setRequired(true).setDescription("Msg")).addStringOption(o => o.setName("img").setDescription("Image URL")))
        .addSubcommand(s => s.setName("poll").setDescription("Start Poll").addStringOption(o => o.setName("q").setRequired(true).setDescription("Q")).addStringOption(o => o.setName("o1").setRequired(true).setDescription("1")).addStringOption(o => o.setName("o2").setRequired(true).setDescription("2")))
        .addSubcommand(s => s.setName("pollresults").setDescription("Results").addIntegerOption(o => o.setName("pollid").setDescription("ID")))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

    // BAN SYSTEM
    new SlashCommandBuilder().setName("bansystem").setDescription("Manage Bans")
        .addSubcommand(s => s.setName("ban").setDescription("Ban HWID/Code").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")))
        .addSubcommand(s => s.setName("unban").setDescription("Unban").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")))
        .addSubcommand(s => s.setName("list").setDescription("List Bans"))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

    // RULE SYSTEM
    new SlashCommandBuilder().setName("rules").setDescription("Verify Rules")
        .addSubcommand(s => s.setName("set").setDescription("Set Role Time").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("1d, 1h")))
        .addSubcommand(s => s.setName("list").setDescription("List Rules"))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)

].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

// 🔥 ANTI-PING & TEXT VERIFY
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    
    // Anti-Ping
    if (message.mentions.users.has(SETTINGS.SUPER_OWNER_ID) && message.author.id !== SETTINGS.SUPER_OWNER_ID) {
        if (!message.reference) {
            try {
                const { data: config } = await supabase.from("guild_config").select("ping_timeout_ms").eq("guild_id", message.guild.id).maybeSingle();
                const duration = config ? config.ping_timeout_ms : SETTINGS.DEFAULT_PUNISH_MS;
                if (message.member.moderatable) await message.member.timeout(duration, "Pinging Owner"); 
                const m = await message.reply(`⚠️ Don't ping Owner! (${duration/60000}m Timeout)`);
                setTimeout(()=>m.delete(), 8000);
            } catch (e) {}
        }
    }

    // Verify Text Command
    if (message.content.toLowerCase().startsWith("verify ")) {
        const code = message.content.split(" ")[1];
        if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID || await isAdmin(message.author.id)) {
            await processVerification(message.author, code, message.guild, (opts) => message.reply(opts));
        }
    }
});

// HANDLERS
client.on("interactionCreate", async interaction => {
    try {
        if (interaction.customId?.startsWith('sync_')) { await handleBatchSync(interaction); return; }
        
        if (!interaction.isChatInputCommand()) return;

        // Command Routing
        if (interaction.commandName === "getid") await handleGetRobloxId(interaction);
        if (interaction.commandName === "linkroblox") await handleLinkRoblox(interaction);
        if (interaction.commandName === "verify") {
            await interaction.deferReply();
            await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (opts) => interaction.editReply(opts));
        }
        if (interaction.commandName === "bansystem") await handleBanSystem(interaction);
        if (interaction.commandName === "rules") await handleRules(interaction);
        if (interaction.commandName === "syncmissing") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin", ephemeral: true });
            await interaction.deferReply();
            await showBatchSync(interaction);
        }
        
        // ADMIN SAY/ANNOUNCE/POLL
        if (interaction.commandName === "admin") {
            const sub = interaction.options.getSubcommand();
            if (sub === "say") {
                await interaction.channel.send(interaction.options.getString("msg"));
                return interaction.reply({content:"✅ Sent", ephemeral:true});
            }
            if (sub === "announce") {
                const embed = createEmbed(interaction.options.getString("title"), interaction.options.getString("msg"), 0xFFD700);
                if(interaction.options.getString("img")) embed.setImage(interaction.options.getString("img"));
                await interaction.channel.send({embeds:[embed]});
                return interaction.reply({content:"✅ Announced", ephemeral:true});
            }
            // Poll Logic reused from previous stable version
            if (sub === "pollresults") {
                await interaction.deferReply();
                let pid = interaction.options.getInteger("pollid");
                if(!pid) { const {data} = await supabase.from("polls").select("id").order('created_at',{ascending:false}).limit(1).maybeSingle(); if(data) pid=data.id; }
                const {data:votes} = await supabase.from("poll_votes").select("user_id, choice").eq("poll_id", pid);
                if(!votes) return interaction.editReply("No Data");
                const o1 = votes.filter(v=>v.choice===1).map(v=>`<@${v.user_id}>`).join(", ")||"None";
                const o2 = votes.filter(v=>v.choice===2).map(v=>`<@${v.user_id}>`).join(", ")||"None";
                return interaction.editReply({embeds:[createEmbed(`📊 Poll #${pid}`, `**Opt 1:**\n${o1}\n\n**Opt 2:**\n${o2}`)]});
            }
        }

    } catch (e) { console.error(e); }
});

client.on("guildMemberAdd", trackJoin);
client.login(process.env.DISCORD_BOT_TOKEN);
