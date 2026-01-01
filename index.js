const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Collection, Routes, REST, SlashCommandBuilder, AuditLogEvent, PermissionsBitField } = require("discord.js");
const { SETTINGS, supabase, isAdmin, createEmbed, safeReply, parseDuration } = require("./config");
const { processVerification, handleGetRobloxId, handleLinkRoblox } = require("./verification");
const { showBatchSync, handleBatchSync, trackJoin } = require("./invite");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("System Online 🟢"));
app.listen(SETTINGS.PORT, () => console.log(`🚀 Port: ${SETTINGS.PORT}`));

const client = new Client({
    intents: [ 
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent, 
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.GuildModeration 
    ],
    partials: [Partials.GuildMember, Partials.Channel]
});

// COMMANDS
const commands = [
    new SlashCommandBuilder().setName("verify").setDescription("Verify").addStringOption(o=>o.setName("code").setRequired(true).setDescription("Code")),
    new SlashCommandBuilder().setName("getid").setDescription("Get Roblox ID").addStringOption(o=>o.setName("username").setRequired(true).setDescription("Roblox Username")),
    new SlashCommandBuilder().setName("linkroblox").setDescription("Link Roblox ID").addStringOption(o=>o.setName("roblox_id").setRequired(true).setDescription("Roblox ID")),
    new SlashCommandBuilder().setName("lookup").setDescription("Admin: Lookup").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")),
    new SlashCommandBuilder().setName("syncmissing").setDescription("Admin: Manual Sync (Batch)"),
    new SlashCommandBuilder().setName("checkalts").setDescription("Admin: Check Alts"),
    new SlashCommandBuilder().setName("activeusers").setDescription("Active Users"),
    new SlashCommandBuilder().setName("whoinvited").setDescription("Who Invited").addUserOption(o=>o.setName("user").setRequired(true).setDescription("User")),
    new SlashCommandBuilder().setName("admin").setDescription("Admin Tools")
        .addSubcommand(s => s.setName("poll").setDescription("Start Poll").addStringOption(o => o.setName("question").setRequired(true).setDescription("Q")).addStringOption(o => o.setName("option1").setRequired(true).setDescription("1")).addStringOption(o => o.setName("option2").setRequired(true).setDescription("2")))
        .addSubcommand(s => s.setName("pollresults").setDescription("Poll Results (With Names)").addIntegerOption(o => o.setName("pollid").setDescription("Poll ID")))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator),
    new SlashCommandBuilder().setName("config").setDescription("Super Admin Setup")
        .addSubcommand(s=>s.setName("setpunish").setDescription("Set Ping Timeout").addStringOption(o=>o.setName("duration").setRequired(true).setDescription("e.g. 10m, 1h")))
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

// 🔥 ANTI-PING & VERIFY TEXT COMMAND
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    
    // 1. Anti-Ping (Super Owner Protection)
    if (message.mentions.users.has(SETTINGS.SUPER_OWNER_ID) && message.author.id !== SETTINGS.SUPER_OWNER_ID) {
        if (message.reference) return; 
        try {
            const { data: config } = await supabase.from("guild_config").select("ping_timeout_ms").eq("guild_id", message.guild.id).maybeSingle();
            const duration = config ? config.ping_timeout_ms : SETTINGS.DEFAULT_PUNISH_MS;

            if (message.member && message.member.moderatable) {
                await message.member.timeout(duration, "Pinging Owner"); 
                const warn = await message.reply(`⚠️ **Don't ping the Owner!** (${duration/60000}m Timeout)`);
                setTimeout(() => warn.delete().catch(()=>{}), 8000);
            }
        } catch (e) {}
    }

    // 2. Verify Text Command
    const args = message.content.trim().split(/\s+/);
    if (args[0].toLowerCase() === "verify") {
        if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID || await isAdmin(message.author.id)) {
            if (args.length < 2) { const r = await message.reply("❌ `verify 123456`"); setTimeout(() => r.delete().catch(()=>{}), 5000); return; }
            await processVerification(message.author, args[1], message.guild, (opts) => message.reply(opts));
        }
    }
});

// 🔥 PROTECTION: IF SOMEONE REMOVES TIMEOUT
client.on("guildAuditLogEntryCreate", async (entry, guild) => {
    if (entry.action !== AuditLogEvent.MemberUpdate) return;
    const change = entry.changes.find(c => c.key === 'communication_disabled_until' && c.old && !c.new);
    if (!change) return;

    if (entry.executorId === SETTINGS.SUPER_OWNER_ID || entry.executorId === client.user.id) return;

    try {
        const executor = await guild.members.fetch(entry.executorId);
        if (executor.moderatable) {
            await executor.timeout(10 * 60 * 1000, "Unauthorized Timeout Removal"); 
            const target = await guild.members.fetch(entry.targetId);
            if (target.moderatable) await target.timeout(5 * 60 * 1000, "Timeout Re-applied");
        }
    } catch (e) {}
});

// INTERACTION HANDLER
client.on("interactionCreate", async interaction => {
    try {
        if (interaction.customId?.startsWith('sync_')) { await handleBatchSync(interaction); return; }
        if (interaction.isButton() && interaction.customId.startsWith('copy_')) {
            await interaction.deferReply({ ephemeral: true });
            const [_, code] = interaction.customId.split('_');
            const { data } = await supabase.from("verifications").select("*").eq("code", code).maybeSingle();
            if(!data) return interaction.editReply("❌ Not Found");
            return interaction.editReply(`**Code:** \`${data.code}\`\n**HWID:** \`${data.hwid}\``);
        }

        if (!interaction.isChatInputCommand()) return;

        if (interaction.commandName === "getid") await handleGetRobloxId(interaction);
        if (interaction.commandName === "linkroblox") await handleLinkRoblox(interaction);
        if (interaction.commandName === "verify") {
            await interaction.deferReply();
            await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (opts) => interaction.editReply(opts));
        }
        
        // ADMIN: CONFIG PUNISHMENT
        if (interaction.commandName === "config" && interaction.options.getSubcommand() === "setpunish") {
            if (interaction.user.id !== SETTINGS.SUPER_OWNER_ID) return interaction.reply({content: "❌ Only Super Owner.", ephemeral: true});
            const ms = parseDuration(interaction.options.getString("duration"));
            if (!ms) return interaction.reply("❌ Invalid time");
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_timeout_ms: ms });
            return interaction.reply(`✅ Ping Punishment set to: ${interaction.options.getString("duration")}`);
        }

        // ADMIN: POLL RESULTS (WITH NAMES)
        if (interaction.commandName === "admin" && interaction.options.getSubcommand() === "pollresults") {
            await interaction.deferReply();
            let pollId = interaction.options.getInteger("pollid");
            if (!pollId) { const { data } = await supabase.from("polls").select("id").order('created_at', { ascending: false }).limit(1).maybeSingle(); if(data) pollId = data.id; }
            
            const { data: poll } = await supabase.from("polls").select("*").eq("id", pollId).maybeSingle();
            if(!poll) return interaction.editReply("❌ No Poll Found");

            const { data: votes } = await supabase.from("poll_votes").select("user_id, choice").eq("poll_id", pollId);
            const opt1 = votes.filter(v => v.choice === 1).map(v => `<@${v.user_id}>`).join(", ") || "None";
            const opt2 = votes.filter(v => v.choice === 2).map(v => `<@${v.user_id}>`).join(", ") || "None";

            return interaction.editReply({embeds: [createEmbed(`📊 Poll #${pollId} Details`, `**Q:** ${poll.question}\n\n**Option 1 (${poll.option1}):**\n${opt1.substring(0, 1000)}\n\n**Option 2 (${poll.option2}):**\n${opt2.substring(0, 1000)}`, 0xFFA500)]});
        }

        if (interaction.commandName === "syncmissing") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin", ephemeral: true });
            await interaction.deferReply({ ephemeral: true });
            await showBatchSync(interaction);
        }

    } catch (e) { console.error(e); }
});

client.on("guildMemberAdd", trackJoin);
client.login(process.env.DISCORD_BOT_TOKEN);
