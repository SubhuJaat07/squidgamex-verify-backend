
const { ActionRowBuilder, UserSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { supabase, createEmbed } = require("./config");

const recentlySynced = new Set();

// 🔥 MAIN LOOP: Find Missing Users
async function checkNextMissingUser(interactionOrMessage) {
    const guild = interactionOrMessage.guild;
    const members = await guild.members.fetch(); 
    
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", guild.id);
    const recordedIds = new Set(joins ? joins.map(j => j.user_id) : []);
    
    // Find next missing user who is not a bot, not in DB, and not recently synced
    const missingMember = members.find(m => !m.user.bot && !recordedIds.has(m.id) && !recentlySynced.has(m.id));

    if (!missingMember) {
        const embed = createEmbed("✅ Sync Complete!", "All members are now registered.", 0x00FF00);
        // Check if it's an interaction or a message context
        if (interactionOrMessage.editReply) return interactionOrMessage.editReply({ content: null, embeds: [embed], components: [] });
        return interactionOrMessage.channel.send({ embeds: [embed] });
    }

    const embed = createEmbed("⚠️ Missing Invite Data", `**User:** ${missingMember} (${missingMember.user.tag})\n\n**Action:** Select who invited this user.`, 0xFFA500)
        .setFooter({ text: `TargetID: ${missingMember.id}` }); 

    const row1 = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId('sync_select_inviter').setPlaceholder('Select Inviter...').setMaxValues(1)
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sync_user_left').setLabel('Unknown / Left').setStyle(ButtonStyle.Secondary).setEmoji('🚪')
    );

    const payload = { content: null, embeds: [embed], components: [row1, row2] };
    
    // Safety check for update method
    if (interactionOrMessage.editReply) await interactionOrMessage.editReply(payload);
    else if (interactionOrMessage.update) await interactionOrMessage.update(payload);
    else await interactionOrMessage.channel.send(payload);
}

// 🔥 HANDLE SELECTION
async function handleSyncInteraction(interaction) {
    // ⚡ FIX: Immediate Defer prevents "Unknown interaction" error
    try {
        await interaction.deferUpdate(); 
    } catch (e) { console.log("Interaction already acknowledged"); }

    const targetUserId = interaction.message.embeds[0].footer.text.replace("TargetID: ", "");
    const inviterId = interaction.isButton() ? 'left_user' : interaction.values[0];
    
    // 1. Save to DB
    await supabase.from("joins").upsert({ 
        guild_id: interaction.guild.id, 
        user_id: targetUserId, 
        inviter_id: inviterId, 
        code: "manual_sync" 
    });

    // 2. Mark locally to avoid loop
    recentlySynced.add(targetUserId);

    // 3. Update Stats (only if real inviter)
    if (inviterId !== 'left_user') {
        const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", inviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({ 
            guild_id: interaction.guild.id, 
            inviter_id: inviterId, 
            total_invites: (ex?.total_invites || 0) + 1, 
            real_invites: (ex?.real_invites || 0) + 1 
        });
    }

    // 4. Trigger next user
    await checkNextMissingUser(interaction);
}

module.exports = { checkNextMissingUser, handleSyncInteraction };
