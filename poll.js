const { 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} = require("discord.js");

const { 
    SETTINGS, 
    supabase, 
    createEmbed, 
    logToWebhook 
} = require("./config");

// =====================================================================
// 📊 HELPER: PROGRESS BAR GENERATOR
// =====================================================================
function createProgressBar(current, total, size = 10) {
    if (total === 0) return "⬜".repeat(size);
    const percentage = current / total;
    const progress = Math.round(size * percentage);
    const empty = size - progress;
    return "🟦".repeat(progress) + "⬜".repeat(empty);
}

// =====================================================================
// 📝 1. CREATE POLL
// =====================================================================
async function handlePollCreate(interaction) {
    // 🛡️ Admin Check is handled in index.js, but extra safety implies intentional design.
    
    const question = interaction.options.getString("q");
    const options = [
        interaction.options.getString("o1"),
        interaction.options.getString("o2"),
        interaction.options.getString("o3"),
        interaction.options.getString("o4"),
        interaction.options.getString("o5")
    ].filter(o => o); // Remove empty/null options

    const punishRole = interaction.options.getRole("punish_role");
    const allowMulti = interaction.options.getBoolean("multiple") || false;

    // 1. Insert into Database
    const { data, error } = await supabase.from("polls").insert({ 
        question: question, 
        option1: options[0], 
        option2: options[1] || null, 
        option3: options[2] || null, 
        option4: options[3] || null, 
        option5: options[4] || null, 
        is_active: true, 
        allow_multiple: allowMulti, 
        punish_role_id: punishRole?.id || null, 
        channel_id: interaction.channel.id,
        created_at: new Date().toISOString()
    }).select().single();

    if (error) {
        console.error("Poll DB Error:", error);
        return interaction.reply({ content: "❌ **Database Error:** Could not create poll.", ephemeral: true });
    }

    // 2. Build Buttons
    const row = new ActionRowBuilder();
    options.forEach((opt, index) => {
        row.addComponents(
            new ButtonBuilder()
                .setCustomId(`vote_${data.id}_${index + 1}`)
                .setLabel(`${index + 1}`) // Simple Number Labels
                .setStyle(ButtonStyle.Primary)
        );
    });

    // 3. Build Aesthetic Embed
    const embed = createEmbed(`📊 Poll #${data.id} Started`, `**${question}**`, SETTINGS.COLOR_INFO)
        .addFields(
            { name: "Options", value: options.map((o, i) => `**${i + 1}️⃣** ${o}`).join("\n"), inline: false },
            { name: "⚙️ Settings", value: `• **Multi-Vote:** ${allowMulti ? "✅ Enabled" : "❌ Disabled"}\n• **Punishment:** ${punishRole ? `${punishRole}` : "*None*"}`, inline: false }
        )
        .setThumbnail("https://cdn-icons-png.flaticon.com/512/2645/2645897.png") // Poll Icon
        .setFooter({ text: "Click the buttons below to vote! • Live Count: 0", iconURL: SETTINGS.FOOTER_ICON });

    // 4. Send & Reply
    await interaction.channel.send({ content: "@everyone", embeds: [embed], components: [row] });
    return interaction.reply({ content: "✅ **Poll Launched Successfully!**", ephemeral: true });
}

// =====================================================================
// 🗳️ 2. HANDLE VOTING (LIVE UPDATE)
// =====================================================================
async function handlePollVote(interaction) {
    const [_, pid, choiceIndex] = interaction.customId.split('_');
    const pollId = parseInt(pid);
    const choice = parseInt(choiceIndex);

    await interaction.deferReply({ ephemeral: true });

    // 1. Fetch Poll Data
    const { data: poll } = await supabase.from("polls").select("*").eq("id", pollId).single();
    
    if (!poll) return interaction.editReply("❌ **Error:** Poll not found in database.");
    if (!poll.is_active) return interaction.editReply("🛑 **Voting Closed:** This poll has ended.");

    // 2. Voting Logic
    const userId = interaction.user.id;
    
    // Check existing vote for this specific choice
    const { data: existingVote } = await supabase.from("poll_votes")
        .select("*")
        .eq("poll_id", pollId)
        .eq("user_id", userId)
        .eq("choice", choice)
        .maybeSingle();

    if (poll.allow_multiple) {
        // TOGGLE LOGIC: If checked, uncheck. If not, check.
        if (existingVote) {
            await supabase.from("poll_votes").delete().eq("poll_id", pollId).eq("user_id", userId).eq("choice", choice);
            await updateLiveCount(interaction, pollId);
            return interaction.editReply("🗑️ **Vote Removed.**");
        } else {
            await supabase.from("poll_votes").insert({ poll_id: pollId, user_id: userId, choice: choice });
        }
    } else {
        // SINGLE CHOICE LOGIC: Wipe previous votes for this user on this poll, then add new.
        // Optimization: Delete all votes by user for this poll first
        await supabase.from("poll_votes").delete().eq("poll_id", pollId).eq("user_id", userId);
        
        // Add new vote
        await supabase.from("poll_votes").insert({ poll_id: pollId, user_id: userId, choice: choice });
    }

    // 3. Update Message UI (Live Count)
    await updateLiveCount(interaction, pollId);

    return interaction.editReply("✅ **Vote Recorded!**");
}

/**
 * Updates the footer of the poll message with the total vote count.
 */
async function updateLiveCount(interaction, pollId) {
    try {
        const { count } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId);
        
        const msg = interaction.message;
        const oldEmbed = msg.embeds[0];
        
        const newEmbed = EmbedBuilder.from(oldEmbed)
            .setFooter({ text: `Click buttons to vote! • Live Total Votes: ${count}`, iconURL: SETTINGS.FOOTER_ICON });
            
        await msg.edit({ embeds: [newEmbed] });
    } catch (e) {
        console.error("Live Update Error:", e);
    }
}

// =====================================================================
// 🛑 3. END POLL (PUNISHMENT SYSTEM)
// =====================================================================
async function handlePollEnd(interaction) {
    await interaction.deferReply();
    const pid = interaction.options.getInteger("id");
    const durationStr = interaction.options.getString("duration") || "24h";

    // 1. Mark Inactive
    const { error } = await supabase.from("polls").update({ is_active: false }).eq("id", pid);
    if (error) return interaction.editReply("❌ **Error:** Could not find Poll ID or Database error.");

    // 2. Fetch Data
    const { data: poll } = await supabase.from("polls").select("*").eq("id", pid).single();
    const { data: votes } = await supabase.from("poll_votes").select("user_id").eq("poll_id", pid);
    
    // Unique Voters Set
    const voterIds = new Set(votes.map(v => v.user_id));
    
    let punishedCount = 0;
    let punishmentLog = "None";

    // 3. Apply Punishment
    if (poll.punish_role_id) {
        const role = interaction.guild.roles.cache.get(poll.punish_role_id);
        
        if (role) {
            punishmentLog = `${role.name} (${durationStr})`;
            const members = await interaction.guild.members.fetch(); // Fetch all members to find non-voters
            
            // Loop through all members
            for (const [memberId, member] of members) {
                if (member.user.bot) continue; // Ignore bots

                if (!voterIds.has(memberId)) {
                    // PUNISH HIM!
                    await member.roles.add(role).catch(e => console.log(`Failed to punish ${member.user.tag}: Missing Perms`));
                    
                    // Send DM
                    try {
                        const dmEmbed = createEmbed("⚠️ Access Restricted (Poll Missed)", null, SETTINGS.COLOR_ERROR)
                            .setDescription(`You failed to vote in **Poll #${pid}** in **${interaction.guild.name}**.\nAs per server rules, you have been temporarily restricted.`)
                            .addFields(
                                { name: "👮 Punishment Role", value: `${role.name}`, inline: true },
                                { name: "⏳ Duration", value: `${durationStr}`, inline: true },
                                { name: "🔗 Poll Link", value: `[View Missed Poll](https://discord.com/channels/${interaction.guild.id}/${poll.channel_id})`, inline: false }
                            )
                            .setFooter({ text: "Vote in future polls to avoid this!" });
                        
                        await member.send({ embeds: [dmEmbed] });
                    } catch (e) {
                        // DMs closed, ignore
                    }
                    punishedCount++;
                }
            }
        } else {
            punishmentLog = "Role Deleted/Invalid";
        }
    }

    // 4. Log & Reply
    await logToWebhook("🛑 Poll Ended", `**ID:** #${pid}\n**Voters:** ${voterIds.size}\n**Punished:** ${punishedCount}\n**By:** ${interaction.user.tag}`);

    const endEmbed = createEmbed(`🛑 Poll #${pid} Ended`, null, SETTINGS.COLOR_WARN)
        .addFields(
            { name: "✅ Total Voters", value: `${voterIds.size}`, inline: true },
            { name: "🚫 Punished Users", value: `${punishedCount}`, inline: true },
            { name: "⚖️ Punishment", value: punishmentLog, inline: true }
        );

    return interaction.editReply({ embeds: [endEmbed] });
}

// =====================================================================
// 📈 4. POLL RESULTS (VISUALIZED)
// =====================================================================
async function handlePollResults(interaction) {
    await interaction.deferReply();
    const pid = interaction.options.getInteger("pollid");

    const { data: poll } = await supabase.from("polls").select("*").eq("id", pid).maybeSingle();
    if (!poll) return interaction.editReply("❌ **Error:** Poll not found.");

    const { data: votes } = await supabase.from("poll_votes").select("user_id, choice").eq("poll_id", pid);
    
    // Calculate Stats
    const totalVotes = votes.length;
    const optionsText = [poll.option1, poll.option2, poll.option3, poll.option4, poll.option5].filter(o => o);
    
    let description = `**Question:** ${poll.question}\n\n`;

    optionsText.forEach((opt, i) => {
        const choiceIdx = i + 1;
        const optionVotes = votes.filter(v => v.choice === choiceIdx);
        const count = optionVotes.length;
        const percent = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        
        // Progress Bar
        const bar = createProgressBar(count, totalVotes || 1, 10); // 10 blocks long

        description += `**${choiceIdx}️⃣ ${opt}**\n`;
        description += `\`${bar}\` **${percent}%** (${count} Votes)\n`;
        
        // List Voters (Truncated if too many)
        if (count > 0) {
            const votersList = optionVotes.slice(0, 15).map(v => `<@${v.user_id}>`).join(", ");
            const remaining = count - 15;
            description += `> 👥 ${votersList}${remaining > 0 ? ` *+ ${remaining} more...*` : ""}\n`;
        }
        description += "\n";
    });

    const embed = createEmbed(`📊 Detailed Results: Poll #${pid}`, description, SETTINGS.COLOR_INFO)
        .setFooter({ text: `Total Votes Cast: ${totalVotes}`, iconURL: SETTINGS.FOOTER_ICON });

    return interaction.editReply({ embeds: [embed] });
}

// =====================================================================
// 📤 EXPORTS
// =====================================================================
module.exports = { 
    handlePollCreate, 
    handlePollVote, 
    handlePollEnd, 
    handlePollResults 
};
