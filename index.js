const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Routes, REST, SlashCommandBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { SETTINGS, supabase, isAdmin, createEmbed, safeReply, parseDuration, logToWebhook } = require("./config");
const { processVerification, handleGetRobloxId, handleLinkRoblox, handleActiveUsers, handleRules, handleLookup } = require("./verification");
const { showBatchSync, handleBatchSync, handleLeaderboard, handleRewards, handleConfigWelcome } = require("./invite");

const app = express();
app.use(cors());
app.use(express.json());

// API
app.get("/", (req, res) => res.send("System Online 🟢"));
app.get("/check", async (req, res) => {
    if (SETTINGS.MAINTENANCE) return res.json({ status: "ERROR", message: "Maintenance" });
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
    new SlashCommandBuilder().setName("getid").setDescription("Get Roblox ID").addStringOption(o=>o.setName("username").setRequired(true).setDescription("Username")),
    new SlashCommandBuilder().setName("linkroblox").setDescription("Link ID").addStringOption(o=>o.setName("roblox_id").setRequired(true).setDescription("ID")),
    new SlashCommandBuilder().setName("activeusers").setDescription("Active Users List"),
    new SlashCommandBuilder().setName("syncmissing").setDescription("Admin: Sync DB"),
    new SlashCommandBuilder().setName("leaderboard").setDescription("Invite Leaderboard"),
    new SlashCommandBuilder().setName("lookup").setDescription("Admin: Lookup").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")),
    
    new SlashCommandBuilder().setName("setexpiry").setDescription("Admin: Add Time").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")).addStringOption(o=>o.setName("duration").setRequired(true).setDescription("Time")).addStringOption(o=>o.setName("note").setDescription("Note")),

    // CONFIG & PUNISHMENT
    new SlashCommandBuilder().setName("config").setDescription("Config")
        .addSubcommand(s=>s.setName("pingpunish").setDescription("Setup Anti-Ping").addStringOption(o=>o.setName("type").setRequired(true).setDescription("timeout/role").addChoices({name:'Timeout',value:'timeout'},{name:'Role',value:'role'})).addStringOption(o=>o.setName("value").setRequired(true).setDescription("Duration or Role ID")))
        .addSubcommand(s=>s.setName("whitelist").setDescription("Whitelist from Anti-Ping").addUserOption(o=>o.setName("user").setDescription("User")).addRoleOption(o=>o.setName("role").setDescription("Role")))
        .addSubcommand(s=>s.setName("welcome").setDescription("Set Welcome").addChannelOption(o=>o.setName("channel").setRequired(true).setDescription("Channel"))),

    // POLLS
    new SlashCommandBuilder().setName("poll").setDescription("Create Poll")
        .addStringOption(o => o.setName("q").setRequired(true).setDescription("Question"))
        .addStringOption(o => o.setName("o1").setRequired(true).setDescription("Option 1"))
        .addStringOption(o => o.setName("o2").setRequired(true).setDescription("Option 2"))
        .addStringOption(o => o.setName("o3").setDescription("Option 3"))
        .addStringOption(o => o.setName("o4").setDescription("Option 4"))
        .addStringOption(o => o.setName("o5").setDescription("Option 5"))
        .addRoleOption(o => o.setName("punish_role").setDescription("Role for non-voters"))
        .addBooleanOption(o => o.setName("multiple").setDescription("Allow Multiple Votes")),
        
    new SlashCommandBuilder().setName("endpoll").setDescription("End Poll").addIntegerOption(o => o.setName("pollid").setRequired(true).setDescription("Poll ID")),
    new SlashCommandBuilder().setName("pollresults").setDescription("Detailed Results").addIntegerOption(o => o.setName("pollid").setDescription("ID")),

    // RULES (FIXED: Added Descriptions)
    new SlashCommandBuilder().setName("rules").setDescription("Rule System")
        .addSubcommand(s=>s.setName("set").setDescription("Set Rule").addRoleOption(o=>o.setName("role").setRequired(true).setDescription("Target Role")).addStringOption(o=>o.setName("duration").setRequired(true).setDescription("Duration (e.g. 1d)")))
        .addSubcommand(s=>s.setName("remove").setDescription("Remove Rule").addRoleOption(o=>o.setName("role").setRequired(true).setDescription("Target Role")))
        .addSubcommand(s=>s.setName("list").setDescription("List Rules")),

    // REWARDS (FIXED: Added Descriptions)
    new SlashCommandBuilder().setName("rewards").setDescription("Invite Rewards")
        .addSubcommand(s=>s.setName("add").setDescription("Add Reward").addIntegerOption(o=>o.setName("invites").setRequired(true).setDescription("Invites Needed")).addRoleOption(o=>o.setName("role").setRequired(true).setDescription("Reward Role")))
        .addSubcommand(s=>s.setName("list").setDescription("List Rewards"))
        .addSubcommand(s=>s.setName("remove").setDescription("Remove Reward").addIntegerOption(o=>o.setName("reward_id").setRequired(true).setDescription("Reward ID")))

].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

// 🔥 INTERACTION HANDLER
client.on("interactionCreate", async interaction => {
    try {
        if (interaction.customId?.startsWith('sync_')) { await handleBatchSync(interaction); return; }
        if (interaction.customId?.startsWith('active_')) {
            const page = parseInt(interaction.customId.split('_')[2]);
            await handleActiveUsers(interaction, page);
            return;
        }

        // 🔥 POLL VOTE LOGIC (Multi & Retract)
        if (interaction.isButton() && interaction.customId.startsWith('vote_')) {
            const [_, pid, ch] = interaction.customId.split('_');
            const pollId = parseInt(pid);
            await interaction.deferReply({ ephemeral: true });

            // Check if poll active
            const { data: poll } = await supabase.from("polls").select("*").eq("id", pollId).single();
            if (!poll.is_active) return interaction.editReply("❌ Poll Ended!");

            // Check existing vote
            const { data: existing } = await supabase.from("poll_votes").select("*").eq("poll_id", pollId).eq("user_id", interaction.user.id);
            
            // Retract Vote Logic (If clicked same button)
            if (existing.some(v => v.choice === parseInt(ch))) {
                await supabase.from("poll_votes").delete().eq("poll_id", pollId).eq("user_id", interaction.user.id).eq("choice", parseInt(ch));
                return interaction.editReply("🗑️ Vote Retracted.");
            }

            // Single Choice Enforcement
            if (!poll.allow_multiple && existing.length > 0) {
                // Update (Change vote)
                await supabase.from("poll_votes").update({ choice: parseInt(ch) }).eq("poll_id", pollId).eq("user_id", interaction.user.id);
            } else {
                // Insert New
                await supabase.from("poll_votes").insert({ poll_id: pollId, user_id: interaction.user.id, choice: parseInt(ch) });
            }

            // Update Live Count (Total Only)
            const { count } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId);
            const oldEmbed = interaction.message.embeds[0];
            const newEmbed = EmbedBuilder.from(oldEmbed).setFooter({ text: `Squid Game X • Live Total Votes: ${count}` });
            await interaction.message.edit({ embeds: [newEmbed] });

            return interaction.editReply("✅ Vote Saved!");
        }

        if (!interaction.isChatInputCommand()) return;

        // Command Routing
        if (interaction.commandName === "verify") {
            await interaction.deferReply();
            await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (opts) => interaction.editReply(opts));
        }
        if (interaction.commandName === "getid") await handleGetRobloxId(interaction);
        if (interaction.commandName === "linkroblox") await handleLinkRoblox(interaction);
        if (interaction.commandName === "activeusers") await handleActiveUsers(interaction, 1);
        if (interaction.commandName === "rules") await handleRules(interaction);
        if (interaction.commandName === "syncmissing") { await interaction.deferReply({ ephemeral: true }); await showBatchSync(interaction); }
        if (interaction.commandName === "leaderboard") await handleLeaderboard(interaction);
        if (interaction.commandName === "rewards") await handleRewards(interaction);
        if (interaction.commandName === "lookup") await handleLookup(interaction);

        // SET EXPIRY + NOTE
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

        // --- POLL SYSTEM ---
        if (interaction.commandName === "poll") {
            if(!await isAdmin(interaction.user.id)) return interaction.reply("❌ Admin");
            const q = interaction.options.getString("q");
            const opts = [1,2,3,4,5].map(i => interaction.options.getString(`o${i}`)).filter(o=>o);
            const pRole = interaction.options.getRole("punish_role");
            const multi = interaction.options.getBoolean("multiple") || false;
            
            const {data} = await supabase.from("polls").insert({ question: q, option1: opts[0], option2: opts[1]||"", is_active: true, allow_multiple: multi, punish_role_id: pRole?.id }).select().single();
            
            const embed = createEmbed(`📊 Poll #${data.id}`, `**${q}**\n` + opts.map((o,i)=>`**${i+1}️⃣** ${o}`).join('\n') + `\n\n⚠️ **Non-voters will receive:** ${pRole ? pRole : "Punishment"}`, SETTINGS.COLOR_WARN);
            const row = new ActionRowBuilder().addComponents(opts.map((_,i)=>new ButtonBuilder().setCustomId(`vote_${data.id}_${i+1}`).setLabel(`${i+1}`).setStyle(ButtonStyle.Primary)));
            
            await interaction.channel.send({ content: "@everyone", embeds: [embed], components: [row] });
            return interaction.reply({content:"✅ Poll Started", ephemeral:true});
        }

        if (interaction.commandName === "endpoll") {
            await interaction.deferReply();
            const pid = interaction.options.getInteger("pollid");
            
            // 1. Deactivate
            await supabase.from("polls").update({ is_active: false }).eq("id", pid);
            
            // 2. Punish Logic
            const { data: poll } = await supabase.from("polls").select("*").eq("id", pid).single();
            const { data: votes } = await supabase.from("poll_votes").select("user_id").eq("poll_id", pid);
            const voters = new Set(votes.map(v => v.user_id));
            
            let punishedCount = 0;
            if (poll.punish_role_id) {
                const role = interaction.guild.roles.cache.get(poll.punish_role_id);
                if (role) {
                    const members = await interaction.guild.members.fetch();
                    members.forEach(async m => {
                        if (!m.user.bot && !voters.has(m.id)) {
                            await m.roles.add(role).catch(()=>{});
                            try { await m.send(`⚠️ **You missed Poll #${pid}!**\nYou have been given the **${role.name}** role as penalty.`); } catch(e){}
                            punishedCount++;
                        }
                    });
                }
            }
            
            logToWebhook("🛑 Poll Ended", `Poll #${pid} ended.\nVoters: ${voters.size}\nPunished: ${punishedCount}`);
            return interaction.editReply({ embeds: [createEmbed(`🛑 Poll #${pid} Ended`, `**Votes:** ${voters.size}\n**Punished:** ${punishedCount} users`, SETTINGS.COLOR_ERROR)] });
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

        // CONFIG (Ping Punish & Welcome)
        if (interaction.commandName === "config") {
            const sub = interaction.options.getSubcommand();
            if (sub === "pingpunish") {
                const type = interaction.options.getString("type");
                const val = interaction.options.getString("value");
                if (type === 'timeout') await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_timeout_ms: parseDuration(val) });
                if (type === 'role') await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_punish_role: val });
                return interaction.reply("✅ Config Updated");
            }
            if (sub === "whitelist") {
                const user = interaction.options.getUser("user");
                const role = interaction.options.getRole("role");
                const {data} = await supabase.from("guild_config").select("ping_whitelist").eq("guild_id", interaction.guild.id).single();
                let list = data?.ping_whitelist || [];
                if(user) list.push(user.id);
                if(role) list.push(role.id);
                await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_whitelist: list });
                return interaction.reply("✅ Added to Whitelist");
            }
            if (sub === "welcome") await handleConfigWelcome(interaction);
        }

    } catch (e) { console.error(e); }
});

// 🔥 ANTI-PING SYSTEM
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    
    // Check if mentions Super Owner
    if (message.mentions.users.has(SETTINGS.SUPER_OWNER_ID) && message.author.id !== SETTINGS.SUPER_OWNER_ID && !message.reference) {
        // Fetch Config
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", message.guild.id).maybeSingle();
        const whitelist = config?.ping_whitelist || [];
        
        // Whitelist Check
        if (whitelist.includes(message.author.id) || message.member.roles.cache.some(r => whitelist.includes(r.id))) return;

        // Punish
        if (message.member.moderatable) {
            if (config?.ping_punish_role) {
                await message.member.roles.add(config.ping_punish_role).catch(()=>{});
                message.reply("⚠️ **Don't ping Owner!** (Role Penalty Applied)");
            } else {
                const duration = config?.ping_timeout_ms || SETTINGS.DEFAULT_PUNISH_MS;
                await message.member.timeout(duration, "Pinging Owner"); 
                message.reply(`⚠️ **Don't ping Owner!** (${duration/60000}m Timeout)`);
            }
        }
    }
    
    // Text Verify
    if (message.content.toLowerCase().startsWith("verify ")) {
        if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID || await isAdmin(message.author.id)) {
            await processVerification(message.author, message.content.split(" ")[1], message.guild, (opts) => message.reply(opts));
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
