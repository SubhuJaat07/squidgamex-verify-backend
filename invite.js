const { ActionRowBuilder, UserSelectMenuBuilder, EmbedBuilder } = require("discord.js");
const { supabase, createEmbed, SETTINGS } = require("./config");

// 🔥 LEADERBOARD
async function handleLeaderboard(interaction) {
    await interaction.deferReply();
    const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", { ascending: false }).limit(10);
    
    let desc = "";
    if (data && data.length > 0) {
        data.forEach((u, i) => {
            let medal = i===0 ? "🥇" : i===1 ? "🥈" : i===2 ? "🥉" : `**#${i+1}**`;
            desc += `${medal} <@${u.inviter_id}> • **${u.real_invites}** Invites\n`;
        });
    } else { desc = "No data available yet."; }
        
    return interaction.editReply({ embeds: [createEmbed("🏆 Top 10 Inviters", desc, 0xFFD700)] });
}

// 🔥 WHO INVITED
async function handleWhoInvited(interaction) {
    await interaction.deferReply();
    const user = interaction.options.getUser("user");
    const { data } = await supabase.from("joins").select("*").eq("guild_id", interaction.guild.id).eq("user_id", user.id).maybeSingle();
    
    if (!data) return interaction.editReply("❌ No invite record found.");
    
    const inviter = data.inviter_id === 'unknown' || data.inviter_id === 'left_user' ? "Unknown / Left" : `<@${data.inviter_id}>`;
    return interaction.editReply({ embeds: [createEmbed(`🕵️ User Info`, `**Target:** ${user}\n**Invited By:** ${inviter}\n**Method:** \`${data.code}\``, 0x00FFFF)] });
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
        const embed = createEmbed("✅ Sync Complete", "Database is up to date.", 0x00FF00);
        if (interaction.message) return interaction.update({ content: null, embeds: [embed], components: [] });
        return interaction.editReply({ content: null, embeds: [embed], components: [] });
    }

    const description = missingBatch.map((m, i) => `**${i+1}.** ${m} (${m.user.tag})`).join("\n");
    const embed = createEmbed(`📋 Sync Batch (${missingBatch.length})`, `**Select Inviter for the users below:**\n\n${description}`, 0xFFA500);

    const components = missingBatch.map((m, i) => {
        return new ActionRowBuilder().addComponents(
            new UserSelectMenuBuilder().setCustomId(`sync_fix_${m.id}`).setPlaceholder(`${i+1}. Who invited ${m.user.username.substring(0, 10)}?`).setMaxValues(1)
        );
    });

    const payload = { content: null, embeds: [embed], components: components };
    if (interaction.message) await interaction.update(payload);
    else await interaction.editReply(payload);
}

// 🔥 HANDLE BATCH SAVE (SYNC FIX)
async function handleBatchSync(interaction) {
    try { await interaction.deferUpdate(); } catch(e){}
    const targetUserId = interaction.customId.replace("sync_fix_", "");
    const inviterId = interaction.values[0];

    // 1. Insert Join
    await supabase.from("joins").upsert({ guild_id: interaction.guild.id, user_id: targetUserId, inviter_id: inviterId, code: "manual_sync" });
    
    // 2. Insert Stats (Crucial Fix)
    if (inviterId !== 'left_user') {
        const { data: ex } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).eq("inviter_id", inviterId).maybeSingle();
        await supabase.from("invite_stats").upsert({ 
            guild_id: interaction.guild.id, 
            inviter_id: inviterId, 
            total_invites: (ex?.total_invites||0)+1, 
            real_invites: (ex?.real_invites||0)+1 
        });
        await checkRewards(interaction.guild, inviterId);
    }
    await showBatchSync(interaction);
}

// 🔥 REWARDS & CONFIG
async function handleAddReward(interaction) {
    if(!await require("./config").isAdmin(interaction.user.id)) return interaction.reply({content: "❌ Admin", ephemeral:true});
    const invites = interaction.options.getInteger("invites");
    const role = interaction.options.getRole("role");
    await supabase.from("invite_rewards").insert({ guild_id: interaction.guild.id, invites_required: invites, role_id: role.id });
    return interaction.reply(`✅ Reward Set: **${invites} Invites** -> <@&${role.id}>`);
}

async function checkRewards(guild, inviterId) {
    if(!inviterId || inviterId === 'unknown') return;
    const { data: stats } = await supabase.from("invite_stats").select("*").eq("guild_id", guild.id).eq("inviter_id", inviterId).maybeSingle();
    const { data: rewards } = await supabase.from("invite_rewards").select("*").eq("guild_id", guild.id);
    
    if(stats && rewards) {
        const member = await guild.members.fetch(inviterId).catch(()=>null);
        if(member) {
            for(const r of rewards) {
                if(stats.real_invites >= r.invites_required) {
                    const hasLog = await supabase.from("reward_logs").select("*").eq("user_id", inviterId).eq("invites_required", r.invites_required).maybeSingle();
                    if(!hasLog.data) {
                        const role = guild.roles.cache.get(r.role_id);
                        if(role) await member.roles.add(role).catch(()=>{});
                        await supabase.from("reward_logs").insert({ guild_id: guild.id, user_id: inviterId, invites_required: r.invites_required });
                    }
                }
            }
        }
    }
}

async function trackJoin(member) {
    try {
        await supabase.from("joins").insert({ guild_id: member.guild.id, user_id: member.id, inviter_id: 'unknown', code: 'auto' });
        // Welcome message logic here (kept brief)
    } catch(e) {}
}

module.exports = { showBatchSync, handleBatchSync, trackJoin, handleLeaderboard, handleWhoInvited, handleAddReward };
