const { ActionRowBuilder, UserSelectMenuBuilder, EmbedBuilder } = require("discord.js");
const { supabase, createEmbed, SETTINGS } = require("./config");

// =====================================================================
// 🛡️ 1. WHITELIST SYSTEM
// =====================================================================
async function handleWhitelist(interaction) {
    const action = interaction.options.getString("action");
    const guildId = interaction.guild.id;

    const { data } = await supabase.from("guild_config").select("ping_whitelist").eq("guild_id", guildId).maybeSingle();
    let list = data?.ping_whitelist || [];

    if (action === "add") {
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        
        let changes = [];
        if (user && !list.includes(user.id)) { list.push(user.id); changes.push(`${user}`); }
        if (role && !list.includes(role.id)) { list.push(role.id); changes.push(`${role}`); }

        if (changes.length === 0) return interaction.reply({ content: "❌ Target already whitelisted or invalid.", ephemeral: true });

        await supabase.from("guild_config").upsert({ guild_id: guildId, ping_whitelist: list }, { onConflict: 'guild_id' });
        return interaction.reply({ embeds: [createEmbed("✅ Whitelist Updated", `**Added:** ${changes.join(", ")}`, SETTINGS.COLOR_SUCCESS)] });
    }

    if (action === "remove") {
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        
        let oldLen = list.length;
        if (user) list = list.filter(id => id !== user.id);
        if (role) list = list.filter(id => id !== role.id);

        if (list.length === oldLen) return interaction.reply({ content: "❌ Target not found in whitelist.", ephemeral: true });

        await supabase.from("guild_config").upsert({ guild_id: guildId, ping_whitelist: list }, { onConflict: 'guild_id' });
        return interaction.reply({ embeds: [createEmbed("🗑️ Whitelist Removed", "Target removed from whitelist.", SETTINGS.COLOR_WARN)] });
    }

    if (action === "list") {
        const formatted = list.length > 0 ? list.map(id => `<@${id}> / <@&${id}>`).join("\n") : "Empty";
        return interaction.reply({ embeds: [createEmbed("🛡️ Whitelist", formatted, SETTINGS.COLOR_INFO)] });
    }
}

// =====================================================================
// 👋 2. WELCOME & BYE CONFIGURATION (Unified Menu)
// =====================================================================
async function handleWelcomeCommands(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guild.id;

    // "type" determines if we are editing Welcome or Bye settings
    const type = interaction.options.getString("type") || "welcome"; // Default to welcome if not specified (for safety)
    const isBye = type === 'bye';

    if (sub === "channel") {
        const ch = interaction.options.getChannel("target");
        const updateData = isBye 
            ? { bye_channel: ch.id, bye_enabled: true }
            : { welcome_channel: ch.id, welcome_enabled: true };

        await supabase.from("guild_config").upsert({ guild_id: gid, ...updateData }, { onConflict: 'guild_id' });
        return interaction.reply(`✅ **${isBye ? "Bye" : "Welcome"} Channel Set:** ${ch}`);
    }

    if (sub === "message") {
        const title = interaction.options.getString("title");
        const msg = interaction.options.getString("content");
        
        const updateData = isBye 
            ? { bye_message: msg, bye_title: title || "Goodbye!" }
            : { welcome_desc: msg, welcome_title: title || "Welcome!" };

        await supabase.from("guild_config").upsert({ guild_id: gid, ...updateData }, { onConflict: 'guild_id' });
        return interaction.reply({ 
            embeds: [createEmbed(`✅ ${isBye ? "Bye" : "Welcome"} Message Updated`, `**Title:** ${title||"Default"}\n**Message:** ${msg}\n\n*Placeholders: {user}, {username}, {server}, {count}*`, SETTINGS.COLOR_SUCCESS)] 
        });
    }

    if (sub === "toggle") {
        const state = interaction.options.getString("state") === 'on';
        const updateData = isBye ? { bye_enabled: state } : { welcome_enabled: state };
        
        await supabase.from("guild_config").upsert({ guild_id: gid, ...updateData }, { onConflict: 'guild_id' });
        return interaction.reply(`✅ **${isBye ? "Bye" : "Welcome"} System:** ${state ? "ENABLED" : "DISABLED"}`);
    }

    if (sub === "test") {
        // Simulate both events for testing
        await trackJoin(interaction.member, true);
        await trackLeave(interaction.member, true);
        return interaction.reply({ content: "📨 Test messages sent to configured channels.", ephemeral: true });
    }
}

// =====================================================================
// 🎁 3. REWARDS SYSTEM
// =====================================================================
async function handleRewards(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guild.id;

    if (sub === "add") {
        const invites = interaction.options.getInteger("invites");
        const role = interaction.options.getRole("role");

        const { data } = await supabase.from("invite_rewards").select("*").eq("guild_id", gid).eq("role_id", role.id).maybeSingle();
        if (data) return interaction.reply({ content: "❌ Role already exists in rewards.", ephemeral: true });

        await supabase.from("invite_rewards").insert({ guild_id: gid, invites_required: invites, role_id: role.id });
        return interaction.reply({ embeds: [createEmbed("✅ Reward Added", `**${invites} Invites** ➜ ${role}`, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "remove") {
        const id = interaction.options.getInteger("id");
        const { error } = await supabase.from("invite_rewards").delete().eq("id", id);
        if (error) return interaction.reply("❌ Invalid ID.");
        return interaction.reply("✅ Reward Removed.");
    }

    if (sub === "list") {
        const { data } = await supabase.from("invite_rewards").select("*").eq("guild_id", gid).order("invites_required");
        const list = data.map(r => `🆔 \`${r.id}\` • **${r.invites_required}** Invites ➜ <@&${r.role_id}>`).join("\n") || "No rewards set.";
        return interaction.reply({ embeds: [createEmbed("🎁 Rewards List", list, SETTINGS.COLOR_INFO)] });
    }
}

// =====================================================================
// 🕵️ 4. TRACKER EVENTS (Join & Leave)
// =====================================================================
async function trackJoin(member, isTest = false) {
    try {
        const gid = member.guild.id;
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", gid).maybeSingle();

        // 1. Send Welcome Message
        if (config?.welcome_enabled && config?.welcome_channel) {
            const ch = member.guild.channels.cache.get(config.welcome_channel);
            if (ch) {
                // Try to find inviter for placeholder
                let inviterText = "Unknown";
                if (!isTest) {
                    const { data: join } = await supabase.from("joins").select("inviter_id").eq("guild_id", gid).eq("user_id", member.id).maybeSingle();
                    if (join && join.inviter_id && join.inviter_id !== 'unknown') inviterText = `<@${join.inviter_id}>`;
                }

                const title = (config.welcome_title || "Welcome to {server}!").replace(/{user}/g, member.user.username).replace(/{server}/g, member.guild.name);
                const desc = (config.welcome_desc || "Hello {user}, you are member #{count}.")
                    .replace(/{user}/g, `<@${member.id}>`)
                    .replace(/{username}/g, member.user.username)
                    .replace(/{server}/g, member.guild.name)
                    .replace(/{count}/g, member.guild.memberCount)
                    .replace(/{inviter}/g, inviterText);

                ch.send({ embeds: [createEmbed(title, desc, SETTINGS.COLOR_SUCCESS, member.user)] });
            }
        }

        // 2. Database Log (If not test)
        if (!isTest) {
            // Note: Actual "who invited" logic requires Invite Cache in index.js to pass the inviter.
            // Here we just ensure a record exists. If handleBatchSync was used, it updates this.
            // We use 'upsert' to avoid errors if batch sync ran first.
            const { error } = await supabase.from("joins").insert({ guild_id: gid, user_id: member.id, inviter_id: 'unknown', code: 'auto' }).select();
            // Ignore duplicate key error, means it's already handled or synced
        }
    } catch (e) { console.error("Join Error:", e); }
}

async function trackLeave(member, isTest = false) {
    try {
        const gid = member.guild.id;
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", gid).maybeSingle();

        // 1. Send Bye Message
        if (config?.bye_enabled && config?.bye_channel) {
            const ch = member.guild.channels.cache.get(config.bye_channel);
            if (ch) {
                const title = (config.bye_title || "Goodbye!").replace(/{user}/g, member.user.username);
                const desc = (config.bye_message || "{user} has left the server.")
                    .replace(/{user}/g, `<@${member.id}>`)
                    .replace(/{username}/g, member.user.username)
                    .replace(/{count}/g, member.guild.memberCount);

                ch.send({ embeds: [createEmbed(title, desc, SETTINGS.COLOR_ERROR, member.user)] });
            }
        }

        // 2. Update Inviter Stats (Decrement Real, Increment Leaves)
        if (!isTest) {
            const { data: join } = await supabase.from("joins").select("inviter_id").eq("guild_id", gid).eq("user_id", member.id).maybeSingle();
            
            if (join && join.inviter_id && join.inviter_id !== 'unknown' && join.inviter_id !== 'left_user') {
                // Fetch current stats
                const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", gid).eq("inviter_id", join.inviter_id).maybeSingle();
                
                if (stats) {
                    const newReal = Math.max(0, (stats.real_invites || 0) - 1);
                    const newLeaves = (stats.leaves || 0) + 1;
                    
                    await supabase.from("invite_stats").update({ 
                        real_invites: newReal, 
                        leaves: newLeaves 
                    }).eq("id", stats.id);
                }
            }
        }
    } catch (e) { console.error("Leave Error:", e); }
}

// =====================================================================
// 📊 5. STATS & COMMANDS
// =====================================================================

async function handleWhoInvited(interaction) {
    const user = interaction.options.getUser("user") || interaction.user;
    const { data } = await supabase.from("joins").select("inviter_id, created_at").eq("guild_id", interaction.guild.id).eq("user_id", user.id).maybeSingle();

    if (!data || data.inviter_id === 'unknown') {
        return interaction.reply({ embeds: [createEmbed("❓ Unknown Inviter", `I couldn't trace who invited ${user}.`, SETTINGS.COLOR_WARN)] });
    }

    const time = `<t:${Math.floor(new Date(data.created_at).getTime()/1000)}:F>`;
    return interaction.reply({ embeds: [createEmbed("🕵️ Invite Trace", `**Target:** ${user}\n**Invited By:** <@${data.inviter_id}>\n**Joined:** ${time}`, SETTINGS.COLOR_INFO)] });
}

async function handleInvites(interaction) {
    await interaction.deferReply();
    const user = interaction.options.getUser("user") || interaction.user;
    const guildId = interaction.guild.id;

    // 1. Get Stats
    const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", guildId).eq("inviter_id", user.id).maybeSingle();
    
    // 2. Get Recent Joins (Detailed List)
    const { data: joins } = await supabase.from("joins").select("user_id, created_at").eq("guild_id", guildId).eq("inviter_id", user.id).order('created_at', { ascending: false }).limit(10);

    const real = stats?.real_invites || 0;
    const total = stats?.total_invites || 0;
    const leaves = stats?.leaves || 0;

    let joinList = "No recent invites.";
    if (joins && joins.length > 0) {
        joinList = await Promise.all(joins.map(async (j, i) => {
            // Check if user is still in guild
            let status = "✅";
            try { await interaction.guild.members.fetch(j.user_id); } catch { status = "❌ (Left)"; }
            return `\`${i+1}.\` <@${j.user_id}> ${status} • <t:${Math.floor(new Date(j.created_at).getTime()/1000)}:R>`;
        }));
        joinList = joinList.join("\n");
    }

    const embed = createEmbed(`📊 Invites: ${user.username}`, null, SETTINGS.COLOR_INFO, user)
        .addFields(
            { name: "✅ Real", value: `${real}`, inline: true },
            { name: "📉 Leaves", value: `${leaves}`, inline: true },
            { name: "📈 Total", value: `${total}`, inline: true },
            { name: "📝 Recent Invites (Last 10)", value: joinList, inline: false }
        );

    return interaction.editReply({ embeds: [embed] });
}

async function handleLeaderboard(interaction) {
    await interaction.deferReply();
    const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).limit(10);

    if (!data || data.length === 0) return interaction.editReply({ embeds: [createEmbed("🏆 Leaderboard", "No data available.", SETTINGS.COLOR_WARN)] });

    const desc = data.map((u, i) => {
        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `**#${i+1}**`;
        return `${medal} <@${u.inviter_id}> • **${u.real_invites}** Real (${u.total_invites} Total)`;
    }).join("\n");

    return interaction.editReply({ embeds: [createEmbed("🏆 Top 10 Inviters", desc, 0xFFD700)] });
}

// 🔁 BATCH SYNC (Fix for "Max 1" issue)
async function handleBatchSync(interaction) {
    try { await interaction.deferUpdate(); } catch(e){}
    const target = interaction.customId.replace("sync_fix_", "");
    const inviter = interaction.values[0];
    const gid = interaction.guild.id;

    // 1. Record Join
    await supabase.from("joins").upsert({ guild_id: gid, user_id: target, inviter_id: inviter, code: "manual" });

    // 2. Update Stats (With proper increment)
    if (inviter !== 'left_user') {
        const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", gid).eq("inviter_id", inviter).maybeSingle();
        
        const newReal = (ex?.real_invites || 0) + 1;
        const newTotal = (ex?.total_invites || 0) + 1;

        await supabase.from("invite_stats").upsert({ 
            guild_id: gid, 
            inviter_id: inviter, 
            real_invites: newReal,
            total_invites: newTotal
        });

        // 3. Check Rewards (Auto-Role)
        const { data: rewards } = await supabase.from("invite_rewards").select("*").eq("guild_id", gid);
        if (rewards) {
            const member = await interaction.guild.members.fetch(inviter).catch(()=>null);
            if (member) {
                rewards.forEach(r => {
                    if (newReal >= r.invites_required && !member.roles.cache.has(r.role_id)) {
                        member.roles.add(r.role_id).catch(()=>{});
                    }
                });
            }
        }
    }
    
    // Refresh
    await showBatchSync(interaction);
}

// Helper to show missing invites (Exported for index.js)
async function showBatchSync(interaction) {
    const members = await interaction.guild.members.fetch(); 
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", interaction.guild.id);
    const recorded = new Set(joins ? joins.map(j => j.user_id) : []);
    
    const missing = members.filter(m => !m.user.bot && !recorded.has(m.id)).first(5);
    
    if (missing.length === 0) {
        const embed = createEmbed("✅ Sync Complete", "All members are tracked.", SETTINGS.COLOR_SUCCESS);
        if(interaction.message) return interaction.update({embeds:[embed], components:[]});
        return interaction.editReply({embeds:[embed], components:[]});
    }

    const desc = missing.map((m, i) => `**${i+1}.** ${m} (${m.user.tag})`).join("\n");
    const comp = missing.map((m, i) => new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`sync_fix_${m.id}`).setPlaceholder(`Who invited ${m.user.username}?`).setMaxValues(1)
    ));

    const embed = createEmbed(`📋 Sync Required (${missing.length})`, desc, SETTINGS.COLOR_WARN);
    if(interaction.message) interaction.update({embeds:[embed], components:comp}); 
    else interaction.editReply({embeds:[embed], components:comp});
}

module.exports = { 
    handleWhitelist, handleWelcomeCommands, handleRewards, 
    trackJoin, trackLeave, 
    handleWhoInvited, handleInvites, handleLeaderboard, 
    handleBatchSync, showBatchSync 
};
