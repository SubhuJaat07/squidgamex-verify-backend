const { ActionRowBuilder, UserSelectMenuBuilder } = require("discord.js");
const { supabase, createEmbed, SETTINGS } = require("./config");

// =====================================================================
// 👋 WELCOME & BYE CONFIGURATION
// =====================================================================
async function handleWelcomeCommands(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guild.id;

    if (sub === "channel") {
        const ch = interaction.options.getChannel("target");
        const type = interaction.options.getString("type"); // welcome or bye
        
        if (type === 'bye') {
            await supabase.from("guild_config").upsert({ guild_id: gid, bye_channel: ch.id, bye_enabled: true }, { onConflict: 'guild_id' });
            return interaction.reply(`✅ **Bye Channel Set:** ${ch}`);
        } else {
            await supabase.from("guild_config").upsert({ guild_id: gid, welcome_channel: ch.id, welcome_enabled: true }, { onConflict: 'guild_id' });
            return interaction.reply(`✅ **Welcome Channel Set:** ${ch}`);
        }
    }

    if (sub === "message") {
        const type = interaction.options.getString("type");
        const msg = interaction.options.getString("content");
        const title = interaction.options.getString("title") || (type === 'bye' ? "Goodbye!" : "Welcome!");
        
        if (type === 'bye') {
            await supabase.from("guild_config").upsert({ guild_id: gid, bye_message: msg, bye_title: title }, { onConflict: 'guild_id' });
        } else {
            await supabase.from("guild_config").upsert({ guild_id: gid, welcome_desc: msg, welcome_title: title }, { onConflict: 'guild_id' });
        }
        return interaction.reply({ embeds: [createEmbed(`✅ ${type.toUpperCase()} Message Updated`, `**Title:** ${title}\n**Msg:** ${msg}`, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "toggle") {
        const type = interaction.options.getString("type");
        const state = interaction.options.getString("state") === 'on';
        if (type === 'bye') await supabase.from("guild_config").upsert({ guild_id: gid, bye_enabled: state }, { onConflict: 'guild_id' });
        else await supabase.from("guild_config").upsert({ guild_id: gid, welcome_enabled: state }, { onConflict: 'guild_id' });
        return interaction.reply(`✅ **${type.toUpperCase()} System:** ${state ? "ENABLED" : "DISABLED"}`);
    }

    if (sub === "test") {
        await trackJoin(interaction.member, true); // True = Test
        await trackLeave(interaction.member, true);
        return interaction.reply({ content: "📨 Test messages sent.", ephemeral: true });
    }
}

// =====================================================================
// 🕵️ TRACKER & EVENTS
// =====================================================================
async function trackJoin(member, isTest = false) {
    try {
        const gid = member.guild.id;
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", gid).maybeSingle();

        // 1. Send Welcome
        if (config?.welcome_enabled && config?.welcome_channel) {
            const ch = member.guild.channels.cache.get(config.welcome_channel);
            if (ch) {
                let inviterTxt = "Unknown";
                // Only check DB if not test
                if (!isTest) {
                    const { data: join } = await supabase.from("joins").select("inviter_id").eq("guild_id", gid).eq("user_id", member.id).maybeSingle();
                    if (join && join.inviter_id && join.inviter_id !== 'unknown') inviterTxt = `<@${join.inviter_id}>`;
                }

                const title = (config.welcome_title || "Welcome!").replace(/{user}/g, member.user.username);
                const desc = (config.welcome_desc || "Welcome {user} to {server}!")
                    .replace(/{user}/g, `<@${member.id}>`)
                    .replace(/{server}/g, member.guild.name)
                    .replace(/{count}/g, member.guild.memberCount)
                    .replace(/{inviter}/g, inviterTxt);

                ch.send({ embeds: [createEmbed(title, desc, SETTINGS.COLOR_SUCCESS, member.user)] });
            }
        }

        // 2. Logic for invite tracking is usually handled in index.js via Invite Cache, 
        // but here we ensure database entry exists
        if (!isTest) {
            await supabase.from("joins").insert({ guild_id: gid, user_id: member.id, inviter_id: 'unknown', code: 'auto' });
        }
    } catch(e) { console.error(e); }
}

async function trackLeave(member, isTest = false) {
    try {
        const gid = member.guild.id;
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", gid).maybeSingle();

        if (config?.bye_enabled && config?.bye_channel) {
            const ch = member.guild.channels.cache.get(config.bye_channel);
            if (ch) {
                const title = config.bye_title || "Goodbye";
                const desc = (config.bye_message || "{user} left the server.")
                    .replace(/{user}/g, `<@${member.id}>`)
                    .replace(/{username}/g, member.user.username)
                    .replace(/{count}/g, member.guild.memberCount);
                
                ch.send({ embeds: [createEmbed(title, desc, SETTINGS.COLOR_ERROR, member.user)] });
            }
        }
        
        // Update Inviter Stats (Mark as left)
        if (!isTest) {
            const { data: join } = await supabase.from("joins").select("inviter_id").eq("guild_id", gid).eq("user_id", member.id).maybeSingle();
            if (join && join.inviter_id !== 'unknown') {
                const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", gid).eq("inviter_id", join.inviter_id).single();
                if (stats) {
                    await supabase.from("invite_stats").update({ 
                        leaves: (stats.leaves || 0) + 1,
                        real_invites: (stats.real_invites || 1) - 1 
                    }).eq("id", stats.id);
                }
            }
        }
    } catch(e) { console.error(e); }
}

// =====================================================================
// 📊 COMMANDS: WHOINVITED & INVITES
// =====================================================================
async function handleWhoInvited(interaction) {
    const user = interaction.options.getUser("user") || interaction.user;
    const { data } = await supabase.from("joins").select("inviter_id, created_at").eq("guild_id", interaction.guild.id).eq("user_id", user.id).maybeSingle();
    
    if (!data || data.inviter_id === 'unknown') return interaction.reply({ embeds: [createEmbed("🕵️ Trace Failed", `I don't know who invited ${user}.`, SETTINGS.COLOR_WARN)] });
    
    const time = `<t:${Math.floor(new Date(data.created_at).getTime()/1000)}:R>`;
    return interaction.reply({ embeds: [createEmbed("🕵️ Invite Trace", `${user} was invited by <@${data.inviter_id}>\n📅 Joined: ${time}`, SETTINGS.COLOR_INFO)] });
}

async function handleInvites(interaction) {
    const user = interaction.options.getUser("user") || interaction.user;
    const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", user.id).maybeSingle();
    
    if (!stats) return interaction.reply({ embeds: [createEmbed("📊 Invites", `${user} has **0** invites.`, SETTINGS.COLOR_WARN)] });

    const embed = createEmbed(`📊 Invites: ${user.username}`, null, SETTINGS.COLOR_INFO, user)
        .addFields(
            { name: "✅ Real", value: `${stats.real_invites}`, inline: true },
            { name: "❌ Leaves", value: `${stats.leaves}`, inline: true },
            { name: "📈 Total", value: `${stats.total_invites}`, inline: true }
        );
    return interaction.reply({ embeds: [embed] });
}

module.exports = { handleWelcomeCommands, trackJoin, trackLeave, handleWhoInvited, handleInvites };
