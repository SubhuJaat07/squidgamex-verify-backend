const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Routes, REST, SlashCommandBuilder, AuditLogEvent, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { SETTINGS, supabase, isAdmin, createEmbed, safeReply, parseDuration } = require("./config");
const { processVerification, handleGetRobloxId, handleLinkRoblox, handleBanSystem, handleRules, handleLookup, handleCheckAlts, handleSetExpiry } = require("./verification");
const { showBatchSync, handleBatchSync, trackJoin } = require("./invite");

const app = express();
app.use(cors());
app.use(express.json());

// ✅ API (FIXED NO-CODE-RESET)
app.get("/", (req, res) => res.send("System Online 🟢"));
app.get("/check", async (req, res) => {
    if (SETTINGS.MAINTENANCE) return res.json({ status: "ERROR", message: "Maintenance" });
    const { hwid } = req.query;
    if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });
    try {
        const { data } = await supabase.from("verifications").select("*").eq("hwid", hwid).maybeSingle();
        if (data) {
            if (data.is_banned) return res.json({ status: "BANNED" });
            const now = new Date();
            const expiry = new Date(data.expires_at);
            if (data.verified && expiry > now) return res.json({ status: "VALID" });
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

// COMMANDS REGISTRATION
const commands = [
    new SlashCommandBuilder().setName("verify").setDescription("Verify Script").addStringOption(o=>o.setName("code").setRequired(true).setDescription("Code")),
    new SlashCommandBuilder().setName("getid").setDescription("Get Roblox ID").addStringOption(o=>o.setName("username").setRequired(true).setDescription("Username")),
    new SlashCommandBuilder().setName("linkroblox").setDescription("Link ID").addStringOption(o=>o.setName("roblox_id").setRequired(true).setDescription("ID")),
    new SlashCommandBuilder().setName("activeusers").setDescription("Active Users List"),
    new SlashCommandBuilder().setName("syncmissing").setDescription("Admin: Sync DB (Batch)"),
    new SlashCommandBuilder().setName("whoinvited").setDescription("Check inviter").addUserOption(o=>o.setName("user").setRequired(true).setDescription("User")),
    new SlashCommandBuilder().setName("lookup").setDescription("Admin: Lookup").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")),
    new SlashCommandBuilder().setName("checkalts").setDescription("Admin: Check Alts"),
    new SlashCommandBuilder().setName("setexpiry").setDescription("Admin: Add Time").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")).addStringOption(o=>o.setName("duration").setRequired(true).setDescription("1d, 1h")),
    new SlashCommandBuilder().setName("config").setDescription("Super Admin").addSubcommand(s=>s.setName("setpunish").setDescription("Ping Timeout").addStringOption(o=>o.setName("duration").setRequired(true).setDescription("10m"))),
    
    // ADMIN
    new SlashCommandBuilder().setName("admin").setDescription("Tools")
        .addSubcommand(s => s.setName("say").setDescription("Bot Says").addStringOption(o => o.setName("msg").setRequired(true).setDescription("Message")))
        .addSubcommand(s => s.setName("announce").setDescription("Announce").addStringOption(o => o.setName("title").setRequired(true).setDescription("Title")).addStringOption(o => o.setName("msg").setRequired(true).setDescription("Msg")).addStringOption(o => o.setName("img").setDescription("Image URL")))
        .addSubcommand(s => s.setName("poll").setDescription("Poll").addStringOption(o => o.setName("q").setRequired(true).setDescription("Q")).addStringOption(o => o.setName("o1").setRequired(true).setDescription("1")).addStringOption(o => o.setName("o2").setRequired(true).setDescription("2")).addStringOption(o => o.setName("o3").setDescription("3")).addStringOption(o => o.setName("o4").setDescription("4")))
        .addSubcommand(s => s.setName("pollresults").setDescription("Results").addIntegerOption(o => o.setName("pollid").setDescription("ID")))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

    // BAN
    new SlashCommandBuilder().setName("bansystem").setDescription("Ban System")
        .addSubcommand(s => s.setName("ban").setDescription("Ban").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")))
        .addSubcommand(s => s.setName("unban").setDescription("Unban").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")))
        .addSubcommand(s => s.setName("list").setDescription("List Bans"))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),

    // RULES
    new SlashCommandBuilder().setName("rules").setDescription("Rule System")
        .addSubcommand(s => s.setName("set").setDescription("Set Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("1d")))
        .addSubcommand(s => s.setName("list").setDescription("List Rules"))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

// 🔥 MESSAGE & ANTI-PING
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    
    if (message.mentions.users.has(SETTINGS.SUPER_OWNER_ID) && message.author.id !== SETTINGS.SUPER_OWNER_ID && !message.reference) {
        try {
            const { data: config } = await supabase.from("guild_config").select("ping_timeout_ms").eq("guild_id", message.guild.id).maybeSingle();
            const duration = config ? config.ping_timeout_ms : SETTINGS.DEFAULT_PUNISH_MS;
            if (message.member.moderatable) {
                await message.member.timeout(duration, "Pinging Owner"); 
                message.reply(`⚠️ **No Pinging Owner!** (${duration/60000}m Timeout)`).then(m=>setTimeout(()=>m.delete(),8000));
            }
        } catch (e) {}
    }

    if (message.content.toLowerCase().startsWith("verify ")) {
        const code = message.content.split(" ")[1];
        if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID || await isAdmin(message.author.id)) {
            await processVerification(message.author, code, message.guild, (opts) => message.reply(opts));
        }
    }
});

// 🔥 ANTI-UNPUNISH
client.on(AuditLogEvent.MemberUpdate, async (entry, guild) => {
    const change = entry.changes.find(c => c.key === 'communication_disabled_until' && c.old && !c.new);
    if (!change || entry.executorId === SETTINGS.SUPER_OWNER_ID || entry.executorId === client.user.id) return;
    try {
        const executor = await guild.members.fetch(entry.executorId);
        if (executor.moderatable) await executor.timeout(10 * 60 * 1000, "Unauthorised Timeout Removal");
        const target = await guild.members.fetch(entry.targetId);
        if (target.moderatable) await target.timeout(5 * 60 * 1000, "Timeout Re-applied");
    } catch (e) {}
});

// HANDLERS
client.on("interactionCreate", async interaction => {
    try {
        if (interaction.customId?.startsWith('sync_')) { await handleBatchSync(interaction); return; }
        // Poll Buttons
        if (interaction.isButton() && interaction.customId.startsWith('vote_')) {
            const [_, pid, ch] = interaction.customId.split('_');
            await interaction.deferReply({ ephemeral: true });
            await supabase.from("poll_votes").upsert({ poll_id: parseInt(pid), user_id: interaction.user.id, choice: parseInt(ch) });
            return interaction.editReply("✅ Voted!");
        }
        if (interaction.isButton() && interaction.customId.startsWith('copy_')) {
            await interaction.deferReply({ ephemeral: true });
            const { data } = await supabase.from("verifications").select("*").eq("code", interaction.customId.split('_')[1]).maybeSingle();
            return data ? interaction.editReply(`Code: \`${data.code}\`\nHWID: \`${data.hwid}\``) : interaction.editReply("❌ Not Found");
        }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === "getid") await handleGetRobloxId(interaction);
        if (interaction.commandName === "linkroblox") await handleLinkRoblox(interaction);
        if (interaction.commandName === "verify") {
            await interaction.deferReply();
            await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (opts) => interaction.editReply(opts));
        }
        if (interaction.commandName === "bansystem") await handleBanSystem(interaction);
        if (interaction.commandName === "rules") await handleRules(interaction);
        if (interaction.commandName === "lookup") await handleLookup(interaction);
        if (interaction.commandName === "checkalts") await handleCheckAlts(interaction);
        if (interaction.commandName === "setexpiry") await handleSetExpiry(interaction);
        if (interaction.commandName === "syncmissing") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin", ephemeral: true });
            await interaction.deferReply();
            await showBatchSync(interaction);
        }
        
        // ADMIN SAY/ANNOUNCE/POLL
        if (interaction.commandName === "admin") {
            const sub = interaction.options.getSubcommand();
            if (sub === "say") { await interaction.channel.send(interaction.options.getString("msg")); return interaction.reply({content:"✅", ephemeral:true}); }
            if (sub === "announce") {
                const embed = createEmbed(interaction.options.getString("title"), interaction.options.getString("msg"), 0xFFD700);
                if(interaction.options.getString("img")) embed.setImage(interaction.options.getString("img"));
                await interaction.channel.send({embeds:[embed]});
                return interaction.reply({content:"✅", ephemeral:true});
            }
            if (sub === "poll") {
                const q = interaction.options.getString("q");
                const opts = [1,2,3,4,5].map(i => interaction.options.getString(`o${i}`)).filter(o=>o);
                const {data} = await supabase.from("polls").insert({ question: q, option1: opts[0], option2: opts[1]||"", is_active: true }).select().single();
                const embed = createEmbed(`📊 Poll #${data.id}`, `**${q}**\n`+opts.map((o,i)=>`${i+1}️⃣ ${o}`).join('\n'), 0xFFA500);
                const row = new ActionRowBuilder().addComponents(opts.map((_,i)=>new ButtonBuilder().setCustomId(`vote_${data.id}_${i+1}`).setLabel(`${i+1}`).setStyle(ButtonStyle.Primary)));
                await interaction.channel.send({ content: "@everyone", embeds: [embed], components: [row] });
                return interaction.reply({content:"✅ Started", ephemeral:true});
            }
            if (sub === "pollresults") {
                await interaction.deferReply();
                let pid = interaction.options.getInteger("pollid");
                if(!pid) { const {data}=await supabase.from("polls").select("id").order('created_at',{ascending:false}).limit(1).maybeSingle(); if(data) pid=data.id; }
                const {data:poll}=await supabase.from("polls").select("*").eq("id", pid).maybeSingle();
                const {data:votes}=await supabase.from("poll_votes").select("user_id, choice").eq("poll_id", pid);
                if(!poll) return interaction.editReply("❌ Not Found");
                let desc = `**Q: ${poll.question}**\n\n`;
                for(let i=1; i<=5; i++) {
                    const v = votes.filter(x=>x.choice===i).map(x=>`<@${x.user_id}>`).join(", ");
                    if(v) desc += `**Option ${i}:** ${v}\n`;
                }
                return interaction.editReply({embeds:[createEmbed(`📊 Results #${pid}`, desc, 0x00FFFF)]});
            }
        }
        if (interaction.commandName === "config" && interaction.options.getSubcommand() === "setpunish") {
            if (interaction.user.id !== SETTINGS.SUPER_OWNER_ID) return interaction.reply({content: "❌ Owner Only", ephemeral: true});
            const ms = parseDuration(interaction.options.getString("duration"));
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_timeout_ms: ms });
            return interaction.reply("✅ Updated");
        }

    } catch (e) { console.error(e); }
});

client.on("guildMemberAdd", trackJoin);
client.login(process.env.DISCORD_BOT_TOKEN);
