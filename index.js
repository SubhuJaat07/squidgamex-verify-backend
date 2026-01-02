const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Routes, REST, SlashCommandBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { SETTINGS, supabase, isAdmin, createEmbed, safeReply, parseDuration } = require("./config");
const { processVerification, handleGetRobloxId, handleLinkRoblox, handleActiveUsers, handleRules, handleLookup } = require("./verification");
const { showBatchSync, handleBatchSync, trackJoin, handleLeaderboard, handleWhoInvited, handleAddReward } = require("./invite");

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
    new SlashCommandBuilder().setName("verify").setDescription("Verify Script").addStringOption(o=>o.setName("code").setRequired(true).setDescription("Code")),
    new SlashCommandBuilder().setName("getid").setDescription("Get Roblox ID").addStringOption(o=>o.setName("username").setRequired(true).setDescription("Username")),
    new SlashCommandBuilder().setName("linkroblox").setDescription("Link ID").addStringOption(o=>o.setName("roblox_id").setRequired(true).setDescription("ID")),
    new SlashCommandBuilder().setName("activeusers").setDescription("Active Users List"),
    new SlashCommandBuilder().setName("syncmissing").setDescription("Admin: Sync DB (Batch)"),
    new SlashCommandBuilder().setName("whoinvited").setDescription("Check inviter").addUserOption(o=>o.setName("user").setRequired(true).setDescription("User")),
    new SlashCommandBuilder().setName("leaderboard").setDescription("Invite Leaderboard"),
    new SlashCommandBuilder().setName("lookup").setDescription("Admin: Lookup").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")),
    new SlashCommandBuilder().setName("setexpiry").setDescription("Admin: Add Time").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")).addStringOption(o=>o.setName("duration").setRequired(true).setDescription("Time")),
    
    // ADMIN POLLS
    new SlashCommandBuilder().setName("poll").setDescription("Create Advanced Poll")
        .addStringOption(o => o.setName("q").setRequired(true).setDescription("Question"))
        .addStringOption(o => o.setName("o1").setRequired(true).setDescription("Option 1"))
        .addStringOption(o => o.setName("o2").setRequired(true).setDescription("Option 2"))
        .addStringOption(o => o.setName("o3").setDescription("Option 3"))
        .addStringOption(o => o.setName("o4").setDescription("Option 4"))
        .addStringOption(o => o.setName("o5").setDescription("Option 5"))
        .addRoleOption(o => o.setName("punish_role").setDescription("Role for non-voters")),
        
    new SlashCommandBuilder().setName("endpoll").setDescription("End Poll & Announce").addIntegerOption(o => o.setName("pollid").setRequired(true).setDescription("Poll ID")),
    new SlashCommandBuilder().setName("pollresults").setDescription("Detailed Results").addIntegerOption(o => o.setName("pollid").setDescription("ID")),

    // RULES
    new SlashCommandBuilder().setName("rules").setDescription("Rule System")
        .addSubcommand(s => s.setName("set").setDescription("Set Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")).addStringOption(o => o.setName("duration").setRequired(true).setDescription("Time")))
        .addSubcommand(s => s.setName("remove").setDescription("Remove Rule").addRoleOption(o => o.setName("role").setRequired(true).setDescription("Role")))
        .addSubcommand(s => s.setName("list").setDescription("List Rules")),

    // CONFIG
    new SlashCommandBuilder().setName("config").setDescription("Config")
        .addSubcommand(s=>s.setName("addreward").setDescription("Add Invite Reward").addIntegerOption(o=>o.setName("invites").setRequired(true).setDescription("Count")).addRoleOption(o=>o.setName("role").setRequired(true).setDescription("Role")))
        .addSubcommand(s=>s.setName("setpunish").setDescription("Ping Timeout").addStringOption(o=>o.setName("duration").setRequired(true).setDescription("Time")))

].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

// INTERACTION HANDLER
client.on("interactionCreate", async interaction => {
    try {
        if (interaction.customId?.startsWith('sync_')) { await handleBatchSync(interaction); return; }
        
        // 🔥 LIVE POLL VOTE (Hidden Count Update)
        if (interaction.isButton() && interaction.customId.startsWith('vote_')) {
            const [_, pid, ch] = interaction.customId.split('_');
            await interaction.deferReply({ ephemeral: true });
            
            // Upsert Vote
            await supabase.from("poll_votes").upsert({ poll_id: parseInt(pid), user_id: interaction.user.id, choice: parseInt(ch) });
            
            // Get Total Count ONLY
            const { count } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pid);
            
            // Update Message Footer
            const oldEmbed = interaction.message.embeds[0];
            const newEmbed = EmbedBuilder.from(oldEmbed).setFooter({ text: `Developed By Subhu Jaat • Live Votes: ${count || 1}` });
            
            await interaction.message.edit({ embeds: [newEmbed] });
            return interaction.editReply("✅ Vote Recorded!");
        }

        if (!interaction.isChatInputCommand()) return;

        // Command Routing
        if (interaction.commandName === "verify") {
            await interaction.deferReply();
            await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (opts) => interaction.editReply(opts));
        }
        if (interaction.commandName === "getid") await handleGetRobloxId(interaction);
        if (interaction.commandName === "linkroblox") await handleLinkRoblox(interaction);
        if (interaction.commandName === "activeusers") await handleActiveUsers(interaction);
        if (interaction.commandName === "rules") await handleRules(interaction);
        if (interaction.commandName === "syncmissing") { await interaction.deferReply({ ephemeral: true }); await showBatchSync(interaction); }
        if (interaction.commandName === "leaderboard") await handleLeaderboard(interaction);
        if (interaction.commandName === "whoinvited") await handleWhoInvited(interaction);
        if (interaction.commandName === "config" && interaction.options.getSubcommand() === "addreward") await handleAddReward(interaction);
        if (interaction.commandName === "lookup") await handleLookup(interaction);

        // SET EXPIRY
        if (interaction.commandName === "setexpiry") {
            if(!await isAdmin(interaction.user.id)) return interaction.reply("❌ Admin Only");
            await interaction.deferReply();
            const ms = parseDuration(interaction.options.getString("duration"));
            const target = interaction.options.getString("target");
            const expiry = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString();
            await supabase.from("verifications").update({ verified: true, expires_at: expiry }).or(`code.eq.${target},hwid.eq.${target}`);
            return interaction.editReply(`✅ Updated ${target}`);
        }

        // --- POLL SYSTEM ---
        if (interaction.commandName === "poll") {
            if(!await isAdmin(interaction.user.id)) return interaction.reply("❌ Admin");
            const q = interaction.options.getString("q");
            const opts = [1,2,3,4,5].map(i => interaction.options.getString(`o${i}`)).filter(o=>o);
            const pRole = interaction.options.getRole("punish_role");
            
            // Note: Add 'punish_role_id' to supabase 'polls' table manually if using this
            const {data} = await supabase.from("polls").insert({ question: q, option1: opts[0], option2: opts[1]||"", is_active: true, channel_id: interaction.channel.id }).select().single();
            
            // Store punishment role in separate map or update schema if table exists
            if(pRole) await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, [`poll_${data.id}_role`]: pRole.id });

            const embed = createEmbed(`📊 Poll #${data.id}`, `**${q}**\n` + opts.map((o,i)=>`**${i+1}️⃣** ${o}`).join('\n') + `\n\n⚠️ **Warning:** Non-voters will get ${pRole ? pRole : "punished"}!`, 0xFFA500);
            const row = new ActionRowBuilder().addComponents(opts.map((_,i)=>new ButtonBuilder().setCustomId(`vote_${data.id}_${i+1}`).setLabel(`${i+1}`).setStyle(ButtonStyle.Primary)));
            
            const msg = await interaction.channel.send({ content: "@everyone", embeds: [embed], components: [row] });
            return interaction.reply({content:"✅ Poll Started", ephemeral:true});
        }

        if (interaction.commandName === "endpoll") {
            await interaction.deferReply();
            const pid = interaction.options.getInteger("pollid");
            
            // 1. Deactivate
            await supabase.from("polls").update({ is_active: false }).eq("id", pid);
            
            // 2. Calc Results
            const { data: votes } = await supabase.from("poll_votes").select("user_id, choice").eq("poll_id", pid);
            const voters = new Set(votes.map(v => v.user_id));
            
            // 3. Punish Non-Voters
            const members = await interaction.guild.members.fetch();
            let punishedCount = 0;
            // Fetch stored role from config or assume manual setup
            const { data: conf } = await supabase.from("guild_config").select(`poll_${pid}_role`).eq("guild_id", interaction.guild.id).maybeSingle();
            const roleId = conf ? conf[`poll_${pid}_role`] : null;

            if (roleId) {
                const role = interaction.guild.roles.cache.get(roleId);
                if (role) {
                    members.forEach(async m => {
                        if (!m.user.bot && !voters.has(m.id)) {
                            await m.roles.add(role).catch(()=>{});
                            punishedCount++;
                        }
                    });
                }
            }

            return interaction.editReply({ embeds: [createEmbed(`🛑 Poll #${pid} Ended`, `**Votes:** ${votes.length}\n**Punished:** ${punishedCount} users\n\nUse \`/pollresults ${pid}\` for details.`, 0xFF0000)] });
        }

        if (interaction.commandName === "pollresults") {
            await interaction.deferReply();
            const pid = interaction.options.getInteger("pollid");
            const { data: poll } = await supabase.from("polls").select("*").eq("id", pid).maybeSingle();
            if(!poll) return interaction.editReply("❌ Not Found");
            
            const { data: votes } = await supabase.from("poll_votes").select("user_id, choice").eq("poll_id", pid);
            let desc = `**Q: ${poll.question}**\n\n`;
            
            const options = [poll.option1, poll.option2, poll.option3, poll.option4, poll.option5].filter(o=>o);
            options.forEach((opt, i) => {
                const idx = i+1;
                const vList = votes.filter(v=>v.choice===idx);
                const names = vList.map(v=>`<@${v.user_id}>`).join(", ");
                desc += `**${idx}. ${opt} (${vList.length}):**\n${names || "No votes"}\n\n`;
            });
            return interaction.editReply({ embeds: [createEmbed(`📊 Detailed Results #${pid}`, desc, 0x00FFFF)] });
        }

    } catch (e) { console.error(e); }
});

client.on("guildMemberAdd", trackJoin);
client.login(process.env.DISCORD_BOT_TOKEN);
