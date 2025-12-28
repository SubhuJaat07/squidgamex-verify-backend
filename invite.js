const { ActionRowBuilder, UserSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { supabase, createEmbed } = require("./config");

// 🔥 BATCH SYNC: Show 5 Select Menus at once
async function showBatchSync(interaction) {
    const guild = interaction.guild;
    await guild.members.fetch(); 
    const members = guild.members.cache;

    // 1. Get Missing Users
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", guild.id);
    const recordedIds = new Set(joins ? joins.map(j => j.user_id) : []);
    
    // Filter out bots & existing users -> Take top 5
    const missingBatch = members.filter(m => !m.user.bot && !recordedIds.has(m.id)).first(5);

    // 2. If all done
    if (missingBatch.length === 0) {
        const embed = createEmbed("✅ Sync Complete!", "All users are synced.", 0x00FF00);
        if (interaction.message) return interaction.update({ content: null, embeds: [embed], components: [] });
        return interaction.editReply({ content: null, embeds: [embed], components: [] });
    }

    // 3. Create Embed List
    const description = missingBatch.map((m, i) => `**${i+1}.** ${m} (${m.user.tag})`).join("\n");
    const embed = createEmbed(`📋 Sync Batch (${missingBatch.length} visible)`, `**Select Inviter for each user below:**\n\n${description}`, 0xFFA500)
        .setFooter({ text: "Select an inviter to save & load next." });

    // 4. Create 5 Rows (One per user)
    const components = missingBatch.map((m, i) => {
        return new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder()
                .setCustomId(`sync_fix_${m.id}`) // Storing User ID in CustomID
                .setPlaceholder(`${i+1}. Inviter for ${m.user.username.substring(0, 10)}...`)
                .setMaxValues(1)
        );
    });

    const payload = { content: null, embeds: [embed], components: components };
    
    if (interaction.message) await interaction.update(payload);
    else await interaction.editReply(payload);
}

// 🔥 HANDLE SELECTION
async function handleBatchSync(interaction) {
    // Prevent timeout
    try { await interaction.deferUpdate(); } catch(e){}

    const targetUserId = interaction.customId.replace("sync_fix_", "");
    const inviterId = interaction.values[0];

    // 1. Save to DB
    await supabase.from("joins").upsert({ 
        guild_id: interaction.guild.id, 
        user_id: targetUserId, 
        inviter_id: inviterId, 
        code: "manual_sync" 
    });

    // 2. Update Stats
    const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", inviterId).maybeSingle();
    await supabase.from("invite_stats").upsert({ 
        guild_id: interaction.guild.id, 
        inviter_id: inviterId, 
        total_invites: (ex?.total_invites || 0) + 1, 
        real_invites: (ex?.real_invites || 0) + 1 
    });

    // 3. Refresh Batch (Target user is now in DB, so they will vanish and new one appears)
    await showBatchSync(interaction);
}

module.exports = { showBatchSync, handleBatchSync };
