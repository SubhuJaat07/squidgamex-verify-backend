const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Routes, REST, SlashCommandBuilder, PermissionsBitField, EmbedBuilder } = require("discord.js");
const { SETTINGS, supabase, isAdmin, createEmbed, parseDuration, logToWebhook } = require("./config");
const { processVerification, handleGetRobloxId, handleLinkRoblox, handleActiveUsers, handleSetCode, handleBanSystem, handleRules, handleLookup, handleSetExpiry, handleCheckAlts } = require("./verification");
const { handleWhitelist, handleWelcome, handleRewards, trackJoin, showBatchSync, handleBatchSync, handleLeaderboard } = require("./invite");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => res.send("System Online 🟢"));
app.get("/check", async (req, res) => {
    if (SETTINGS.MAINTENANCE) return res.json({ status: "ERROR", message: "Maintenance" });
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

const client = new Client({ intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites, GatewayIntentBits.GuildModeration ], partials: [Partials.GuildMember, Partials.Channel] });

// 🔥 COMMANDS REGISTRATION
const commands = [
    // 1. PUBLIC COMMANDS
    new SlashCommandBuilder().setName("verify").setDescription("Verify Script").addStringOption(o=>o.setName("code").setDescription("Code").setRequired(true)),
    new SlashCommandBuilder().setName("getid").setDescription("Get Roblox ID").addStringOption(o=>o.setName("username").setDescription("Username").setRequired(true)),
    new SlashCommandBuilder().setName("linkroblox").setDescription("Link ID").addStringOption(o=>o.setName("roblox_id").setDescription("ID").setRequired(true)),
    new SlashCommandBuilder().setName("leaderboard").setDescription("Invite Leaderboard"),

    // 2. ADMIN TOOLS (RESTORED)
    new SlashCommandBuilder().setName("admin").setDescription("Admin Tools")
        .addSubcommand(s => s.setName("say").setDescription("Bot Speaks").addStringOption(o=>o.setName("message").setDescription("Text").setRequired(true)).addChannelOption(o=>o.setName("channel").setDescription("Channel")))
        .addSubcommand(s => s.setName("announce").setDescription("Send Embed").addStringOption(o=>o.setName("title").setDescription("Title").setRequired(true)).addStringOption(o=>o.setName("message").setDescription("Desc").setRequired(true)).addChannelOption(o=>o.setName("channel").setDescription("Channel")).addStringOption(o=>o.setName("image").setDescription("Image URL")))
        .addSubcommand(s => s.setName("dm").setDescription("DM User").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)).addStringOption(o=>o.setName("message").setDescription("Message").setRequired(true))),

    // 3. SECURITY & CONFIG (ADMIN ONLY)
    new SlashCommandBuilder().setName("whitelist").setDescription("Anti-Ping Whitelist")
        .addStringOption(o => o.setName("action").setDescription("Action").setRequired(true).addChoices({name:'Add',value:'add'}, {name:'Remove',value:'remove'}, {name:'List',value:'list'}))
        .addUserOption(o => o.setName("user").setDescription("User"))
        .addRoleOption(o => o.setName("role").setDescription("Role")),

    new SlashCommandBuilder().setName("welcome").setDescription("Welcome System")
        .addSubcommand(s => s.setName("channel").setDescription("Set Channel").addChannelOption(o=>o.setName("target").setDescription("Channel").setRequired(true)))
        .addSubcommand(s => s.setName("message").setDescription("Set Message").addStringOption(o=>o.setName("title").setDescription("Title").setRequired(true)).addStringOption(o=>o.setName("description").setDescription("Use {user}, {count}, {inviter}").setRequired(true)))
        .addSubcommand(s => s.setName("toggle").setDescription("On/Off").addStringOption(o=>o.setName("state").setDescription("State").setRequired(true).addChoices({name:'On',value:'on'},{name:'Off',value:'off'})))
        .addSubcommand(s => s.setName("test").setDescription("Test Message")),

    new SlashCommandBuilder().setName("poll").setDescription("Create Poll")
        .addStringOption(o => o.setName("q").setDescription("Question").setRequired(true))
        .addStringOption(o => o.setName("o1").setDescription("Option 1").setRequired(true))
        .addStringOption(o => o.setName("o2").setDescription("Option 2").setRequired(true))
        .addStringOption(o => o.setName("o3").setDescription("Option 3"))
        .addStringOption(o => o.setName("o4").setDescription("Option 4"))
        .addStringOption(o => o.setName("o5").setDescription("Option 5"))
        .addRoleOption(o => o.setName("punish_role").setDescription("Role for non-voters"))
        .addBooleanOption(o => o.setName("multiple").setDescription("Allow Multi Vote")),
    
    new SlashCommandBuilder().setName("endpoll").setDescription("End Poll").addIntegerOption(o => o.setName("id").setDescription("Poll ID").setRequired(true)).addStringOption(o => o.setName("duration").setDescription("Punish Time (e.g. 2d)")),
    new SlashCommandBuilder().setName("pollresults").setDescription("Results").addIntegerOption(o => o.setName("pollid").setDescription("ID")),

    new SlashCommandBuilder().setName("rewards").setDescription("Invite Rewards")
        .addSubcommand(s => s.setName("add").setDescription("Add").addIntegerOption(o=>o.setName("invites").setDescription("Count").setRequired(true)).addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)))
        .addSubcommand(s => s.setName("remove").setDescription("Remove").addIntegerOption(o=>o.setName("id").setDescription("ID").setRequired(true)))
        .addSubcommand(s => s.setName("list").setDescription("List")),

    new SlashCommandBuilder().setName("bansystem").setDescription("Ban System").addSubcommand(s=>s.setName("ban").setDescription("Ban").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Target"))).addSubcommand(s=>s.setName("unban").setDescription("Unban").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Target"))).addSubcommand(s=>s.setName("list").setDescription("List")),
    new SlashCommandBuilder().setName("rules").setDescription("Rule System").addSubcommand(s=>s.setName("set").setDescription("Set").addRoleOption(o=>o.setName("role").setRequired(true).setDescription("Role")).addStringOption(o=>o.setName("duration").setRequired(true).setDescription("Time"))).addSubcommand(s=>s.setName("remove").setDescription("Remove").addRoleOption(o=>o.setName("role").setRequired(true).setDescription("Role"))).addSubcommand(s=>s.setName("list").setDescription("List")),
    
    new SlashCommandBuilder().setName("setcode").setDescription("Set Custom Code").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)).addStringOption(o=>o.setName("code").setDescription("Code").setRequired(true)),
    new SlashCommandBuilder().setName("activeusers").setDescription("Active Keys"),
    new SlashCommandBuilder().setName("checkalts").setDescription("Check Alts"),
    new SlashCommandBuilder().setName("syncmissing").setDescription("Sync Invites"),
    new SlashCommandBuilder().setName("lookup").setDescription("Lookup").addStringOption(o=>o.setName("target").setDescription("Code/HWID").setRequired(true)),
    new SlashCommandBuilder().setName("setexpiry").setDescription("Set Expiry").addStringOption(o=>o.setName("target").setDescription("Target").setRequired(true)).addStringOption(o=>o.setName("duration").setDescription("Time").setRequired(true)).addStringOption(o=>o.setName("note").setDescription("Note")),
    
    new SlashCommandBuilder().setName("config").setDescription("Config").addSubcommand(s=>s.setName("pingpunish").setDescription("Anti-Ping").addStringOption(o=>o.setName("type").setDescription("role/timeout").setRequired(true).addChoices({name:'Role',value:'role'},{name:'Timeout',value:'timeout'})).addStringOption(o=>o.setName("value").setDescription("Value").setRequired(true)))

].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ ${client.user.tag} Ready`);
    try { await new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN).put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

client.on("interactionCreate", async interaction => {
    // 1. Handle Buttons/Menus
    if(interaction.customId?.startsWith("sync_")) { await handleBatchSync(interaction); return; }
    if(interaction.customId?.startsWith("active_")) { const p = parseInt(interaction.customId.split('_')[2]); await handleActiveUsers(interaction, p); return; }
    
    // Poll Vote Button
    if(interaction.isButton() && interaction.customId.startsWith('vote_')) {
        const [_, pid, ch] = interaction.customId.split('_');
        const pollId = parseInt(pid);
        await interaction.deferReply({ ephemeral: true });
        const { data: poll } = await supabase.from("polls").select("*").eq("id", pollId).single();
        if (!poll.is_active) return interaction.editReply("❌ Ended!");
        if (!poll.allow_multiple) await supabase.from("poll_votes").delete().eq("poll_id", pollId).eq("user_id", interaction.user.id);
        await supabase.from("poll_votes").upsert({ poll_id: pollId, user_id: interaction.user.id, choice: parseInt(ch) });
        const { count } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId);
        const embed = EmbedBuilder.from(interaction.message.embeds[0]).setFooter({ text: `Live Votes: ${count}`, iconURL: SETTINGS.FOOTER_ICON });
        await interaction.message.edit({ embeds: [embed] });
        return interaction.editReply("✅ Voted!");
    }

    if(!interaction.isChatInputCommand()) return;

    // 2. PUBLIC COMMANDS (No Admin Check)
    if(interaction.commandName === "verify") { await interaction.deferReply(); await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (o)=>interaction.editReply(o)); return; }
    if(interaction.commandName === "getid") { await handleGetRobloxId(interaction); return; }
    if(interaction.commandName === "linkroblox") { await handleLinkRoblox(interaction); return; }
    if(interaction.commandName === "leaderboard") { await handleLeaderboard(interaction); return; }

    // 3. 🛡️ ADMIN CHECK FOR EVERYTHING ELSE
    if (!await isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ **Access Denied:** Admin only.", ephemeral: true });

    // 4. ADMIN ROUTING
    if(interaction.commandName === "whitelist") await handleWhitelist(interaction);
    else if(interaction.commandName === "welcome") await handleWelcome(interaction);
    else if(interaction.commandName === "rewards") await handleRewards(interaction);
    else if(interaction.commandName === "syncmissing") { await interaction.deferReply({ephemeral:true}); await showBatchSync(interaction); }
    else if(interaction.commandName === "activeusers") await handleActiveUsers(interaction);
    else if(interaction.commandName === "setcode") await handleSetCode(interaction);
    else if(interaction.commandName === "bansystem") await handleBanSystem(interaction);
    else if(interaction.commandName === "rules") await handleRules(interaction);
    else if(interaction.commandName === "lookup") await handleLookup(interaction);
    else if(interaction.commandName === "setexpiry") await handleSetExpiry(interaction);
    else if(interaction.commandName === "checkalts") await handleCheckAlts(interaction);
    
    // ADMIN TOOLS (Restored)
    else if(interaction.commandName === "admin") {
        const sub = interaction.options.getSubcommand();
        const ch = interaction.options.getChannel("channel") || interaction.channel;
        
        if(sub === "say") {
            await ch.send(interaction.options.getString("message"));
            interaction.reply({content:"✅ Sent", ephemeral:true});
        }
        if(sub === "announce") {
            const embed = createEmbed(interaction.options.getString("title"), interaction.options.getString("message"), 0xFFD700);
            if(interaction.options.getString("image")) embed.setImage(interaction.options.getString("image"));
            await ch.send({embeds:[embed]});
            interaction.reply({content:"✅ Announced", ephemeral:true});
        }
        if(sub === "dm") {
            const u = interaction.options.getUser("user");
            try { 
                await u.send(interaction.options.getString("message")); 
                interaction.reply({content:`✅ DM Sent to ${u.tag}`, ephemeral:true}); 
            } catch(e) { interaction.reply({content:"❌ DM Failed (User has DMs off)", ephemeral:true}); }
        }
    }

    // POLLS
    else if(interaction.commandName === "poll") {
        const q = interaction.options.getString("q");
        const opts = [1,2,3,4,5].map(i => interaction.options.getString(`o${i}`)).filter(o=>o);
        const pRole = interaction.options.getRole("punish_role");
        const multi = interaction.options.getBoolean("multiple") || false;
        const {data} = await supabase.from("polls").insert({ question: q, option1: opts[0], option2: opts[1]||"", option3: opts[2]||"", option4: opts[3]||"", option5: opts[4]||"", is_active: true, allow_multiple: multi, punish_role_id: pRole?.id, channel_id: interaction.channel.id }).select().single();
        const embed = createEmbed(`📊 Poll #${data.id}`, `**${q}**\n` + opts.map((o,i)=>`**${i+1}️⃣** ${o}`).join('\n') + `\n\n⚠️ **Non-voters:** ${pRole ? pRole : "None"}`, SETTINGS.COLOR_WARN);
        const row = new ActionRowBuilder().addComponents(opts.map((_,i)=>new ButtonBuilder().setCustomId(`vote_${data.id}_${i+1}`).setLabel(`${i+1}`).setStyle(ButtonStyle.Primary)));
        await interaction.channel.send({ content: "@everyone", embeds: [embed], components: [row] });
        return interaction.reply({content:"✅ Started", ephemeral:true});
    }
    else if(interaction.commandName === "endpoll") {
        await interaction.deferReply();
        const pid = interaction.options.getInteger("id");
        const dur = interaction.options.getString("duration") || "1d";
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
                    try { await m.send({embeds:[createEmbed("⚠️ Poll Punishment", `Missed Poll #${pid}. Role: ${role.name}, Duration: ${dur}`, SETTINGS.COLOR_ERROR)]}); } catch(e){}
                    count++;
                }
            }
        }
        logToWebhook("🛑 Poll Ended", `Poll #${pid}\nVotes: ${voters.size}\nPunished: ${count}`);
        return interaction.editReply({ embeds: [createEmbed(`🛑 Ended Poll #${pid}`, `Votes: ${voters.size}\nPunished: ${count}`, SETTINGS.COLOR_INFO)] });
    }
    else if(interaction.commandName === "pollresults") {
        await interaction.deferReply();
        const pid = interaction.options.getInteger("pollid");
        const { data: poll } = await supabase.from("polls").select("*").eq("id", pid).maybeSingle();
        if(!poll) return interaction.editReply("❌ Not Found");
        const { data: votes } = await supabase.from("poll_votes").select("user_id, choice").eq("poll_id", pid);
        let desc = `**Q: ${poll.question}**\n\n`;
        [poll.option1, poll.option2, poll.option3, poll.option4, poll.option5].filter(o=>o).forEach((opt, i) => {
            const vList = votes.filter(v=>v.choice===i+1);
            desc += `**${i+1}. ${opt} (${vList.length}):**\n${vList.map(v=>`<@${v.user_id}>`).join(", ") || "None"}\n\n`;
        });
        return interaction.editReply({ embeds: [createEmbed(`📊 Results #${pid}`, desc, SETTINGS.COLOR_INFO)] });
    }
    // CONFIG
    else if(interaction.commandName === "config") {
        const type = interaction.options.getString("type");
        const val = interaction.options.getString("value");
        if(type==='role') await supabase.from("guild_config").upsert({guild_id:interaction.guild.id, ping_punish_role:val});
        else await supabase.from("guild_config").upsert({guild_id:interaction.guild.id, ping_timeout_ms:parseDuration(val)});
        interaction.reply("✅ Updated");
    }
});

// ANTI-PING & TEXT VERIFY
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (message.mentions.users.has(SETTINGS.SUPER_OWNER_ID) && message.author.id !== SETTINGS.SUPER_OWNER_ID && !message.reference) {
        const { data } = await supabase.from("guild_config").select("*").eq("guild_id", message.guild.id).maybeSingle();
        if (data?.ping_whitelist?.includes(message.author.id)) return;
        if (message.member.moderatable) {
            if (data?.ping_punish_role) { await message.member.roles.add(data.ping_punish_role).catch(()=>{}); message.reply("⚠️ Role Penalty"); }
            else { await message.member.timeout(data?.ping_timeout_ms || SETTINGS.DEFAULT_PUNISH_MS, "Anti-Ping"); message.reply("⚠️ Timeout"); }
        }
    }
    if (message.content.toLowerCase().startsWith("verify ")) {
        if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID || await isAdmin(message.author.id)) {
            await processVerification(message.author, message.content.split(" ")[1], message.guild, (opts) => message.reply(opts));
        }
    }
});

client.login(process.env.DISCORD_BOT_TOKEN);
