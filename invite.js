const { ActionRowBuilder, UserSelectMenuBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { supabase, createEmbed, SETTINGS } = require("./config");

// 🔥 LEADERBOARD (PAGINATION)
async function handleLeaderboard(interaction, page = 1) {
    const LIMIT = 10;
    const offset = (page - 1) * LIMIT;
    
    await interaction.deferReply();
    const { data, count } = await supabase.from("invite_stats").select("*", {count:'exact'}).eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).range(offset, offset+LIMIT-1);
    
    let desc = data.map((u, i) => {
        let rank = offset + i + 1;
        let medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : `**#${rank}**`;
        return `${medal} <@${u.inviter_id}> • **${u.real_invites}** Invites`;
    }).join("\n") || "No data.";

    const embed = createEmbed("🏆 Invite Leaderboard", desc, 0xFFD700);
    // Add pagination buttons if needed (Simplified for now)
    return interaction.editReply({ embeds: [embed] });
}

// 🔥 REWARDS SYSTEM (ADD/REMOVE/LIST)
async function handleRewards(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === "add") {
        const invites = interaction.options.getInteger("invites");
        const role = interaction.options.getRole("role");
        
        // Prevent Duplicates
        const { data: exists } = await supabase.from("invite_rewards").select("*").eq("guild_id", guildId).eq("invites_required", invites).eq("role_id", role.id).maybeSingle();
        if (exists) return interaction.reply({ content: "❌ Reward already exists!", ephemeral: true });

        await supabase.from("invite_rewards").insert({ guild_id: guildId, invites_required: invites, role_id: role.id });
        return interaction.reply({ embeds: [createEmbed("✅ Reward Added", `**${invites} Invites** ➜ <@&${role.id}>`, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "list") {
        const { data } = await supabase.from("invite_rewards").select("*").eq("guild_id", guildId).order("invites_required", {ascending: true});
        const list = data.map(r => `• **${r.invites_required}** Invites ➜ <@&${r.role_id}> (ID: \`${r.id}\`)`).join("\n") || "No rewards set.";
        return interaction.reply({ embeds: [createEmbed("🎁 Invite Rewards", list, SETTINGS.COLOR_INFO)] });
    }

    if (sub === "remove") {
        const rewardId = interaction.options.getInteger("reward_id"); // Need to know ID from list
        // Alternatively delete by role/invites logic
        await supabase.from("invite_rewards").delete().eq("id", rewardId); // Simplified
        return interaction.reply("✅ Reward Removed");
    }
}

// 🔥 WELCOME SYSTEM
async function handleConfigWelcome(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === "setchannel") {
        const ch = interaction.options.getChannel("channel");
        await supabase.from("guild_config").upsert({ guild_id: guildId, welcome_channel: ch.id }, { onConflict: 'guild_id' });
        return interaction.reply(`✅ Welcome Channel: ${ch}`);
    }
    if (sub === "setmessage") {
        const msg = interaction.options.getString("message"); // JSON or Text
        await supabase.from("guild_config").upsert({ guild_id: guildId, welcome_desc: msg }, { onConflict: 'guild_id' });
        return interaction.reply("✅ Welcome Message Updated");
    }
}

// 🔥 BATCH SYNC UI
async function showBatchSync(interaction) {
    const guild = interaction.guild;
    await guild.members.fetch(); 
    const members = guild.members.cache;
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", guild.id);
    const recordedIds = new Set(joins ? joins.map(j => j.user_id) : []);
    
    const missingBatch = members.filter(m => !m.user.bot && !recordedIds.has(m.id)).first(5);

    if (missingBatch.length === 0) {
        return interaction.editReply({ embeds: [createEmbed("✅ All Synced", "No missing users found.", SETTINGS.COLOR_SUCCESS)], components: [] });
    }

    const description = missingBatch.map((m, i) => `**${i+1}.** ${m} (${m.user.tag})`).join("\n");
    const embed = createEmbed(`📋 Sync Batch (${missingBatch.length})`, description, SETTINGS.COLOR_WARN);

    const components = missingBatch.map((m, i) => new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`sync_fix_${m.id}`).setPlaceholder(`${i+1}. Inviter for ${m.user.username}?`).setMaxValues(1)
    ));

    if (interaction.message) await interaction.update({ embeds: [embed], components: components });
    else await interaction.editReply({ embeds: [embed], components: components });
}

// 🔥 HANDLE BATCH SAVE
async function handleBatchSync(interaction) {
    try { await interaction.deferUpdate(); } catch(e){}
    const targetUserId = interaction.customId.replace("sync_fix_", "");
    const inviterId = interaction.values[0];

    await supabase.from("joins").upsert({ guild_id: interaction.guild.id, user_id: targetUserId, inviter_id: inviterId, code: "manual_sync" });
    
    if (inviterId !== 'left_user') {
        const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", inviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({ 
            guild_id: interaction.guild.id, 
            inviter_id: inviterId, 
            total_invites: (ex?.total_invites||0)+1, 
            real_invites: (ex?.real_invites||0)+1 
        });
    }
    await showBatchSync(interaction);
}

module.exports = { showBatchSync, handleBatchSync, handleLeaderboard, handleRewards, handleConfigWelcome };
