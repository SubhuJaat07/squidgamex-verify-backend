const { ActionRowBuilder, UserSelectMenuBuilder } = require("discord.js");
const { supabase, createEmbed, SETTINGS } = require("./config");

// 🔥 1. WHITELIST
async function handleWhitelist(interaction) {
    const action = interaction.options.getString("action");
    const gid = interaction.guild.id;
    const { data } = await supabase.from("guild_config").select("ping_whitelist").eq("guild_id", gid).single();
    let list = data?.ping_whitelist || [];

    if (action === "add") {
        const u = interaction.options.getUser("user"), r = interaction.options.getRole("role");
        if(u && !list.includes(u.id)) list.push(u.id);
        if(r && !list.includes(r.id)) list.push(r.id);
        await supabase.from("guild_config").upsert({ guild_id: gid, ping_whitelist: list }, {onConflict:'guild_id'});
        return interaction.reply({ embeds: [createEmbed("✅ Whitelist Updated", "Added successfully.", SETTINGS.COLOR_SUCCESS)] });
    }
    if (action === "remove") {
        const u = interaction.options.getUser("user"), r = interaction.options.getRole("role");
        if(u) list = list.filter(x=>x!==u.id); if(r) list = list.filter(x=>x!==r.id);
        await supabase.from("guild_config").upsert({ guild_id: gid, ping_whitelist: list }, {onConflict:'guild_id'});
        return interaction.reply("✅ Removed");
    }
    if (action === "list") return interaction.reply({ embeds: [createEmbed("🛡️ Whitelist", list.map(id=>`<@${id}>`).join("\n")||"Empty", SETTINGS.COLOR_INFO)] });
}

// 🔥 2. WELCOME (Fixed Logic)
async function handleWelcome(interaction) {
    const sub = interaction.options.getSubcommand();
    const gid = interaction.guild.id;
    if (sub === "channel") { await supabase.from("guild_config").upsert({ guild_id: gid, welcome_channel: interaction.options.getChannel("target").id, welcome_enabled: true }, {onConflict:'guild_id'}); return interaction.reply("✅ Channel Set"); }
    if (sub === "message") { await supabase.from("guild_config").upsert({ guild_id: gid, welcome_title: interaction.options.getString("title"), welcome_desc: interaction.options.getString("description") }, {onConflict:'guild_id'}); return interaction.reply("✅ Message Set"); }
    if (sub === "toggle") { await supabase.from("guild_config").upsert({ guild_id: gid, welcome_enabled: interaction.options.getString("state")==='on' }, {onConflict:'guild_id'}); return interaction.reply("✅ Updated"); }
    if (sub === "test") { await trackJoin(interaction.member); return interaction.reply({content:"Sent test", ephemeral:true}); }
}

// 🔥 3. TRACK JOIN (Fixed Placeholders)
async function trackJoin(member) {
    try {
        // Track
        await supabase.from("joins").insert({ guild_id: member.guild.id, user_id: member.id, inviter_id: 'unknown', code: 'auto' });
        
        // Fetch Config
        const { data: config } = await supabase.from("guild_config").select("*").eq("guild_id", member.guild.id).maybeSingle();
        
        if (config?.welcome_enabled && config?.welcome_channel) {
            const ch = member.guild.channels.cache.get(config.welcome_channel);
            if(ch) {
                // Determine Inviter (Best Effort)
                let inviterText = "Unknown";
                const { data: joinData } = await supabase.from("joins").select("inviter_id").eq("guild_id", member.guild.id).eq("user_id", member.id).maybeSingle();
                if(joinData && joinData.inviter_id && joinData.inviter_id !== 'unknown') inviterText = `<@${joinData.inviter_id}>`;

                // Replace Placeholders
                const title = (config.welcome_title || "Welcome!").replace(/{user}/g, member.user.username);
                const desc = (config.welcome_desc || "Welcome {user} to the server!")
                    .replace(/{user}/g, `<@${member.id}>`)
                    .replace(/{count}/g, member.guild.memberCount)
                    .replace(/{inviter}/g, inviterText);

                ch.send({ embeds: [createEmbed(title, desc, SETTINGS.COLOR_SUCCESS, member.user)] });
            }
        }
    } catch(e){ console.error("Welcome Error", e); }
}

async function handleRewards(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "add") { await supabase.from("invite_rewards").insert({ guild_id: interaction.guild.id, invites_required: interaction.options.getInteger("invites"), role_id: interaction.options.getRole("role").id }); return interaction.reply("✅ Added"); }
    if (sub === "remove") { await supabase.from("invite_rewards").delete().eq("id", interaction.options.getInteger("id")); return interaction.reply("✅ Removed"); }
    if (sub === "list") { const {data}=await supabase.from("invite_rewards").select("*"); return interaction.reply({embeds:[createEmbed("🎁 Rewards", data.map(r=>`ID: ${r.id} • ${r.invites_required} Invites ➜ <@&${r.role_id}>`).join("\n"))]}); }
}

async function showBatchSync(interaction) {
    const members = await interaction.guild.members.fetch(); 
    const { data: joins } = await supabase.from("joins").select("user_id").eq("guild_id", interaction.guild.id);
    const recorded = new Set(joins ? joins.map(j => j.user_id) : []);
    const missing = members.filter(m => !m.user.bot && !recorded.has(m.id)).first(5);
    if (missing.length === 0) return interaction.editReply("✅ All Synced");
    const desc = missing.map((m, i) => `**${i+1}.** ${m} (${m.user.tag})`).join("\n");
    const comp = missing.map((m, i) => new ActionRowBuilder().addComponents(new UserSelectMenuBuilder().setCustomId(`sync_fix_${m.id}`).setPlaceholder(`Inviter for ${m.user.username}?`).setMaxValues(1)));
    const embed = createEmbed(`📋 Sync Batch`, desc, SETTINGS.COLOR_WARN);
    if(interaction.message) interaction.update({embeds:[embed], components:comp}); else interaction.editReply({embeds:[embed], components:comp});
}

async function handleBatchSync(interaction) {
    try{await interaction.deferUpdate();}catch(e){}
    const t = interaction.customId.replace("sync_fix_", ""), i = interaction.values[0];
    await supabase.from("joins").upsert({ guild_id: interaction.guild.id, user_id: t, inviter_id: i, code: "manual" });
    if(i!=='left_user') { const {data:ex}=await supabase.from("invite_stats").select("*").eq("guild_id",interaction.guild.id).eq("inviter_id",i).maybeSingle(); await supabase.from("invite_stats").upsert({guild_id:interaction.guild.id, inviter_id:i, real_invites:(ex?.real_invites||0)+1}); }
    await showBatchSync(interaction);
}

async function handleLeaderboard(interaction) {
    await interaction.deferReply();
    const { data } = await supabase.from("invite_stats").select("*").eq("guild_id", interaction.guild.id).order("real_invites", {ascending:false}).limit(10);
    return interaction.editReply({embeds:[createEmbed("🏆 Leaderboard", data.map((u,i)=>`#${i+1} <@${u.inviter_id}> • ${u.real_invites}`).join("\n")||"No Data", 0xFFD700)]});
}

module.exports = { handleWhitelist, handleWelcome, handleRewards, trackJoin, showBatchSync, handleBatchSync, handleLeaderboard };
