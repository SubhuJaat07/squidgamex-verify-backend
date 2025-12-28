const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits, Partials, Collection, Routes, REST, SlashCommandBuilder } = require("discord.js");
const { SETTINGS, supabase, isAdmin, createEmbed, safeReply, parseDuration } = require("./config");
const { processVerification, handleLookup, handleCheckAlts } = require("./verification");
const { checkNextMissingUser, handleSyncInteraction } = require("./invite");

const app = express();
app.use(cors());
app.use(express.json());

// API
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
app.listen(SETTINGS.PORT, () => console.log(`🚀 Port: ${SETTINGS.PORT}`));

// CLIENT
const client = new Client({
    intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildInvites ],
    partials: [Partials.GuildMember, Partials.Channel]
});

// COMMANDS
const commands = [
    new SlashCommandBuilder().setName("verify").setDescription("Verify").addStringOption(o=>o.setName("code").setRequired(true).setDescription("Code")),
    new SlashCommandBuilder().setName("lookup").setDescription("Admin: Lookup").addStringOption(o=>o.setName("target").setRequired(true).setDescription("Code/HWID")),
    new SlashCommandBuilder().setName("syncmissing").setDescription("Admin: Manual Sync"),
    new SlashCommandBuilder().setName("checkalts").setDescription("Admin: Check Alts"),
    new SlashCommandBuilder().setName("redeem").setDescription("Redeem").addStringOption(o=>o.setName("key").setRequired(true).setDescription("Key")),
    new SlashCommandBuilder().setName("activeusers").setDescription("Active Users"), // Added Missing
].map(c => c.toJSON());

client.once("ready", async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);
    try { await rest.put(Routes.applicationGuildCommands(client.user.id, SETTINGS.GUILD_ID), { body: commands }); } catch(e) { console.error(e); }
});

// 🔥 FIXED TEXT COMMAND LOGIC
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    
    const content = message.content.trim();
    const args = content.split(/\s+/);
    const cmd = args[0].toLowerCase();

    // CHECK: Is this the verify command?
    if (cmd === "verify") {
        // ALLOW IF: User is Admin OR Message is in Verify Channel
        const isUserAdmin = await isAdmin(message.author.id);
        const inVerifyChannel = message.channel.id === SETTINGS.VERIFY_CHANNEL_ID;

        if (isUserAdmin || inVerifyChannel) {
            if (args.length < 2) {
                const r = await message.reply("❌ **Usage:** `verify 123456`");
                setTimeout(() => r.delete().catch(()=>{}), 5000);
                return;
            }
            await processVerification(message.author, args[1], message.guild, (opts) => message.reply(opts));
            return; 
        }
    }

    // CHAT LOCK: Delete other messages in verify channel (Except Admins)
    if (message.channel.id === SETTINGS.VERIFY_CHANNEL_ID) {
        if (!await isAdmin(message.author.id)) {
            try { await message.delete(); } catch (e) {} 
        }
    }
});

// INTERACTION HANDLER
client.on("interactionCreate", async interaction => {
    try {
        // SYNC HANDLER (Delegated to invite.js)
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
            // Start the loop from invite.js
            await checkNextMissingUser(interaction);
        }
        // ... Add Redeem Logic Back if needed here or in verification.js

    } catch (e) { console.error(e); }
});

client.login(process.env.DISCORD_BOT_TOKEN);

