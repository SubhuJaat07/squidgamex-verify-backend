const { ActionRowBuilder, UserSelectMenuBuilder, EmbedBuilder } = require("discord.js");
const { supabase, createEmbed } = require("./config");

// 🔥 BATCH SYNC DASHBOARD
async function showBatchSync(interaction) {
    const guild = interaction.guild;
    await guild.members.fetch(); 
    const members = guild.members.cache;
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", guild.id);
    const recordedIds = new Set(joins ? joins.map(j => j.user_id) : []);
    
    // Filter Missing
    const missingBatch = members.filter(m => !m.user.bot && !recordedIds.has(m.id)).first(5);

    if (missingBatch.length === 0) {
        const embed = createEmbed("✅ Sync Complete!", "All users synced.", 0x00FF00);
        if (interaction.message) return interaction.update({ content: null, embeds: [embed], components: [] });
        return interaction.editReply({ content: null, embeds: [embed], components: [] });
    }

    const description = missingBatch.map((m, i) => `**${i+1}.** ${m} (${m.user.tag})`).join("\n");
    const embed = createEmbed(`📋 Sync Batch (${missingBatch.length})`, `**Select Inviter for users below:**\n\n${description}`, 0xFFA500);

    const components = missingBatch.map((m, i) => {
        return new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId(`sync_fix_${m.id}`).setPlaceholder(`${i+1}. Inviter for ${m.user.username.substring(0, 10)}...`).setMaxValues(1)
        );
    });

    const payload = { content: null, embeds: [embed], components: components };
    if (interaction.message) await interaction.update(payload);
    else await interaction.editReply(payload);
}

// 🔥 HANDLE SAVE
async function handleBatchSync(interaction) {
    try { await interaction.deferUpdate(); } catch(e){}
    const targetUserId = interaction.customId.replace("sync_fix_", "");
    const inviterId = interaction.values[0];

    // DB Write - Wait for it!
    await supabase.from("joins").upsert({ guild_id: interaction.guild.id, user_id: targetUserId, inviter_id: inviterId, code: "manual_sync" });

    // Update Stats
    if (inviterId !== 'left_user') {
        const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", inviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({ 
            guild_id: interaction.guild.id, 
            inviter_id: inviterId, 
            total_invites: (ex?.total_invites || 0) + 1, 
            real_invites: (ex?.real_invites || 0) + 1 
        });
    }
    // Refresh
    await showBatchSync(interaction);
}

// 🔥 TRACK JOIN
async function trackJoin(member) {
    try {
        const guild = member.guild;
        // Basic Logic (Assumes unknown if tracker cache logic isn't here to keep file small)
        await supabase.from("joins").insert({ guild_id: guild.id, user_id: member.id, inviter_id: 'unknown', code: 'auto' });

        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", guild.id).maybeSingle();
        if (config && config.welcome_channel) {
            const channel = guild.channels.cache.get(config.welcome_channel);
            if (channel) {
                const embed = new EmbedBuilder()
                    .setTitle(config.welcome_title || "Welcome!")
                    .setDescription((config.welcome_desc || "Welcome {user}").replace(/{user}/g, `<@${member.id}>`))
                    .setColor(0x00FF00)
                    .setThumbnail(member.user.displayAvatarURL());
                channel.send({ embeds: [embed] });
            }
        }
    } catch(e) {}
}

module.exports = { showBatchSync, handleBatchSync, trackJoin };
