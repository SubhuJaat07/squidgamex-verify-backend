const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Routes, REST, SlashCommandBuilder, PermissionsBitField, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");
const { SETTINGS, supabase, isAdmin, createEmbed, parseDuration, logToWebhook } = require("./config");
const { processVerification, handleWhitelist, handleRules, handleActiveUsers, handleGetRobloxId, handleLinkRoblox, handleSetCode, handleSetExpiry, handleCheckAlts, handleLookup, handleBanSystem } = require("./verification");
const { handleWelcome, handleRewards, trackJoin, showBatchSync, handleBatchSync, handleLeaderboard, handleWhoInvited } = require("./invite");

const app = express();
app.use(cors());
app.use(express.json());

// API
app.get("/", (req, res) => res.send("System Online 🟢"));
app.get("/check", async (req, res) => {
    const { hwid } = req.query;
    if(!hwid) return res.json({status:"ERROR"});
    const { data } = await supabase.from("verifications").select("*").eq("hwid", hwid).maybeSingle();
    if(data && data.verified && new Date(data.expires_at) > new Date()) return res.json({status:"VALID"});
    const code = Math.floor(100000+Math.random()*900000).toString();
    await supabase.from("verifications").insert([{hwid, code}]);
    return res.json({status:"NEED_VERIFY", code});
});
app.listen(SETTINGS.PORT, () => console.log(`🚀 Port: ${SETTINGS.PORT}`));

const client = new Client({ intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites ], partials: [Partials.GuildMember, Partials.Channel] });

// 🔥 ALL COMMANDS (CHECKED & FIXED)
const commands = [
    // 1. WHITELIST
    new SlashCommandBuilder().setName("whitelist").setDescription("Manage Anti-Ping")
        .addSubcommand(s => s.setName("add").setDescription("Whitelist a user/role").addUserOption(o=>o.setName("user").setDescription("User")).addRoleOption(o=>o.setName("role").setDescription("Role")))
        .addSubcommand(s => s.setName("remove").setDescription("Remove from whitelist").addUserOption(o=>o.setName("user").setDescription("User")).addRoleOption(o=>o.setName("role").setDescription("Role")))
        .addSubcommand(s => s.setName("list").setDescription("View whitelist")),

    // 2. WELCOME
    new SlashCommandBuilder().setName("welcome").setDescription("Welcome System")
        .addSubcommand(s => s.setName("channel").setDescription("Set channel").addChannelOption(o=>o.setName("target").setDescription("Channel").setRequired(true)))
        .addSubcommand(s => s.setName("message").setDescription("Set message").addStringOption(o=>o.setName("title").setDescription("Title").setRequired(true)).addStringOption(o=>o.setName("description").setDescription("Desc").setRequired(true)))
        .addSubcommand(s => s.setName("toggle").setDescription("On/Off").addStringOption(o=>o.setName("state").setDescription("State").setRequired(true).addChoices({name:'On',value:'on'},{name:'Off',value:'off'})))
        .addSubcommand(s => s.setName("test").setDescription("Test welcome")),

    // 3. REWARDS
    new SlashCommandBuilder().setName("rewards").setDescription("Invite Rewards")
        .addSubcommand(s => s.setName("add").setDescription("Add Reward").addIntegerOption(o=>o.setName("invites").setDescription("Num").setRequired(true)).addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)))
        .addSubcommand(s => s.setName("remove").setDescription("Remove Reward").addIntegerOption(o=>o.setName("id").setDescription("ID").setRequired(true)))
        .addSubcommand(s => s.setName("list").setDescription("List Rewards")),

    // 4. RULES
    new SlashCommandBuilder().setName("rules").setDescription("Verification Rules")
        .addSubcommand(s=>s.setName("set").setDescription("Set Rule").addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)).addStringOption(o=>o.setName("duration").setDescription("Time").setRequired(true)))
        .addSubcommand(s=>s.setName("remove").setDescription("Remove Rule").addRoleOption(o=>o.setName("role").setDescription("Role").setRequired(true)))
        .addSubcommand(s=>s.setName("list").setDescription("List Rules")),

    // 5. BAN SYSTEM
    new SlashCommandBuilder().setName("bansystem").setDescription("Ban Manage")
        .addSubcommand(s=>s.setName("ban").setDescription("Ban").addStringOption(o=>o.setName("target").setDescription("Code/HWID").setRequired(true)))
        .addSubcommand(s=>s.setName("unban").setDescription("Unban").addStringOption(o=>o.setName("target").setDescription("Code/HWID").setRequired(true)))
        .addSubcommand(s=>s.setName("list").setDescription("List")),

    // 6. POLLS
    new SlashCommandBuilder().setName("poll").setDescription("Create Poll").addStringOption(o=>o.setName("q").setDescription("Question").setRequired(true)).addStringOption(o=>o.setName("o1").setDescription("Opt1").setRequired(true)).addStringOption(o=>o.setName("o2").setDescription("Opt2").setRequired(true)).addBooleanOption(o=>o.setName("multi").setDescription("Multi")),
    new SlashCommandBuilder().setName("endpoll").setDescription("End Poll").addIntegerOption(o=>o.setName("id").setDescription("Poll ID").setRequired(true)),

    // 7. OTHERS
    new SlashCommandBuilder().setName("verify").setDescription("Verify Key").addStringOption(o=>o.setName("code").setDescription("Code").setRequired(true)),
    new SlashCommandBuilder().setName("activeusers").setDescription("Active Keys"),
    new SlashCommandBuilder().setName("syncmissing").setDescription("Sync DB"),
    new SlashCommandBuilder().setName("getid").setDescription("Get Roblox ID").addStringOption(o=>o.setName("username").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("linkroblox").setDescription("Link ID").addStringOption(o=>o.setName("roblox_id").setDescription("ID").setRequired(true)),
    new SlashCommandBuilder().setName("setcode").setDescription("Custom Code").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)).addStringOption(o=>o.setName("code").setDescription("Code").setRequired(true)),
    new SlashCommandBuilder().setName("leaderboard").setDescription("Invite Leaderboard"),
    new SlashCommandBuilder().setName("whoinvited").setDescription("Check Inviter").addUserOption(o=>o.setName("user").setDescription("User").setRequired(true)),
    new SlashCommandBuilder().setName("setexpiry").setDescription("Set Time").addStringOption(o=>o.setName("target").setDescription("Target").setRequired(true)).addStringOption(o=>o.setName("duration").setDescription("Time").setRequired(true)).addStringOption(o=>o.setName("note").setDescription("Note")),
    new SlashCommandBuilder().setName("lookup").setDescription("Lookup User").addStringOption(o=>o.setName("target").setDescription("Target").setRequired(true)),
    new SlashCommandBuilder().setName("checkalts").setDescription("Check Alts"),
    
    // Config
    new SlashCommandBuilder().setName("config").setDescription("Config").addSubcommand(s=>s.setName("pingpunish").setDescription("Ping Penalty").addStringOption(o=>o.setName("type").setDescription("role/timeout").setRequired(true).addChoices({name:'Role',value:'role'},{name:'Timeout',value:'timeout'})).addStringOption(o=>o.setName("value").setDescription("RoleID/Duration").setRequired(true)))

].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ Ready: ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

// 🔥 INTERACTION HANDLER
client.on("interactionCreate", async interaction => {
    try {
        if(interaction.customId?.startsWith("sync_")) { await handleBatchSync(interaction); return; }
        if(interaction.isButton() && interaction.customId.startsWith('vote_')) {
            const [_, pid, ch] = interaction.customId.split('_');
            await interaction.deferReply({ephemeral:true});
            await supabase.from("poll_votes").upsert({poll_id: pid, user_id: interaction.user.id, choice: ch});
            const {count} = await supabase.from("poll_votes").select("*", {count:'exact', head:true}).eq("poll_id", pid);
            const embed = EmbedBuilder.from(interaction.message.embeds[0]).setFooter({text:`Votes: ${count}`});
            await interaction.message.edit({embeds:[embed]});
            return interaction.editReply("✅ Voted");
        }

        if(!interaction.isChatInputCommand()) return;

        // Routing
        if(interaction.commandName === "whitelist") await handleWhitelist(interaction);
        else if(interaction.commandName === "welcome") await handleWelcome(interaction);
        else if(interaction.commandName === "rewards") await handleRewards(interaction);
        else if(interaction.commandName === "rules") await handleRules(interaction);
        else if(interaction.commandName === "bansystem") await handleBanSystem(interaction);
        else if(interaction.commandName === "leaderboard") await handleLeaderboard(interaction);
        else if(interaction.commandName === "whoinvited") await handleWhoInvited(interaction);
        else if(interaction.commandName === "setexpiry") await handleSetExpiry(interaction);
        else if(interaction.commandName === "lookup") await handleLookup(interaction);
        else if(interaction.commandName === "checkalts") await handleCheckAlts(interaction);
        else if(interaction.commandName === "verify") { await interaction.deferReply(); await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (o)=>interaction.editReply(o)); }
        else if(interaction.commandName === "activeusers") await handleActiveUsers(interaction);
        else if(interaction.commandName === "syncmissing") { await interaction.deferReply({ephemeral:true}); await showBatchSync(interaction); }
        else if(interaction.commandName === "getid") await handleGetRobloxId(interaction);
        else if(interaction.commandName === "linkroblox") await handleLinkRoblox(interaction);
        else if(interaction.commandName === "setcode") await handleSetCode(interaction);
        
        // Poll Logic
        else if(interaction.commandName === "poll") {
            const q = interaction.options.getString("q"); const o1 = interaction.options.getString("o1"); const o2 = interaction.options.getString("o2");
            const {data} = await supabase.from("polls").insert({question:q, option1:o1, option2:o2, is_active:true}).select().single();
            const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`vote_${data.id}_1`).setLabel(o1).setStyle(ButtonStyle.Primary), new ButtonBuilder().setCustomId(`vote_${data.id}_2`).setLabel(o2).setStyle(ButtonStyle.Primary));
            await interaction.channel.send({embeds:[createEmbed(`📊 Poll #${data.id}`, `**${q}**`, SETTINGS.COLOR_WARN)], components:[row]});
            interaction.reply({content:"✅ Started", ephemeral:true});
        }
        else if(interaction.commandName === "endpoll") {
            const id = interaction.options.getInteger("id");
            await supabase.from("polls").update({is_active:false}).eq("id", id);
            interaction.reply(`🛑 Poll #${id} Ended`);
        }
        else if(interaction.commandName === "config") {
            const type = interaction.options.getString("type");
            const val = interaction.options.getString("value");
            if(type==='role') await supabase.from("guild_config").upsert({guild_id:interaction.guild.id, ping_punish_role:val});
            else await supabase.from("guild_config").upsert({guild_id:interaction.guild.id, ping_timeout_ms:parseDuration(val)});
            interaction.reply("✅ Config Updated");
        }

    } catch(e) { console.error(e); }
});

client.login(process.env.DISCORD_BOT_TOKEN);
