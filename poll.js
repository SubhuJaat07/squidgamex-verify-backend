const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { supabase, createEmbed, SETTINGS, logToWebhook } = require("./config");

async function handlePollCreate(interaction) {
    const q = interaction.options.getString("q");
    const opts = [
        interaction.options.getString("o1"), interaction.options.getString("o2"),
        interaction.options.getString("o3"), interaction.options.getString("o4"), 
        interaction.options.getString("o5")
    ].filter(o => o);
    
    const pRole = interaction.options.getRole("punish_role");
    const multi = interaction.options.getBoolean("multiple") || false;

    // DB Insert
    const { data, error } = await supabase.from("polls").insert({ 
        question: q, 
        option1: opts[0], option2: opts[1]||"", option3: opts[2]||"", option4: opts[3]||"", option5: opts[4]||"", 
        is_active: true, 
        allow_multiple: multi, 
        punish_role_id: pRole?.id, 
        channel_id: interaction.channel.id 
    }).select().single();

    if(error) return interaction.reply({ content: "❌ DB Error: " + error.message, ephemeral: true });

    const embed = createEmbed(`📊 Poll #${data.id}`, `**${q}**\n\n` + opts.map((o,i)=>`**${i+1}️⃣** ${o}`).join('\n') + `\n\n🛑 **Settings:**\n• Multi-Vote: ${multi ? '✅' : '❌'}\n• Punishment: ${pRole ? pRole : "None"}`, SETTINGS.COLOR_WARN);
    
    const row = new ActionRowBuilder();
    opts.forEach((_, i) => row.addComponents(new ButtonBuilder().setCustomId(`vote_${data.id}_${i+1}`).setLabel(`${i+1}`).setStyle(ButtonStyle.Primary)));

    await interaction.channel.send({ content: "@everyone", embeds: [embed], components: [row] });
    return interaction.reply({ content: "✅ Poll Created Successfully!", ephemeral: true });
}

async function handlePollVote(interaction) {
    const [_, pid, ch] = interaction.customId.split('_');
    const pollId = parseInt(pid);
    const choice = parseInt(ch);

    await interaction.deferReply({ ephemeral: true });

    const { data: poll } = await supabase.from("polls").select("*").eq("id", pollId).single();
    if (!poll.is_active) return interaction.editReply("❌ **This poll has ended!**");

    // Handle Multi-Vote Logic
    if (!poll.allow_multiple) {
        // If single choice, remove previous votes
        await supabase.from("poll_votes").delete().eq("poll_id", pollId).eq("user_id", interaction.user.id);
    } else {
        // If multi choice, check if already voted this option to toggle
        const { data: exists } = await supabase.from("poll_votes").select("*").eq("poll_id", pollId).eq("user_id", interaction.user.id).eq("choice", choice).maybeSingle();
        if (exists) {
            await supabase.from("poll_votes").delete().eq("poll_id", pollId).eq("user_id", interaction.user.id).eq("choice", choice);
            return interaction.editReply("🗑️ **Vote Retracted.**");
        }
    }

    // Insert Vote
    await supabase.from("poll_votes").upsert({ poll_id: pollId, user_id: interaction.user.id, choice: choice });

    // Update Live Count
    const { count } = await supabase.from("poll_votes").select("*", { count: 'exact', head: true }).eq("poll_id", pollId);
    
    // Update Embed Footer
    try {
        const msg = interaction.message;
        const oldEmbed = msg.embeds[0];
        const newEmbed = EmbedBuilder.from(oldEmbed).setFooter({ text: `Squid Game X • Live Total Votes: ${count}`, iconURL: SETTINGS.FOOTER_ICON });
        await msg.edit({ embeds: [newEmbed] });
    } catch(e) {}

    return interaction.editReply("✅ **Vote Recorded!**");
}

async function handlePollEnd(interaction) {
    await interaction.deferReply();
    const pid = interaction.options.getInteger("id");
    const durationStr = interaction.options.getString("duration") || "24h";

    // Stop Poll
    const { error } = await supabase.from("polls").update({ is_active: false }).eq("id", pid);
    if(error) return interaction.editReply("❌ Poll ID Not Found or DB Error.");

    const { data: poll } = await supabase.from("polls").select("*").eq("id", pid).single();
    const { data: votes } = await supabase.from("poll_votes").select("user_id").eq("poll_id", pid);
    
    // Determine Voters
    const voterSet = new Set(votes.map(v => v.user_id));
    
    let punishedCount = 0;
    
    // Punishment Logic
    if (poll.punish_role_id) {
        const role = interaction.guild.roles.cache.get(poll.punish_role_id);
        if (role) {
            const members = await interaction.guild.members.fetch();
            for (const [id, m] of members) {
                if (!m.user.bot && !voterSet.has(id)) {
                    await m.roles.add(role).catch(() => {});
                    try {
                        const dmEmbed = createEmbed("⚠️ Poll Punishment Applied", 
                            `You missed **Poll #${pid}** in **${interaction.guild.name}**.\n\n**Punishment:**\nRole: ${role.name}\nDuration: ${durationStr}\n\n[Click to View Poll](https://discord.com/channels/${interaction.guild.id}/${poll.channel_id})\n\n*Make sure to vote next time to maintain access.*`, 
                            SETTINGS.COLOR_ERROR
                        );
                        await m.send({ embeds: [dmEmbed] });
                    } catch(e) {}
                    punishedCount++;
                }
            }
        }
    }

    logToWebhook("🛑 Poll Ended", `**Poll #${pid}** ended by ${interaction.user.tag}.\nTotal Votes: ${voterSet.size}\nPunished Users: ${punishedCount}`);
    
    return interaction.editReply({ embeds: [createEmbed(`🛑 Poll #${pid} Ended`, `**Results:**\n✅ Total Voters: ${voterSet.size}\n🚫 Punished Users: ${punishedCount}\n⏳ Punishment Duration: ${durationStr}`, SETTINGS.COLOR_INFO)] });
}

async function handlePollResults(interaction) {
    await interaction.deferReply();
    const pid = interaction.options.getInteger("pollid");
    const { data: poll } = await supabase.from("polls").select("*").eq("id", pid).maybeSingle();
    if(!poll) return interaction.editReply("❌ Poll Not Found");

    const { data: votes } = await supabase.from("poll_votes").select("user_id, choice").eq("poll_id", pid);
    
    let desc = `**Question:** ${poll.question}\n\n`;
    
    const options = [poll.option1, poll.option2, poll.option3, poll.option4, poll.option5].filter(o=>o);
    
    options.forEach((opt, i) => {
        const idx = i + 1;
        const optionVotes = votes.filter(v => v.choice === idx);
        desc += `**${idx}️⃣ ${opt}** (${optionVotes.length} Votes)\n`;
        
        // Show up to 20 names to prevent overflow
        const names = optionVotes.slice(0, 20).map(v => `<@${v.user_id}>`).join(", ");
        if(names) desc += `> ${names}${optionVotes.length > 20 ? '...' : ''}\n`;
        desc += "\n";
    });

    return interaction.editReply({ embeds: [createEmbed(`📊 Results for Poll #${pid}`, desc, SETTINGS.COLOR_INFO)] });
}

module.exports = { handlePollCreate, handlePollVote, handlePollEnd, handlePollResults };
