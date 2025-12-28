const { ActionRowBuilder, UserSelectMenuBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { supabase, createEmbed } = require("./config");

// 🔥 STEP 1: Show Missing Users List (Dashboard)
async function showSyncDashboard(interaction) {
    const guild = interaction.guild;
    await guild.members.fetch(); // Ensure cache is full
    const members = guild.members.cache;

    // Fetch existing IDs from DB
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", guild.id);
    const recordedIds = new Set(joins ? joins.map(j => j.user_id) : []);

    // Filter Missing Members (Limit 25 due to Discord Dropdown Limit)
    const missingMembers = members.filter(m => !m.user.bot && !recordedIds.has(m.id)).first(25);

    if (missingMembers.length === 0) {
        const embed = createEmbed("✅ Sync Complete!", "All users are perfectly synced with the Database.", 0x00FF00);
        // Handle both reply update and new reply
        if (interaction.message) return interaction.update({ content: null, embeds: [embed], components: [] });
        return interaction.editReply({ content: null, embeds: [embed], components: [] });
    }

    // Create Options for Dropdown
    const options = missingMembers.map(m => ({
        label: m.user.tag.substring(0, 25), // Discord Limit
        description: `ID: ${m.id}`,
        value: m.id
    }));

    const embed = createEmbed("📋 Missing Invite Data", `**Found ${missingMembers.length}+ Users** not in Database.\nSelect a user below to fix their invite data manually.`, 0xFFA500);

    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('sync_pick_user')
            .setPlaceholder(`Select User to Sync (${missingMembers.length} remaining)`)
            .addOptions(options)
    );

    const payload = { content: null, embeds: [embed], components: [row] };
    
    if (interaction.message) await interaction.update(payload);
    else await interaction.editReply(payload);
}

// 🔥 STEP 2: Ask for Inviter (When User Selected)
async function handleUserSelection(interaction) {
    const targetId = interaction.values[0];
    let targetUser;
    try { targetUser = await interaction.guild.members.fetch(targetId); } catch(e) { targetUser = { user: { tag: "Unknown" }, id: targetId }; }

    const embed = createEmbed("🔗 Select Inviter", `**Syncing:** ${targetUser.user.tag}\n\n👇 **Who invited this person?**`, 0x00FFFF)
        .setFooter({ text: `TargetID: ${targetId}` }); // Persist ID

    const row1 = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId('sync_confirm_inviter').setPlaceholder('Search Inviter...').setMaxValues(1)
    );
    
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('sync_inviter_left').setLabel('Unknown / Left Server').setStyle(ButtonStyle.Secondary).setEmoji('🚪'),
        new ButtonBuilder().setCustomId('sync_cancel').setLabel('Cancel / Go Back').setStyle(ButtonStyle.Danger)
    );

    await interaction.update({ embeds: [embed], components: [row1, row2] });
}

// 🔥 STEP 3: Save & Refresh (Final Step)
async function saveSyncData(interaction) {
    const targetUserId = interaction.message.embeds[0].footer.text.replace("TargetID: ", "");
    // Check if button (Left) or Menu (Selected)
    const inviterId = interaction.customId === 'sync_inviter_left' ? 'left_user' : interaction.values[0];

    // 1. Save to DB
    await supabase.from("joins").upsert({ 
        guild_id: interaction.guild.id, 
        user_id: targetUserId, 
        inviter_id: inviterId, 
        code: "manual_sync" 
    });

    // 2. Update Stats (only if real user)
    if (inviterId !== 'left_user') {
        const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", inviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({ 
            guild_id: interaction.guild.id, 
            inviter_id: inviterId, 
            total_invites: (ex?.total_invites || 0) + 1, 
            real_invites: (ex?.real_invites || 0) + 1 
        });
    }

    // 3. Go back to Dashboard (Refresh List)
    await showSyncDashboard(interaction);
}

module.exports = { showSyncDashboard, handleUserSelection, saveSyncData };
