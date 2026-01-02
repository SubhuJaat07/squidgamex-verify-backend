const { ActionRowBuilder, UserSelectMenuBuilder } = require("discord.js");
const { supabase, createEmbed, SETTINGS } = require("./config");

// 🔥 1. MERGED WELCOME SYSTEM
async function handleWelcome(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === "channel") {
        const ch = interaction.options.getChannel("target");
        await supabase.from("guild_config").upsert({ guild_id: guildId, welcome_channel: ch.id, welcome_enabled: true }, { onConflict: 'guild_id' });
        return interaction.reply({ embeds: [createEmbed("✅ Channel Set", `Welcome messages will go to ${ch}`, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "message") {
        const title = interaction.options.getString("title");
        const desc = interaction.options.getString("description");
        await supabase.from("guild_config").upsert({ guild_id: guildId, welcome_title: title, welcome_desc: desc }, { onConflict: 'guild_id' });
        return interaction.reply({ embeds: [createEmbed("✅ Message Updated", `**Title:** ${title}\n**Desc:** ${desc}`, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "toggle") {
        const state = interaction.options.getString("state") === 'on';
        await supabase.from("guild_config").upsert({ guild_id: guildId, welcome_enabled: state }, { onConflict: 'guild_id' });
        return interaction.reply({ embeds: [createEmbed("⚙️ Settings", `Welcome Message: **${state ? 'ENABLED' : 'DISABLED'}**`, state ? SETTINGS.COLOR_SUCCESS : SETTINGS.COLOR_WARN)] });
    }

    if (sub === "test") {
        await trackJoin(interaction.member);
        return interaction.reply({ content: "✅ Test Sent", ephemeral: true });
    }
}

// 🔥 2. MERGED REWARDS SYSTEM
async function handleRewards(interaction) {
    const sub = interaction.options.getSubcommand();
    
    if (sub === "add") {
        const invites = interaction.options.getInteger("invites");
        const role = interaction.options.getRole("role");
        await supabase.from("invite_rewards").insert({ guild_id: interaction.guild.id, invites_required: invites, role_id: role.id });
        return interaction.reply({ embeds: [createEmbed("✅ Reward Added", `**${invites} Invites** ➜ <@&${role.id}>`, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "remove") {
        const id = interaction.options.getInteger("id");
        await supabase.from("invite_rewards").delete().eq("id", id);
        return interaction.reply({ embeds: [createEmbed("🗑️ Reward Removed", `Reward ID: ${id} deleted.`, SETTINGS.COLOR_WARN)] });
    }

    if (sub === "list") {
        const { data } = await supabase.from("invite_rewards").select("*").eq("guild_id", interaction.guild.id).order("invites_required");
        const list = data.map(r => `**ID: ${r.id}** • **${r.invites_required}** Invites ➜ <@&${r.role_id}>`).join("\n") || "No rewards.";
        return interaction.reply({ embeds: [createEmbed("🎁 Rewards List", list, SETTINGS.COLOR_INFO)] });
    }
}

// 🔥 3. SYNC & TRACKER
async function trackJoin(member) {
    try {
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
        if (config?.welcome_enabled && config?.welcome_channel) {
            const ch = member.guild.channels.cache.get(config.welcome_channel);
            if (ch) {
                const title = config.welcome_title || "Welcome!";
                const desc = (config.welcome_desc || "Welcome {user} to {guild}!").replace(/{user}/g, `<@${member.id}>`).replace(/{guild}/g, member.guild.name);
                ch.send({ embeds: [createEmbed(title, desc, SETTINGS.COLOR_SUCCESS, member.user)] });
            }
        }
    } catch(e) {}
}

async function showBatchSync(interaction) {
    const members = await interaction.guild.members.fetch(); 
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", interaction.guild.id);
    const recordedIds = new Set(joins ? joins.map(j => j.user_id) : []);
    const missing = members.filter(m => !m.user.bot && !recordedIds.has(m.id)).first(5);

    if (missing.length === 0) return interaction.editReply({ embeds: [createEmbed("✅ All Synced", "No missing data.", SETTINGS.COLOR_SUCCESS)] });

    const desc = missing.map((m, i) => `**${i+1}.** ${m} (${m.user.tag})`).join("\n");
    const components = missing.map((m, i) => new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`sync_fix_${m.id}`).setPlaceholder(`${i+1}. Who invited ${m.user.username}?`).setMaxValues(1)
    ));

    const embed = createEmbed(`📋 Sync Batch (${missing.length})`, desc, SETTINGS.COLOR_WARN);
    if(interaction.message) interaction.update({embeds:[embed], components:components});
    else interaction.editReply({embeds:[embed], components:components});
}

async function handleBatchSync(interaction) {
    try{ await interaction.deferUpdate(); }catch(e){}
    const target = interaction.customId.replace("sync_fix_", "");
    const inviter = interaction.values[0];
    await supabase.from("joins").upsert({ guild_id: interaction.guild.id, user_id: target, inviter_id: inviter, code: "manual" });
    if(inviter !== 'left_user') {
        const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", inviter).maybeSingle();
        await supabase.from("invite_stats").upsert({ guild_id: interaction.guild.id, inviter_id: inviter, real_invites: (ex?.real_invites||0)+1 });
    }
    await showBatchSync(interaction);
}

module.exports = { handleWelcome, handleRewards, trackJoin, showBatchSync, handleBatchSync };
