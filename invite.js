/**********************************************************************
 * 📨 INVITE & WELCOME SYSTEM
 * Handles tracking, syncing, rewards, and welcome messages.
 **********************************************************************/

const { ActionRowBuilder, UserSelectMenuBuilder } = require("discord.js");
const { supabase, EmbedFactory, SETTINGS } = require("./config");

// ==========================================
// 🔥 1. WELCOME MANAGER (MERGED)
// ==========================================
async function handleWelcomeSystem(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    // A. Set Channel
    if (sub === "channel") {
        const ch = interaction.options.getChannel("target");
        await supabase.from("guild_config").upsert({ guild_id: guildId, welcome_channel: ch.id, welcome_enabled: true }, { onConflict: 'guild_id' });
        return interaction.reply({ embeds: [EmbedFactory.success("✅ Channel Set", `Welcome messages will be sent to ${ch}`)] });
    }

    // B. Set Message
    if (sub === "message") {
        const title = interaction.options.getString("title");
        const desc = interaction.options.getString("description");
        await supabase.from("guild_config").upsert({ guild_id: guildId, welcome_title: title, welcome_desc: desc }, { onConflict: 'guild_id' });
        return interaction.reply({ embeds: [EmbedFactory.success("✅ Message Updated", `**Title:** ${title}\n**Desc:** ${desc}`)] });
    }

    // C. Toggle
    if (sub === "toggle") {
        const state = interaction.options.getString("state") === 'on';
        await supabase.from("guild_config").upsert({ guild_id: guildId, welcome_enabled: state }, { onConflict: 'guild_id' });
        return interaction.reply({ embeds: [EmbedFactory.create("⚙️ Settings", `Welcome System is now **${state ? 'ENABLED' : 'DISABLED'}**`, state ? SETTINGS.COLORS.SUCCESS : SETTINGS.COLORS.ERROR)] });
    }

    // D. Test
    if (sub === "test") {
        await trackJoin(interaction.member); // Simulates a join
        return interaction.reply({ content: "✅ Test message triggered.", ephemeral: true });
    }
}

// ==========================================
// 🔥 2. REWARD MANAGER (MERGED)
// ==========================================
async function handleRewardSystem(interaction) {
    const sub = interaction.options.getSubcommand();
    
    if (sub === "add") {
        const invites = interaction.options.getInteger("invites");
        const role = interaction.options.getRole("role");
        await supabase.from("invite_rewards").insert({ guild_id: interaction.guild.id, invites_required: invites, role_id: role.id });
        return interaction.reply({ embeds: [EmbedFactory.success("✅ Reward Added", `**${invites} Invites** ➜ ${role}`)] });
    }

    if (sub === "remove") {
        const id = interaction.options.getInteger("id");
        await supabase.from("invite_rewards").delete().eq("id", id);
        return interaction.reply({ embeds: [EmbedFactory.create("🗑️ Reward Removed", `Reward ID \`${id}\` deleted.`, SETTINGS.COLORS.WARNING)] });
    }

    if (sub === "list") {
        const { data } = await supabase.from("invite_rewards").select("*").eq("guild_id", interaction.guild.id).order("invites_required");
        const list = data.map(r => `• ID: \`${r.id}\` | **${r.invites_required}** Invites ➜ <@&${r.role_id}>`).join("\n") || "No rewards set.";
        return interaction.reply({ embeds: [EmbedFactory.create("🎁 Invite Rewards", list)] });
    }
}

// ==========================================
// 🔥 3. STATS & TRACKING
// ==========================================
async function handleLeaderboard(interaction) {
    await interaction.deferReply();
    const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).limit(10);
    
    const desc = data.map((u, i) => {
        const medal = i===0 ? "🥇" : i===1 ? "🥈" : i===2 ? "🥉" : `**#${i+1}**`;
        return `${medal} <@${u.inviter_id}> • **${u.real_invites}** Invites`;
    }).join("\n") || "No data yet.";

    return interaction.editReply({ embeds: [EmbedFactory.create("🏆 Top 10 Inviters", desc, SETTINGS.COLORS.GOLD)] });
}

async function handleWhoInvited(interaction) {
    const user = interaction.options.getUser("user");
    const { data } = await supabase.from("joins").select("*").eq("guild_id", interaction.guild.id).eq("user_id", user.id).maybeSingle();
    
    const inviter = data ? (data.inviter_id === 'unknown' || data.inviter_id === 'left_user' ? "Unknown / Left" : `<@${data.inviter_id}>`) : "No Record";
    const type = data ? data.code : "N/A";

    return interaction.reply({ embeds: [EmbedFactory.create("🕵️ User Invite Info", `**Target:** ${user}\n**Invited By:** ${inviter}\n**Method:** ${type}`)] });
}

async function trackJoin(member) {
    try {
        // Simplified tracking logic (Cache handling assumed in main index.js for robustness)
        await supabase.from("joins").insert({ guild_id: member.guild.id, user_id: member.id, inviter_id: 'unknown', code: 'auto' });

        // Send Welcome Message
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
        if (config?.welcome_enabled && config?.welcome_channel) {
            const ch = member.guild.channels.cache.get(config.welcome_channel);
            if (ch) {
                const title = config.welcome_title || "Welcome!";
                const desc = (config.welcome_desc || "Welcome {user} to {guild}!").replace(/{user}/g, `<@${member.id}>`).replace(/{guild}/g, member.guild.name);
                const embed = EmbedFactory.success(title, desc).setThumbnail(member.user.displayAvatarURL());
                ch.send({ embeds: [embed] });
            }
        }
    } catch(e) { console.error("Track Error:", e); }
}

// ==========================================
// 🔥 4. MANUAL SYNC
// ==========================================
async function showBatchSync(interaction) {
    const members = await interaction.guild.members.fetch(); 
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", interaction.guild.id);
    const recordedIds = new Set(joins ? joins.map(j => j.user_id) : []);
    const missing = members.filter(m => !m.user.bot && !recordedIds.has(m.id)).first(5);

    if (missing.length === 0) return interaction.editReply({ embeds: [EmbedFactory.success("✅ Sync Complete", "All users are tracked.")] });

    const desc = missing.map((m, i) => `**${i+1}.** ${m} (${m.user.tag})`).join("\n");
    const components = missing.map((m, i) => new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder().setCustomId(`sync_fix_${m.id}`).setPlaceholder(`${i+1}. Who invited ${m.user.username}?`).setMaxValues(1)
    ));

    const embed = EmbedFactory.create(`📋 Sync Batch (${missing.length})`, desc, SETTINGS.COLORS.WARNING);
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

module.exports = { handleWelcomeSystem, handleRewardSystem, trackJoin, showBatchSync, handleBatchSync, handleLeaderboard, handleWhoInvited };
