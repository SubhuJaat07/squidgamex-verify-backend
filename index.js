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

// Importing Modules
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
    handleKeyUpdate,
    handleVerifyCommand, 
    handleLinkButton,
    handleLinkModal,
    handleLinkConfirm,
    handleSetNote 
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
// 🌐 EXPRESS API SERVER
// =====================================================================
const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("System Online 🟢 | Squid Game X Backend"));

// Check Endpoint for Script
app.get("/check", async (req, res) => {
    if (SETTINGS.MAINTENANCE) return res.json({ status: "ERROR", message: "Maintenance Mode" });
    
    const { hwid, roblox_id, roblox_username } = req.query;
    if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });
    
    try {
        const { data } = await supabase.from("verifications").select("*").eq("hwid", hwid).maybeSingle();
        
        if (data) {
            // Update execution details if provided
            if (roblox_id) {
                await supabase.from("verifications").update({ 
                    executed_roblox_id: roblox_id, 
                    executed_roblox_username: roblox_username 
                }).eq("id", data.id);
            }

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
        await supabase.from("verifications").insert([{ 
            hwid, code, verified: false, is_banned: false,
            executed_roblox_id: roblox_id || null, 
            executed_roblox_username: roblox_username || null 
        }]);
        
        // Log New Registration
        logToWebhook("🆕 **New HWID Registered**", `HWID: \`${hwid}\`\nCode: \`${code}\``, SETTINGS.COLOR_INFO);

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
        .setDescription("Verify to get access (Interactive)")
        .addStringOption(o => o.setName("code").setDescription("Enter your key code").setRequired(true)),

    new SlashCommandBuilder()
        .setName("invites")
        .setDescription("Check invitation stats")
        .addUserOption(o => o.setName("user").setDescription("Target User")),

    new SlashCommandBuilder()
        .setName("whoinvited")
        .setDescription("See who invited a specific user")
        .addUserOption(o => o.setName("user").setDescription("Target User")),

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

    // 3. SERVER PROTECTION
    new SlashCommandBuilder()
        .setName("protection")
        .setDescription("Security & Anti-Ping Settings")
        .addSubcommand(s => s.setName("whitelist").setDescription("Manage Whitelist").addStringOption(o => o.setName("action").setDescription("Select Action").setRequired(true).addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' }, { name: 'List', value: 'list' })).addUserOption(o => o.setName("user").setDescription("Target User")).addRoleOption(o => o.setName("role").setDescription("Target Role")))
        .addSubcommand(s => s.setName("pingpunish").setDescription("Configure Ping Punishment")
            .addStringOption(o => o.setName("type").setDescription("Punish Type").addChoices({ name: 'Role', value: 'role' }, { name: 'Timeout', value: 'timeout' }))
            .addStringOption(o => o.setName("value").setDescription("Role ID or Duration (10m)"))
            .addUserOption(o => o.setName("target").setDescription("Punish Specific User (Bypass Whitelist)"))),

    // 4. WELCOME & BYE SYSTEM
    new SlashCommandBuilder()
        .setName("welcome")
        .setDescription("Manage Welcome & Goodbye Messages")
        .addSubcommand(s => s.setName("channel").setDescription("Set Channel").addStringOption(o => o.setName("type").setDescription("Type").setRequired(true).addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Bye', value: 'bye' })).addChannelOption(o => o.setName("target").setDescription("Channel").setRequired(true)))
        .addSubcommand(s => s.setName("message").setDescription("Set Message").addStringOption(o => o.setName("type").setDescription("Type").setRequired(true).addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Bye', value: 'bye' })).addStringOption(o => o.setName("content").setDescription("Content ({user}, {count})").setRequired(true)).addStringOption(o => o.setName("title").setDescription("Embed Title")))
        .addSubcommand(s => s.setName("toggle").setDescription("Enable/Disable").addStringOption(o => o.setName("type").setDescription("Type").setRequired(true).addChoices({ name: 'Welcome', value: 'welcome' }, { name: 'Bye', value: 'bye' })).addStringOption(o => o.setName("state").setDescription("State").setRequired(true).addChoices({ name: 'On', value: 'on' }, { name: 'Off', value: 'off' })))
        .addSubcommand(s => s.setName("test").setDescription("Test Configuration")),

    // 5. SECURITY MANAGEMENT
    new SlashCommandBuilder()
        .setName("bansystem")
        .setDescription("Manage Script Bans")
        .addSubcommand(s => s.setName("ban").setDescription("Ban a user/hwid").addStringOption(o => o.setName("target").setRequired(true).setDescription("Target Code/HWID")))
        .addSubcommand(s => s.setName("unban").setDescription("Unban a user/hwid").addStringOption(o => o.setName("target").setRequired(true).setDescription("Target Code/HWID")))
        .addSubcommand(s => s.setName("list").setDescription("List all bans")),

    new SlashCommandBuilder()
        .setName("rules")
        .setDescription("Manage Verification Rules")
        .addSubcommand(s => s.setName("set").setDescription("Set/Add Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time (e.g 1h, lifetime)")))
        .addSubcommand(s => s.setName("remove").setDescription("Remove Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")))
        .addSubcommand(s => s.setName("list").setDescription("List Rules")),

    new SlashCommandBuilder()
        .setName("setkey")
        .setDescription("Manually update or reset a user's key")
        .addStringOption(o => o.setName("target").setDescription("User ID, HWID, or Old Code").setRequired(true))
        .addStringOption(o => o.setName("new_code").setDescription("The New Key Code").setRequired(true)),

    new SlashCommandBuilder()
        .setName("setnote")
        .setDescription("Add Admin Note to User")
        .addStringOption(o => o.setName("target").setDescription("Target").setRequired(true))
        .addStringOption(o => o.setName("note").setDescription("Note Content").setRequired(true)),

    new SlashCommandBuilder()
        .setName("custommsg")
        .setDescription("Set Custom Verification Success Message")
        .addStringOption(o => o.setName("message").setDescription("Message content").setRequired(true)),

    new SlashCommandBuilder().setName("lookup").setDescription("Lookup User").addStringOption(o => o.setName("target").setDescription("Code, HWID, or User ID").setRequired(true)),
    new SlashCommandBuilder().setName("activeusers").setDescription("Show active users"),
    new SlashCommandBuilder().setName("checkalts").setDescription("Check for alts"),
    
    // 🔥 FIXED: Added .setDescription() to user option here
    new SlashCommandBuilder()
        .setName("setcode")
        .setDescription("Set custom code (User ID)")
        .addUserOption(o => o.setName("user").setRequired(true).setDescription("User to update"))
        .addStringOption(o => o.setName("code").setRequired(true).setDescription("New Code")),

    new SlashCommandBuilder()
        .setName("setexpiry")
        .setDescription("Set expiry")
        .addStringOption(o => o.setName("target").setRequired(true).setDescription("Target"))
        .addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time"))
        .addStringOption(o => o.setName("note").setDescription("Note")),

    // 6. INVITE REWARDS
    new SlashCommandBuilder()
        .setName("rewards")
        .setDescription("Manage Invite Rewards")
        .addSubcommand(s => s.setName("add").setDescription("Add Reward").addIntegerOption(o => o.setName("invites").setDescription("Count").setRequired(true)).addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)))
        .addSubcommand(s => s.setName("remove").setDescription("Remove Reward").addIntegerOption(o => o.setName("id").setDescription("Reward ID").setRequired(true)))
        .addSubcommand(s => s.setName("list").setDescription("List Rewards")),

    new SlashCommandBuilder().setName("syncmissing").setDescription("Sync Invites (Admin)"),

    // 7. POLL SYSTEM
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

    new SlashCommandBuilder().setName("endpoll").setDescription("End a Poll").addIntegerOption(o => o.setName("id").setDescription("Poll ID").setRequired(true)).addStringOption(o => o.setName("duration").setDescription("Punish Duration")),
    new SlashCommandBuilder().setName("pollresults").setDescription("View Poll Results").addIntegerOption(o => o.setName("pollid").setDescription("Poll ID").setRequired(true)),

    // 8. HELPERS
    new SlashCommandBuilder().setName("getid").setDescription("Legacy GetID").addStringOption(o => o.setName("username").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("linkroblox").setDescription("Legacy Link").addStringOption(o => o.setName("roblox_id").setDescription("ID").setRequired(true))

].map(c => c.toJSON());

// =====================================================================
// 🚀 EVENT HANDLERS
// =====================================================================

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    try { 
        const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
        await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands });
        console.log("✅ Commands Registered Successfully!");
    } catch(e) { 
        console.error("❌ Command Reg Error:", e); 
        logToWebhook("❌ **Startup Error**", `Command Registration Failed:\n\`\`\`${e.message}\`\`\``, SETTINGS.COLOR_ERROR);
    }
});

// 🔥 INTERACTION HANDLER
client.on("interactionCreate", async interaction => {
    try {
        // Handle Interactive Buttons & Modals
        if (interaction.customId?.startsWith("link_start")) { await handleLinkButton(interaction); return; }
        if (interaction.isModalSubmit() && interaction.customId.startsWith("link_modal")) { await handleLinkModal(interaction); return; }
        if (interaction.customId?.startsWith("link_confirm")) { await handleLinkConfirm(interaction); return; }
        
        if (interaction.customId?.startsWith("vote_")) { await handlePollVote(interaction); return; }
        if (interaction.customId?.startsWith("sync_")) { await handleBatchSync(interaction); return; }
        if (interaction.customId?.startsWith("active_")) { 
            const page = parseInt(interaction.customId.split('_')[2]); 
            await handleActiveUsers(interaction, page); 
            return; 
        }

        if (!interaction.isChatInputCommand()) return;

        // --- PUBLIC COMMANDS ---
        if (interaction.commandName === "verify") return handleVerifyCommand(interaction);
        if (interaction.commandName === "invites") return handleInvites(interaction);
        if (interaction.commandName === "whoinvited") return handleWhoInvited(interaction);
        if (interaction.commandName === "leaderboard") return handleLeaderboard(interaction);
        if (interaction.commandName === "getid") return handleGetRobloxId(interaction);
        if (interaction.commandName === "linkroblox") return handleLinkRoblox(interaction);

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

        // Welcome & Protection Menus
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

        // Other Admin
        else if (cmd === "custommsg") {
            const msg = interaction.options.getString("message");
            await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, verify_success_msg: msg });
            interaction.reply("✅ Custom Verification Message Set");
        }
        else if (cmd === "rewards") await handleRewards(interaction);
        else if (cmd === "activeusers") await handleActiveUsers(interaction, 1);
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

        // Poll System
        else if (cmd === "poll") await handlePollCreate(interaction);
        else if (cmd === "endpoll") await handlePollEnd(interaction);
        else if (cmd === "pollresults") await handlePollResults(interaction);

    } catch (e) {
        console.error("Interaction Error:", e);
        // Crash prevention for replies
        if(!interaction.replied && !interaction.deferred) {
            interaction.reply({content: "❌ An internal error occurred.", ephemeral:true}).catch(()=>{});
        } else if (interaction.deferred && !interaction.replied) {
            interaction.editReply({content: "❌ An internal error occurred."}).catch(()=>{});
        }
    }
});

// 🔥 TRACK EVENTS
client.on("guildMemberAdd", (member) => trackJoin(member, false));
client.on("guildMemberRemove", (member) => trackLeave(member, false));

// 🔥 TEXT COMMANDS & ANTI-PING
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;

    // Text Verification
    if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID) {
        if (message.content.toLowerCase().startsWith("verify ") || /^\d+$/.test(message.content.trim())) {
            // Re-route to processVerification (Assuming verification.js exports it)
            await require("./verification").processVerification(message.author, message.content, message.guild, (opts) => message.reply(opts));
        }
    }

    // Anti-Ping Logic
    if (message.mentions.users.has(SETTINGS.SUPER_OWNER_ID) && message.author.id !== SETTINGS.SUPER_OWNER_ID && !message.reference) {
        const { data } = await supabase.from("guild_config").select("*").eq("guild_id", message.guild.id).maybeSingle();
        
        if (data?.ping_whitelist?.includes(message.author.id)) return;

        // Blacklist Check
        if (data?.ping_target_users?.includes(message.author.id)) {
             // Instant timeout for blacklisted
             await message.member.timeout(SETTINGS.DEFAULT_PUNISH_MS, "Blacklisted Ping");
             return message.reply("🚫 **Blacklisted:** Do not ping owner.");
        }

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
