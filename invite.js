const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Collection, Routes, REST, SlashCommandBuilder } = require("discord.js");
const { SETTINGS, supabase, isAdmin, createEmbed, safeReply, parseDuration } = require("./config");
const { processVerification, handleLookup, handleCheckAlts } = require("./verification");
const { checkNextMissingUser, handleSyncInteraction, trackJoin } = require("./invite");

const app = express();
app.use(cors());
app.use(express.json());

// API FOR SCRIPT
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

// DISCORD CLIENT
const client = new Client({
    intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites ],
    partials: [Partials.GuildMember, Partials.Channel]
});

// COMMANDS REGISTRATION
const commands = [
    new SlashCommandBuilder().setName("verify").setDescription("Verify").addStringOption(o=>o.setName("code").setRequired(true).setDescription("Code")),
    new SlashCommandBuilder().setName("lookup").setDescription("Admin: Lookup").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")),
    new SlashCommandBuilder().setName("syncmissing").setDescription("Admin: Manual Sync"),
    new SlashCommandBuilder().setName("checkalts").setDescription("Admin: Check Alts"),
    new SlashCommandBuilder().setName("redeem").setDescription("Redeem Key").addStringOption(o=>o.setName("key").setRequired(true).setDescription("Key")),
    // Add other commands as needed...
].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

// 🔥 TEXT COMMAND FIX (VERIFY)
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    const isCmd = message.content.trim().toLowerCase().startsWith("verify");

    if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID) {
        // CHANNEL ME: Allow everyone ONLY for verify command
        if (isCmd) {
            const args = message.content.split(/\s+/);
            if(args.length < 2) return message.reply("❌ Usage: `verify 123456`").then(m=>setTimeout(()=>m.delete(),5000));
            await processVerification(message.author, args[1], message.guild, (opts) => message.reply(opts));
        } else if (!await isAdmin(message.author.id)) {
            // Not admin? Delete useless chat
            message.delete().catch(()=>{});
        }
    } else {
        // CHANNEL BAHAR: Only Admin can verify
        if (isCmd && await isAdmin(message.author.id)) {
            const args = message.content.split(/\s+/);
            await processVerification(message.author, args[1], message.guild, (opts) => message.reply(opts));
        }
    }
});

// 🔥 INTERACTION HANDLER
client.on("interactionCreate", async interaction => {
    try {
        // SYNC INTERACTION (LOOP FIX)
        if (interaction.customId === 'sync_select_inviter' || interaction.customId === 'sync_user_left') {
            await handleSyncInteraction(interaction);
            return;
        }

        // COPY BUTTON
        if (interaction.isButton() && interaction.customId.startsWith('copy_')) {
            await interaction.deferReply({ ephemeral: true });
            const [_, code] = interaction.customId.split('_');
            const { data } = await supabase.from("verifications").select("*").eq("code", code).maybeSingle();
            if(!data) return interaction.editReply("❌ Data not found.");
            return interaction.editReply(`**Code:** \`${data.code}\`\n**HWID:** \`${data.hwid}\``);
        }

        if (!interaction.isChatInputCommand()) return;

        // SLASH COMMANDS
        if (interaction.commandName === "verify") {
            await interaction.deferReply();
            await processVerification(interaction.user, interaction.options.getString("code"), interaction.guild, (opts) => interaction.editReply(opts));
        }
        if (interaction.commandName === "lookup") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin", ephemeral: true });
            await handleLookup(interaction);
        }
        if (interaction.commandName === "checkalts") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin", ephemeral: true });
            await handleCheckAlts(interaction);
        }
        if (interaction.commandName === "syncmissing") {
            if (!await isAdmin(interaction.user.id)) return safeReply(interaction, { content: "❌ Admin", ephemeral: true });
            await interaction.deferReply({ ephemeral: true });
            await checkNextMissingUser(interaction); // Starts the loop
        }
        if (interaction.commandName === "redeem") {
            await interaction.deferReply({ ephemeral: true });
            const key = interaction.options.getString("key");
            // Add Redeem Logic directly or move to verify.js
            const { data: gift } = await supabase.from("gift_keys").select("*").eq("code", key).eq("is_redeemed", false).maybeSingle();
            if (!gift) return interaction.editReply("❌ Invalid");
            const ms = parseDuration(gift.duration);
            const { data: u } = await supabase.from("verifications").select("*").eq("discord_id", interaction.user.id).limit(1).maybeSingle();
            if (!u) return interaction.editReply("❌ Verify first");
            let ce = new Date(u.expires_at).getTime(); if(ce<Date.now())ce=Date.now();
            const nd = ms==="LIFETIME"?new Date(Date.now()+3153600000000).toISOString():new Date(ce+ms).toISOString();
            await supabase.from("verifications").update({verified:true,expires_at:nd}).eq("id",u.id);
            await supabase.from("gift_keys").update({is_redeemed:true}).eq("id",gift.id);
            return interaction.editReply(`✅ Redeemed ${gift.duration}`);
        }

    } catch (e) { console.error(e); }
});

client.on("guildMemberAdd", trackJoin);
client.login(process.env.DISCORD_BOT_TOKEN);
