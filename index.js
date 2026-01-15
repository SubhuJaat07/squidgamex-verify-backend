const express = require("express");
const cors = require("cors");
const { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    Routes, 
    REST, 
    SlashCommandBuilder, 
    PermissionsBitField, 
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

const { 
    processVerification, 
    handleGetRobloxId, 
    handleLinkRoblox, 
    handleActiveUsers, 
    handleSetCode, 
    handleBanSystem, 
    handleRules, 
    handleLookup, 
    handleSetExpiry, 
    handleCheckAlts,
    handleKeyUpdate // <--- New Function Import
} = require("./verification");

const { 
    handleWhitelist, 
    handleWelcome, 
    handleRewards, 
    trackJoin, 
    showBatchSync, 
    handleBatchSync, 
    handleLeaderboard 
} = require("./invite");

const { 
    handlePollCreate, 
    handlePollVote, 
    handlePollEnd, 
    handlePollResults 
} = require("./poll");

// =====================================================================
// 🌐 EXPRESS API SERVER
// =====================================================================
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("System Online 🟢 | Squid Game X Backend"));

// Check Endpoint for Script
app.get("/check", async (req, res) => {
    if (SETTINGS.MAINTENANCE) return res.json({ status: "ERROR", message: "Maintenance Mode" });
    
    const { hwid } = req.query;
    if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });
    
    try {
        const { data } = await supabase.from("verifications").select("*").eq("hwid", hwid).maybeSingle();
        
        if (data) {
            if (data.is_banned) return res.json({ status: "BANNED" });
            
            const now = new Date();
            const expiry = new Date(data.expires_at);
            
            if (data.verified && expiry > now) {
                return res.json({ status: "VALID", message: "Access Granted" });
            }
            return res.json({ status: "NEED_VERIFY", code: data.code });
        }
        
        // Register New HWID
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await supabase.from("verifications").insert([{ hwid, code, verified: false, is_banned: false }]);
        
        return res.json({ status: "NEED_VERIFY", code });
    } catch (e) { 
        console.error(e);
        return res.json({ status: "ERROR" }); 
    }
});

app.listen(SETTINGS.PORT, () => console.log(`🚀 API Server Running on Port ${SETTINGS.PORT}`));

// =====================================================================
// 🤖 DISCORD CLIENT SETUP
// =====================================================================
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

// =====================================================================
// 📝 SLASH COMMANDS REGISTRY
// =====================================================================
const commands = [
    // 1. PUBLIC USER COMMANDS
    new SlashCommandBuilder()
        .setName("verify")
        .setDescription("Verify your key to access the script")
        .addStringOption(o => o.setName("code").setDescription("Enter your key code").setRequired(true)),

    new SlashCommandBuilder()
        .setName("getid")
        .setDescription("Get a Roblox User ID from Username")
        .addStringOption(o => o.setName("username").setDescription("Roblox Username").setRequired(true)),

    new SlashCommandBuilder()
        .setName("linkroblox")
        .setDescription("Link your Discord to Roblox")
        .addStringOption(o => o.setName("roblox_id").setDescription("Your Roblox ID").setRequired(true)),

    new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("Show Invite Leaderboard"),

    // 2. ADMIN TOOLS & UTILITIES
    new SlashCommandBuilder()
        .setName("admin")
        .setDescription("Admin Utility Tools")
        .addSubcommand(s => s.setName("say").setDescription("Make the bot send a message").addStringOption(o => o.setName("message").setDescription("Text to send").setRequired(true)).addChannelOption(o => o.setName("channel").setDescription("Target Channel")))
        .addSubcommand(s => s.setName("announce").setDescription("Send a professional announcement embed").addStringOption(o => o.setName("title").setDescription("Title").setRequired(true)).addStringOption(o => o.setName("message").setDescription("Description").setRequired(true)).addChannelOption(o => o.setName("channel").setDescription("Channel")).addStringOption(o => o.setName("image").setDescription("Image URL")))
        .addSubcommand(s => s.setName("dm").setDescription("Direct Message a user").addUserOption(o => o.setName("user").setDescription("Target User").setRequired(true)).addStringOption(o => o.setName("message").setDescription("Message Content").setRequired(true))),

    // 3. SECURITY & VERIFICATION MANAGEMENT
    new SlashCommandBuilder()
        .setName("setkey") // 🔥 NEW COMMAND
        .setDescription("Manually update or reset a user's key")
        .addStringOption(o => o.setName("target").setDescription("User ID, HWID, or Old Code").setRequired(true))
        .addStringOption(o => o.setName("new_code").setDescription("The New Key Code").setRequired(true)),

    new SlashCommandBuilder()
        .setName("setcode") // Legacy User-based set
        .setDescription("Set a custom code for a Discord User")
        .addUserOption(o => o.setName("user").setDescription("Target User").setRequired(true))
        .addStringOption(o => o.setName("code").setDescription("New Code").setRequired(true)),

    new SlashCommandBuilder()
        .setName("lookup")
        .setDescription("Lookup User/Key Information")
        .addStringOption(o => o.setName("target").setDescription("Code, HWID, or User ID").setRequired(true)),

    new SlashCommandBuilder()
        .setName("bansystem")
        .setDescription("Manage Script Bans")
        .addSubcommand(s => s.setName("ban").setDescription("Ban a user/hwid").addStringOption(o => o.setName("target").setRequired(true).setDescription("Target Code/HWID")))
        .addSubcommand(s => s.setName("unban").setDescription("Unban a user/hwid").addStringOption(o => o.setName("target").setRequired(true).setDescription("Target Code/HWID")))
        .addSubcommand(s => s.setName("list").setDescription("List all bans")),

    new SlashCommandBuilder()
        .setName("activeusers")
        .setDescription("Show list of currently active key users"),

    new SlashCommandBuilder()
        .setName("checkalts")
        .setDescription("Check for users with multiple active keys"),

    new SlashCommandBuilder()
        .setName("setexpiry")
        .setDescription("Manually set key expiration")
        .addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true))
        .addStringOption(o => o.setName("duration").setDescription("1d, 12h, lifetime").setRequired(true))
        .addStringOption(o => o.setName("note").setDescription("Admin Note")),

    // 4. SERVER PROTECTION & CONFIG
    new SlashCommandBuilder()
        .setName("whitelist")
        .setDescription("Manage Anti-Ping Whitelist")
        .addStringOption(o => o.setName("action").setDescription("Select Action").setRequired(true).addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'List', value: 'list' }))
        .addUserOption(o => o.setName("user").setDescription("Target User"))
        .addRoleOption(o => o.setName("role").setDescription("Target Role")),

    new SlashCommandBuilder()
        .setName("config")
        .setDescription("Bot Configuration")
        .addSubcommand(s => s.setName("pingpunish").setDescription("Setup Anti-Ping Punishment").addStringOption(o => o.setName("type").setDescription("Punish Type").setRequired(true).addChoices({ name: 'Role', value: 'role' }, { name: 'Timeout', value: 'timeout' })).addStringOption(o => o.setName("value").setDescription("Role ID or Duration (10m)").setRequired(true))),

    new SlashCommandBuilder()
        .setName("rules")
        .setDescription("Manage Verification Rules")
        .addSubcommand(s => s.setName("set").setDescription("Set Role Duration").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time")))
        .addSubcommand(s => s.setName("remove").setDescription("Remove Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")))
        .addSubcommand(s => s.setName("list").setDescription("List Rules")),

    // 5. INVITE & WELCOME
    new SlashCommandBuilder()
        .setName("welcome")
        .setDescription("Welcome System Settings")
        .addSubcommand(s => s.setName("channel").setDescription("Set Welcome Channel").addChannelOption(o => o.setName("target").setDescription("Channel").setRequired(true)))
        .addSubcommand(s => s.setName("message").setDescription("Set Welcome Message").addStringOption(o => o.setName("title").setDescription("Embed Title").setRequired(true)).addStringOption(o => o.setName("description").setDescription("Use {user}, {count}, {inviter}").setRequired(true)))
        .addSubcommand(s => s.setName("toggle").setDescription("Enable/Disable").addStringOption(o => o.setName("state").setDescription("State").setRequired(true).addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })))
        .addSubcommand(s => s.setName("test").setDescription("Test Welcome Message")),

    new SlashCommandBuilder()
        .setName("rewards")
        .setDescription("Manage Invite Rewards")
        .addSubcommand(s => s.setName("add").setDescription("Add Reward").addIntegerOption(o => o.setName("invites").setDescription("Count").setRequired(true)).addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)))
        .addSubcommand(s => s.setName("remove").setDescription("Remove Reward").addIntegerOption(o => o.setName("id").setDescription("Reward ID").setRequired(true)))
        .addSubcommand(s => s.setName("list").setDescription("List Rewards")),

    new SlashCommandBuilder()
        .setName("syncmissing")
        .setDescription("Sync Invites (Admin)"),

    // 6. POLL SYSTEM
    new SlashCommandBuilder()
        .setName("poll")
        .setDescription("Create an Advanced Poll")
        .addStringOption(o => o.setName("q").setDescription("Question").setRequired(true))
        .addStringOption(o => o.setName("o1").setDescription("Option 1").setRequired(true))
        .addStringOption(o => o.setName("o2").setDescription("Option 2").setRequired(true))
        .addStringOption(o => o.setName("o3").setDescription("Option 3"))
        .addStringOption(o => o.setName("o4").setDescription("Option 4"))
        .addStringOption(o => o.setName("o5").setDescription("Option 5"))
        .addRoleOption(o => o.setName("punish_role").setDescription("Role for Non-Voters"))
        .addBooleanOption(o => o.setName("multiple").setDescription("Allow Multiple Votes")),

    new SlashCommandBuilder()
        .setName("endpoll")
        .setDescription("End a Poll & Punish")
        .addIntegerOption(o => o.setName("id").setDescription("Poll ID").setRequired(true))
        .addStringOption(o => o.setName("duration").setDescription("Punish Duration (e.g. 2d)")),

    new SlashCommandBuilder()
        .setName("pollresults")
        .setDescription("View Detailed Poll Results")
        .addIntegerOption(o => o.setName("pollid").setDescription("Poll ID").setRequired(true))

].map(c => c.toJSON());

// =====================================================================
// 🚀 EVENT HANDLERS
// =====================================================================

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`📡 Registering ${commands.length} commands...`);
    
    try { 
        const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
        await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands });
        console.log("✅ Commands Registered Successfully!");
    } catch(e) { 
        console.error("❌ Command Reg Error:", e); 
    }
});

// 🔥 INTERACTION HANDLER
client.on("interactionCreate", async interaction => {
    try {
        // Handle Poll Votes & Batch Sync Buttons
        if (interaction.customId?.startsWith("vote_")) { await handlePollVote(interaction); return; }
        if (interaction.customId?.startsWith("sync_")) { await handleBatchSync(interaction); return; }
        if (interaction.customId?.startsWith("active_")) { 
            const page = parseInt(interaction.customId.split('_')[2]); 
            await handleActiveUsers(interaction, page); 
            return; 
        }

        if (!interaction.isChatInputCommand()) return;

        // --- PUBLIC COMMANDS ---
        if (interaction.commandName === "verify") { 
            await interaction.deferReply(); 
            await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (o) => interaction.editReply(o)); 
            return; 
        }
        if (interaction.commandName === "getid") return handleGetRobloxId(interaction);
        if (interaction.commandName === "linkroblox") return handleLinkRoblox(interaction);
        if (interaction.commandName === "leaderboard") return handleLeaderboard(interaction);

        // --- ADMIN ONLY CHECK ---
        if (!await isAdmin(interaction.user.id)) {
            return interaction.reply({ content: "❌ **Access Denied:** Administrators only.", ephemeral: true });
        }

        // --- ADMIN ROUTING ---
        const cmd = interaction.commandName;

        // Admin Tools
        if (cmd === "admin") {
            const sub = interaction.options.getSubcommand();
            const ch = interaction.options.getChannel("channel") || interaction.channel;
            
            if (sub === "say") {
                await ch.send(interaction.options.getString("message"));
                interaction.reply({ content: "✅ Sent", ephemeral: true });
            }
            if (sub === "announce") {
                const embed = createEmbed(interaction.options.getString("title"), interaction.options.getString("message"), 0xFFD700);
                if (interaction.options.getString("image")) embed.setImage(interaction.options.getString("image"));
                await ch.send({ embeds: [embed] });
                interaction.reply({ content: "✅ Announced", ephemeral: true });
            }
            if (sub === "dm") {
                try {
                    await interaction.options.getUser("user").send(interaction.options.getString("message"));
                    interaction.reply({ content: "✅ DM Sent", ephemeral: true });
                } catch { interaction.reply({ content: "❌ DM Failed", ephemeral: true }); }
            }
        }

        // Security & Config
        else if (cmd === "whitelist") await handleWhitelist(interaction);
        else if (cmd === "welcome") await handleWelcome(interaction);
        else if (cmd === "rewards") await handleRewards(interaction);
        else if (cmd === "activeusers") await handleActiveUsers(interaction, 1);
        else if (cmd === "setcode") await handleSetCode(interaction);
        else if (cmd === "setkey") await handleKeyUpdate(interaction); // 🔥 NEW
        else if (cmd === "bansystem") await handleBanSystem(interaction);
        else if (cmd === "rules") await handleRules(interaction);
        else if (cmd === "lookup") await handleLookup(interaction);
        else if (cmd === "setexpiry") await handleSetExpiry(interaction);
        else if (cmd === "checkalts") await handleCheckAlts(interaction);
        else if (cmd === "syncmissing") { 
            await interaction.deferReply({ ephemeral: true }); 
            await showBatchSync(interaction); 
        }
        else if (cmd === "config") {
            const type = interaction.options.getString("type");
            const val = interaction.options.getString("value");
            if (type === 'role') await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_punish_role: val });
            else await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_timeout_ms: parseDuration(val) });
            interaction.reply("✅ Config Updated");
        }

        // Poll System
        else if (cmd === "poll") await handlePollCreate(interaction);
        else if (cmd === "endpoll") await handlePollEnd(interaction);
        else if (cmd === "pollresults") await handlePollResults(interaction);

    } catch (e) {
        console.error("Interaction Error:", e);
        if(!interaction.replied) interaction.reply({content: "❌ An internal error occurred.", ephemeral:true});
    }
});

// 🔥 WELCOME TRACKER
client.on("guildMemberAdd", trackJoin);

// 🔥 TEXT COMMANDS & ANTI-PING
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // Text Verification (verify 123456 or just 123456)
    if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID) {
        // Regex checks for "verify <code>" OR just digits "123456"
        if (message.content.toLowerCase().startsWith("verify ") || /^\d+$/.test(message.content.trim())) {
            await processVerification(message.author, message.content, message.guild, (opts) => message.reply(opts));
        }
    }

    // Anti-Ping Logic
    if (message.mentions.users.has(SETTINGS.SUPER_OWNER_ID) && message.author.id !== SETTINGS.SUPER_OWNER_ID && !message.reference) {
        const { data } = await supabase.from("guild_config").select("*").eq("guild_id", message.guild.id).maybeSingle();
        
        // Check Whitelist
        if (data?.ping_whitelist?.includes(message.author.id)) return;

        // Apply Punishment
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
