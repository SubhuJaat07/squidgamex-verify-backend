const { ActionRowBuilder, UserSelectMenuBuilder } = require("discord.js");
const { supabase, createEmbed, SETTINGS, logToWebhook } = require("./config");

// 🔥 1. WHITELIST SYSTEM
async function handleWhitelist(interaction) {
    const sub = interaction.options.getSubcommand();
    const { data } = await supabase.from("guild_config").select("ping_whitelist").eq("guild_id", interaction.guild.id).single();
    let list = data?.ping_whitelist || [];

    if (sub === "add") {
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        if(user) list.push(user.id);
        if(role) list.push(role.id);
        await supabase.from("guild_config").upsert({ guild_id: interaction.guild.id, ping_whitelist: list });
        return interaction.reply({ embeds: [createEmbed("✅ Whitelist Updated", `Added: ${user || role}`, SETTINGS.COLOR_SUCCESS)] });
    }
    if (sub === "list") {
        return interaction.reply({ embeds: [createEmbed("🛡️ Whitelist", list.map(id => `<@&${id}> / <@${id}>`).join("\n") || "Empty", SETTINGS.COLOR_INFO)] });
    }
}

// 🔥 2. WELCOME SYSTEM
async function handleWelcome(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === "setchannel") {
        const ch = interaction.options.getChannel("channel");
        await supabase.from("guild_config").upsert({ guild_id: guildId, welcome_channel: ch.id, welcome_enabled: true });
        return interaction.reply(`✅ Welcome Channel Set: ${ch}`);
    }
    if (sub === "off") {
        await supabase.from("guild_config").update({ welcome_enabled: false }).eq("guild_id", guildId);
        return interaction.reply("🚫 Welcome Message Disabled");
    }
    // Add custom message set command if needed
}

// 🔥 3. REWARDS SYSTEM
async function handleRewards(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "add") {
        const invites = interaction.options.getInteger("invites");
        const role = interaction.options.getRole("role");
        await supabase.from("invite_rewards").insert({ guild_id: interaction.guild.id, invites_required: invites, role_id: role.id });
        return interaction.reply(`✅ Reward: **${invites} Invites** ➜ ${role}`);
    }
    if (sub === "list") {
        const { data } = await supabase.from("invite_rewards").select("*").eq("guild_id", interaction.guild.id);
        return interaction.reply({ embeds: [createEmbed("🎁 Rewards", data.map(r => `• **${r.invites_required}** ➜ <@&${r.role_id}>`).join("\n"), SETTINGS.COLOR_INFO)] });
    }
}

// 🔥 4. TRACK JOIN & WELCOME
async function trackJoin(member) {
    try {
        await supabase.from("joins").insert({ guild_id: member.guild.id, user_id: member.id, inviter_id: 'unknown', code: 'auto' });
        
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
        if (config?.welcome_enabled && config?.welcome_channel) {
            const ch = member.guild.channels.cache.get(config.welcome_channel);
            if (ch) {
                const embed = createEmbed("Welcome!", `Hello ${member}, welcome to **${member.guild.name}**!`, SETTINGS.COLOR_SUCCESS, member.user);
                ch.send({ embeds: [embed] });
            }
        }
    } catch(e) {}
}

// ... Batch Sync (Same as before) ...
module.exports = { handleWhitelist, handleWelcome, handleRewards, trackJoin };
