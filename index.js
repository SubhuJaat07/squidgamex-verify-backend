const express = require("express");
const cors = require("cors");
const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    Routes, 
    REST, 
    SlashCommandBuilder, 
    EmbedBuilder 
} = require("discord.js");

const { 
    SETTINGS, 
    supabase, 
    isAdmin, 
    createEmbed, 
    parseDuration, 
    logToWebhook 
} = require("./config");

// =====================================================================
// 📦 MODULE IMPORTS
// =====================================================================
const { 
    processVerification, 
    handleVerifyCommand, 
    handleLinkButton, 
    handleLinkModal, 
    handleLinkConfirm,
    handleSetNote, 
    handleBanSystem, 
    handleLookup, 
    handleCheckAlts, 
    handleRules, 
    handleSetExpiry,
    handleKeyUpdate, 
    handleSetCode, 
    handleActiveUsers, 
    handleGetRobloxId, 
    handleLinkRoblox
} = require("./verification");

const { 
    handleWelcomeCommands, 
    handleRewards, 
    trackJoin, 
    trackLeave, 
    showBatchSync, 
    handleBatchSync, 
    handleLeaderboard, 
    handleInvites, 
    handleWhoInvited 
} = require("./invite");

const { 
    handlePollCreate, 
    handlePollVote, 
    handlePollEnd, 
    handlePollResults 
} = require("./poll");

// =====================================================================
// 🚨 GLOBAL ERROR LOGGING (WEBHOOK)
// =====================================================================
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection:', reason);
    logToWebhook("🚨 **Unhandled Rejection**", `\`\`\`js\n${reason.stack || reason}\n\`\`\``, SETTINGS.COLOR_ERROR);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    logToWebhook("🚨 **Uncaught Exception**", `\`\`\`js\n${error.stack}\n\`\`\``, SETTINGS.COLOR_ERROR);
});

// =====================================================================
// 🌐 EXPRESS API SERVER
// =====================================================================
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("System Online 🟢 | Status: Running"));

// Script Check Endpoint
app.get("/check", async (req, res) => {
    if (SETTINGS.MAINTENANCE) return res.json({ status: "ERROR", message: "Maintenance Mode" });
    
    // Accept extra params for Auto-Detect feature
    const { hwid, roblox_id, roblox_username } = req.query;
    
    if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });
    
    try {
        // Find user by HWID
        const { data } = await supabase.from("verifications").select("*").eq("hwid", hwid).maybeSingle();
        
        if (data) {
            // Update execution details if provided by script
            if (roblox_id) {
                await supabase.from("verifications").update({ 
                    executed_roblox_id: roblox_id, 
                    executed_roblox_username: roblox_username 
                }).eq("id", data.id);
            }

            // Check Status
            if (data.is_banned) return res.json({ status: "BANNED" });
            
            const now = new Date();
            const expiry = new Date(data.expires_at);
            
            if (data.verified && expiry > now) {
                // Access Granted
                return res.json({ status: "VALID", message: "Access Granted" });
            }
            
            // Key Expired or Not Verified
            return res.json({ status: "NEED_VERIFY", code: data.code });
        }
        
        // Register New User (First Time)
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        
        await supabase.from("verifications").insert([{ 
            hwid, 
            code, 
            verified: false, 
            is_banned: false,
            executed_roblox_id: roblox_id || null, 
            executed_roblox_username: roblox_username || null
        }]);
        
        logToWebhook("🆕 **New HWID Registered**", `HWID: \`${hwid}\`\nCode: \`${code}\``, SETTINGS.COLOR_INFO);
        
        return res.json({ status: "NEED_VERIFY", code });

    } catch (e) { 
        console.error(e);
        return res.json({ status: "ERROR" }); 
    }
});

app.listen(SETTINGS.PORT, () => console.log(`🚀 API Server Running on Port ${SETTINGS.PORT}`));

// =====================================================================
// 🤖 DISCORD CLIENT
// =====================================================================
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

// =====================================================================
// 📝 SLASH COMMANDS REGISTRY (Expanded & Readable)
// =====================================================================
const commands = [
    // --- Public Commands ---
    new SlashCommandBuilder()
        .setName("verify")
        .setDescription("Verify your key to access the script")
        .addStringOption(o => o.setName("code").setDescription("Enter your key code").setRequired(true)),

    new SlashCommandBuilder()
        .setName("invites")
        .setDescription("Check detailed invitation stats")
        .addUserOption(o => o.setName("user").setDescription("Target User")),

    new SlashCommandBuilder()
        .setName("whoinvited")
        .setDescription("See who invited a specific user")
        .addUserOption(o => o.setName("user").setDescription("Target User")),

    new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("Show Invite Leaderboard"),

    // --- Admin Tools ---
    new SlashCommandBuilder()
        .setName("admin")
        .setDescription("Admin Utility Tools")
        .addSubcommand(s => s.setName("say")
            .setDescription("Bot sends a message")
            .addStringOption(o => o.setName("message").setDescription("Text to send").setRequired(true))
            .addChannelOption(o => o.setName("channel").setDescription("Target Channel")))
        .addSubcommand(s => s.setName("announce")
            .setDescription("Send an announcement embed")
            .addStringOption(o => o.setName("title").setDescription("Title").setRequired(true))
            .addStringOption(o => o.setName("message").setDescription("Content").setRequired(true))
            .addChannelOption(o => o.setName("channel").setDescription("Target Channel"))
            .addStringOption(o => o.setName("image").setDescription("Image URL")))
        .addSubcommand(s => s.setName("dm")
            .setDescription("DM a user")
            .addUserOption(o => o.setName("user").setDescription("User").setRequired(true))
            .addStringOption(o => o.setName("message").setDescription("Message").setRequired(true))),

    // --- Protection Menu (Merged) ---
    new SlashCommandBuilder()
        .setName("protection")
        .setDescription("Security & Anti-Ping Settings")
        .addSubcommand(s => s.setName("whitelist")
            .setDescription("Manage Anti-Ping Whitelist")
            .addStringOption(o => o.setName("action").setDescription("Action").setRequired(true)
                .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'List', value: 'list' }))
            .addUserOption(o => o.setName("user").setDescription("User to whitelist"))
            .addRoleOption(o => o.setName("role").setDescription("Role to whitelist")))
        .addSubcommand(s => s.setName("pingpunish")
            .setDescription("Configure Ping Punishment")
            .addStringOption(o => o.setName("type").setDescription("Punishment Type")
                .addChoices({ name: 'Role', value: 'role' }, { name: 'Timeout', value: 'timeout' }))
            .addStringOption(o => o.setName("value").setDescription("Role ID or Duration (e.g 10m)"))
            .addUserOption(o => o.setName("target").setDescription("Add User to Blacklist (Punish on ping)"))),

    // --- Welcome / Bye Menu ---
    new SlashCommandBuilder()
        .setName("welcome")
        .setDescription("Manage Welcome & Goodbye Messages")
        .addSubcommand(s => s.setName("channel")
            .setDescription("Set Channel")
            .addStringOption(o => o.setName("type").setDescription("Type").setRequired(true)
                .addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Bye', value: 'bye' }))
            .addChannelOption(o => o.setName("target").setDescription("Channel").setRequired(true)))
        .addSubcommand(s => s.setName("message")
            .setDescription("Set Message Content")
            .addStringOption(o => o.setName("type").setDescription("Type").setRequired(true)
                .addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Bye', value: 'bye' }))
            .addStringOption(o => o.setName("content").setDescription("Content").setRequired(true))
            .addStringOption(o => o.setName("title").setDescription("Embed Title")))
        .addSubcommand(s => s.setName("toggle")
            .setDescription("Enable or Disable")
            .addStringOption(o => o.setName("type").setDescription("Type").setRequired(true)
                .addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Bye', value: 'bye' }))
            .addStringOption(o => o.setName("state").setDescription("State").setRequired(true)
                .addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })))
        .addSubcommand(s => s.setName("test")
            .setDescription("Test the Welcome/Bye events")),

    // --- Security & Verification ---
    new SlashCommandBuilder()
        .setName("bansystem")
        .setDescription("Manage Script Bans")
        .addSubcommand(s => s.setName("ban").setDescription("Ban a user").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")))
        .addSubcommand(s => s.setName("unban").setDescription("Unban a user").addStringOption(o => o.setName("target").setRequired(true).setDescription("Code/HWID")))
        .addSubcommand(s => s.setName("list").setDescription("List all bans")),

    new SlashCommandBuilder()
        .setName("setkey")
        .setDescription("Manually update a user's key")
        .addStringOption(o => o.setName("target").setDescription("User ID / HWID / Old Code").setRequired(true))
        .addStringOption(o => o.setName("new_code").setDescription("New Key Code").setRequired(true)),

    new SlashCommandBuilder()
        .setName("setnote")
        .setDescription("Add an Admin Note")
        .addStringOption(o => o.setName("target").setDescription("Target").setRequired(true))
        .addStringOption(o => o.setName("note").setDescription("Note content").setRequired(true)),

    new SlashCommandBuilder()
        .setName("setexpiry")
        .setDescription("Manually set key expiration")
        .addStringOption(o => o.setName("target").setDescription("Target").setRequired(true))
        .addStringOption(o => o.setName("duration").setDescription("1d, 12h, lifetime").setRequired(true))
        .addStringOption(o => o.setName("note").setDescription("Optional Note")),

    new SlashCommandBuilder()
        .setName("custommsg")
        .setDescription("Set Custom Success Message for Verification")
        .addStringOption(o => o.setName("message").setDescription("The message text").setRequired(true)),

    new SlashCommandBuilder().setName("lookup").setDescription("Lookup User Info").addStringOption(o => o.setName("target").setRequired(true).setDescription("Target")),
    new SlashCommandBuilder().setName("activeusers").setDescription("Show active script users"),
    new SlashCommandBuilder().setName("checkalts").setDescription("Scan for Multi-Key users"),
    new SlashCommandBuilder().setName("setcode").setDescription("Set Custom Code (User ID)").addUserOption(o => o.setName("user").setRequired(true)).addStringOption(o => o.setName("code").setRequired(true)),

    // --- Rules & Rewards ---
    new SlashCommandBuilder()
        .setName("rules")
        .setDescription("Manage Verification Rules")
        .addSubcommand(s => s.setName("set").setDescription("Set/Add Rule").addRoleOption(o => o.setName("role").setRequired(true)).addStringOption(o => o.setName("duration").setRequired(true)))
        .addSubcommand(s => s.setName("remove").setDescription("Remove Rule").addRoleOption(o => o.setName("role").setRequired(true)))
        .addSubcommand(s => s.setName("list").setDescription("List Rules")),

    new SlashCommandBuilder()
        .setName("rewards")
        .setDescription("Manage Invite Rewards")
        .addSubcommand(s => s.setName("add").setDescription("Add Reward").addIntegerOption(o => o.setName("invites").setRequired(true)).addRoleOption(o => o.setName("role").setRequired(true)))
        .addSubcommand(s => s.setName("remove").setDescription("Remove Reward").addIntegerOption(o => o.setName("id").setRequired(true)))
        .addSubcommand(s => s.setName("list").setDescription("List Rewards")),

    new SlashCommandBuilder().setName("syncmissing").setDescription("Sync Missing Invites"),

    // --- Poll System ---
    new SlashCommandBuilder()
        .setName("poll")
        .setDescription("Create a Poll")
        .addStringOption(o => o.setName("q").setDescription("Question").setRequired(true))
        .addStringOption(o => o.setName("o1").setDescription("Option 1").setRequired(true))
        .addStringOption(o => o.setName("o2").setDescription("Option 2").setRequired(true))
        .addStringOption(o => o.setName("o3").setDescription("Option 3"))
        .addStringOption(o => o.setName("o4").setDescription("Option 4"))
        .addStringOption(o => o.setName("o5").setDescription("Option 5"))
        .addRoleOption(o => o.setName("punish_role").setDescription("Role for non-voters"))
        .addBooleanOption(o => o.setName("multiple").setDescription("Allow multiple votes")),

    new SlashCommandBuilder()
        .setName("endpoll")
        .setDescription("End a Poll")
        .addIntegerOption(o => o.setName("id").setRequired(true).setDescription("Poll ID"))
        .addStringOption(o => o.setName("duration").setDescription("Punishment Duration")),

    new SlashCommandBuilder()
        .setName("pollresults")
        .setDescription("View Results")
        .addIntegerOption(o => o.setName("pollid").setRequired(true).setDescription("Poll ID")),

    // --- Legacy / Helpers ---
    new SlashCommandBuilder().setName("getid").setDescription("Get Roblox ID").addStringOption(o=>o.setName("username").setRequired(true)),
    new SlashCommandBuilder().setName("linkroblox").setDescription("Link Account").addStringOption(o=>o.setName("roblox_id").setRequired(true))

].map(c => c.toJSON());

// =====================================================================
// 🚀 BOT INITIALIZATION
// =====================================================================

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    try { 
        const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
        await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands });
        console.log("✅ Commands Registered Successfully!");
    } catch(e) { 
        console.error("❌ Command Registration Error:", e); 
    }
});

// =====================================================================
// 🔥 EVENT: INTERACTION CREATE
// =====================================================================
client.on("interactionCreate", async interaction => {
    try {
        // 1. Handle Buttons & Modals
        if (interaction.customId?.startsWith("link")) { 
            if (interaction.isModalSubmit()) await handleLinkModal(interaction);
            else if (interaction.customId.includes("confirm") || interaction.customId.includes("cancel")) await handleLinkConfirm(interaction);
            else await handleLinkButton(interaction);
            return;
        }
        if (interaction.customId?.startsWith("vote")) { await handlePollVote(interaction); return; }
        if (interaction.customId?.startsWith("sync")) { await handleBatchSync(interaction); return; }
        if (interaction.customId?.startsWith("active")) { await handleActiveUsers(interaction, parseInt(interaction.customId.split('_')[2])); return; }

        // 2. Ignore non-commands
        if (!interaction.isChatInputCommand()) return;

        // 3. Public Commands
        if (interaction.commandName === "verify") return handleVerifyCommand(interaction);
        if (interaction.commandName === "invites") return handleInvites(interaction);
        if (interaction.commandName === "whoinvited") return handleWhoInvited(interaction);
        if (interaction.commandName === "leaderboard") return handleLeaderboard(interaction);
        if (interaction.commandName === "getid") return handleGetRobloxId(interaction);
        if (interaction.commandName === "linkroblox") return handleLinkRoblox(interaction);

        // 4. Admin Check
        if (!await isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ **Access Denied:** Administrators only.", ephemeral: true });

        const cmd = interaction.commandName;

        // 5. Admin Routing
        if (cmd === "admin") {
            const sub = interaction.options.getSubcommand();
            const ch = interaction.options.getChannel("channel") || interaction.channel;
            
            if (sub === "say") {
                await ch.send(interaction.options.getString("message"));
                interaction.reply({ content: "✅ Message Sent", ephemeral: true });
            }
            if (sub === "announce") {
                const embed = createEmbed(interaction.options.getString("title"), interaction.options.getString("message"), 0xFFD700);
                if (interaction.options.getString("image")) embed.setImage(interaction.options.getString("image"));
                await ch.send({ embeds: [embed] });
                interaction.reply({ content: "✅ Announcement Sent", ephemeral: true });
            }
            if (sub === "dm") {
                try {
                    await interaction.options.getUser("user").send(interaction.options.getString("message"));
                    interaction.reply({ content: "✅ DM Sent", ephemeral: true });
                } catch { interaction.reply({ content: "❌ Failed to DM user.", ephemeral: true }); }
            }
        }
        else if (cmd === "welcome") await handleWelcomeCommands(interaction);
        else if (cmd === "protection") {
            const sub = interaction.options.getSubcommand();
            if (sub === "whitelist") await require("./invite").handleWhitelist(interaction);
            if (sub === "pingpunish") {
                const type = interaction.options.getString("type");
                const val = interaction.options.getString("value");
                const target = interaction.options.getUser("target");

                if (target) {
                    const { data } = await supabase.from("guild_config").select("ping_target_users").eq("guild_id", interaction.guild.id).maybeSingle();
                    let list = data?.ping_target_users || [];
                    if(!list.includes(target.id)) list.push(target.id);
                    await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_target_users: list });
                    interaction.reply(`✅ Added ${target.tag} to blacklist.`);
                } else {
                    if (type === 'role') await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_punish_role: val });
                    else await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_timeout_ms: parseDuration(val) });
                    interaction.reply("✅ Ping Punishment Configured");
                }
            }
        }
        else if (cmd === "custommsg") {
            const msg = interaction.options.getString("message");
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, verify_success_msg: msg });
            interaction.reply("✅ Custom Message Updated");
        }
        
        // Modules Routing
        else if (cmd === "rewards") await handleRewards(interaction);
        else if (cmd === "activeusers") await handleActiveUsers(interaction);
        else if (cmd === "setcode") await handleSetCode(interaction);
        else if (cmd === "setkey") await handleKeyUpdate(interaction);
        else if (cmd === "bansystem") await handleBanSystem(interaction);
        else if (cmd === "rules") await handleRules(interaction);
        else if (cmd === "lookup") await handleLookup(interaction);
        else if (cmd === "setexpiry") await handleSetExpiry(interaction);
        else if (cmd === "checkalts") await handleCheckAlts(interaction);
        else if (cmd === "setnote") await handleSetNote(interaction);
        else if (cmd === "syncmissing") { 
            await interaction.deferReply({ ephemeral: true }); 
            await showBatchSync(interaction); 
        }
        else if (cmd === "poll") await handlePollCreate(interaction);
        else if (cmd === "endpoll") await handlePollEnd(interaction);
        else if (cmd === "pollresults") await handlePollResults(interaction);

    } catch (e) {
        console.error("Interaction Error:", e);
        logToWebhook("🔥 **Command Crash**", `**User:** ${interaction.user.tag}\n**Command:** ${interaction.commandName}\n\`\`\`js\n${e.stack}\n\`\`\``, SETTINGS.COLOR_ERROR);
        
        // Safe Reply to avoid 'InteractionAlreadyReplied'
        if (!interaction.replied && !interaction.deferred) {
            interaction.reply({ content: "❌ An internal error occurred. Log sent to admin.", ephemeral: true }).catch(()=>{});
        } else if (interaction.deferred && !interaction.replied) {
            interaction.editReply({ content: "❌ An internal error occurred." }).catch(()=>{});
        }
    }
});

// =====================================================================
// 🔥 EVENTS: TRACKING & MESSAGES
// =====================================================================

client.on("guildMemberAdd", (m) => trackJoin(m));
client.on("guildMemberRemove", (m) => trackLeave(m));

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // 1. Text Verification (Shortcut)
    if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID) {
        if (message.content.toLowerCase().startsWith("verify ") || /^\d+$/.test(message.content.trim())) {
            // Uses processVerification directly to allow text-based flow
            await require("./verification").processVerification(message.author, message.content, message.guild, (opts) => message.reply(opts));
        }
    }

    // 2. Anti-Ping Logic
    if (message.mentions.users.has(SETTINGS.SUPER_OWNER_ID) && message.author.id !== SETTINGS.SUPER_OWNER_ID && !message.reference) {
        const { data } = await supabase.from("guild_config").select("*").eq("guild_id", message.guild.id).maybeSingle();
        
        // Allow Whitelisted
        if (data?.ping_whitelist?.includes(message.author.id)) return;

        // Force Punish Blacklisted Target
        const isTarget = data?.ping_target_users?.includes(message.author.id);

        if (message.member.moderatable) {
            if (data?.ping_punish_role) {
                await message.member.roles.add(data.ping_punish_role).catch(() => {});
                message.reply("⚠️ **Do not ping Owner!** (Role Penalty Applied)");
            } else {
                const duration = data?.ping_timeout_ms || SETTINGS.DEFAULT_PUNISH_MS;
                await message.member.timeout(duration, "Anti-Ping Violation");
                message.reply(`⚠️ **Do not ping Owner!** (${duration/60000}m Timeout Applied)`);
            }
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
