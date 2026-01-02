const { SETTINGS, supabase, createEmbed, formatTime, parseDuration, logToWebhook } = require("./config");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require("discord.js");

// 🔥 1. ACTIVE USERS (PAGINATION + ALTS)
async function handleActiveUsers(interaction, page = 1) {
    const LIMIT = 10;
    const offset = (page - 1) * LIMIT;

    // Fetch Active Users
    const { data: users, count } = await supabase.from("verifications")
        .select("*", { count: 'exact' })
        .eq("verified", true)
        .gt("expires_at", new Date().toISOString())
        .range(offset, offset + LIMIT - 1);

    if (!users || users.length === 0) return interaction.reply({ embeds: [createEmbed("🔴 Active Users", "No active sessions found.", SETTINGS.COLOR_ERROR)], ephemeral: true });

    // Detect Alts (Clients with same HWID/Discord)
    const { data: allActive } = await supabase.from("verifications").select("discord_id").eq("verified", true);
    const altMap = {};
    allActive.forEach(u => { if(u.discord_id) altMap[u.discord_id] = (altMap[u.discord_id] || 0) + 1; });

    const description = users.map((u, i) => {
        const expiry = new Date(u.expires_at);
        const timeLeft = formatTime(expiry.getTime() - Date.now());
        const userTag = u.discord_id ? `<@${u.discord_id}>` : (u.note ? `📝 *${u.note}*` : "`Unknown`");
        const altWarn = (u.discord_id && altMap[u.discord_id] > 1) ? "⚠️ **Multi-Key**" : "";
        
        return `**${offset + i + 1}.** ${userTag}\n   └ 🔑 \`${u.code}\` | ⏳ ${timeLeft} ${altWarn}`;
    }).join("\n\n");

    const totalPages = Math.ceil(count / LIMIT);
    const embed = createEmbed(`🟢 Active Users (Page ${page}/${totalPages})`, description, SETTINGS.COLOR_SUCCESS)
        .setFooter({ text: `Total Online: ${count} Users` });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`active_prev_${page}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
        new ButtonBuilder().setCustomId(`active_next_${page}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
    );

    if (interaction.message) await interaction.update({ embeds: [embed], components: [row] });
    else await interaction.reply({ embeds: [embed], components: [row] });
}

// 🔥 2. DETAILED LOOKUP
async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    
    if (!data) return interaction.editReply({ embeds: [createEmbed("❌ Not Found", `No record found for: \`${target}\``, SETTINGS.COLOR_ERROR)] });

    // Fetch User for PFP
    let discordUser = null;
    if (data.discord_id) {
        try { discordUser = await interaction.client.users.fetch(data.discord_id); } catch(e){}
    }

    const expiryTime = data.expires_at ? new Date(data.expires_at) : null;
    const isExpired = expiryTime && expiryTime < new Date();
    const status = data.is_banned ? "🚫 BANNED" : (isExpired ? "🔴 EXPIRED" : "🟢 ACTIVE");

    const embed = createEmbed("🔍 User Lookup Details", "", data.is_banned ? SETTINGS.COLOR_ERROR : SETTINGS.COLOR_INFO, discordUser)
        .addFields(
            { name: "👤 User", value: data.discord_id ? `<@${data.discord_id}>` : "`Unlinked`", inline: true },
            { name: "📝 Note", value: data.note ? `\`${data.note}\`` : "`None`", inline: true },
            { name: "🔑 Key", value: `\`${data.code}\``, inline: true },
            { name: "📡 Status", value: `**${status}**`, inline: true },
            { name: "🖥️ HWID", value: `\`${data.hwid}\``, inline: false },
            { name: "📅 Expiry", value: expiryTime ? `<t:${Math.floor(expiryTime.getTime()/1000)}:F>` : "`N/A`", inline: true }
        );

    return interaction.editReply({ embeds: [embed] });
}

// 🔥 3. RULES SYSTEM
async function handleRules(interaction) {
    const sub = interaction.options.getSubcommand();
    
    if (sub === "set") {
        const role = interaction.options.getRole("role");
        const dur = interaction.options.getString("duration");
        await supabase.from("role_rules").upsert({ role_id: role.id, role_name: role.name, duration: dur }, { onConflict: 'role_id' });
        return interaction.reply({ embeds: [createEmbed("✅ Rule Updated", `**Role:** ${role}\n**Time:** \`${dur}\``, SETTINGS.COLOR_SUCCESS)] });
    }
    
    if (sub === "remove") {
        const role = interaction.options.getRole("role");
        await supabase.from("role_rules").delete().eq("role_id", role.id);
        return interaction.reply({ embeds: [createEmbed("🗑️ Rule Removed", `Deleted rule for **${role.name}**`, SETTINGS.COLOR_WARN)] });
    }

    if (sub === "list") {
        const { data } = await supabase.from("role_rules").select("*");
        const list = data.map(r => `• <@&${r.role_id}> ➜ **${r.duration}**`).join("\n") || "No rules set.";
        return interaction.reply({ embeds: [createEmbed("📜 Verification Rules", list, SETTINGS.COLOR_INFO)] });
    }
}

// 🔥 4. VERIFICATION LOGIC
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 Maintenance Mode", ephemeral: true });

    // Link Check
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    if (!link) return replyCallback({ embeds: [createEmbed("⚠️ Link Required", "Link Roblox first: `/linkroblox`", SETTINGS.COLOR_WARN)] });

    // Poll Punishment
    let isPollPunished = false;
    let pollUrl = "";
    if (SETTINGS.POLL_LOCK) {
        const { data: activePoll } = await supabase.from("polls").select("*").eq("is_active", true).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) {
                isPollPunished = true;
                pollUrl = `https://discord.com/channels/${SETTINGS.GUILD_ID}/${activePoll.channel_id}`; // Redirect to poll
            }
        }
    }

    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "Get key from game.", SETTINGS.COLOR_ERROR)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "You are permanently banned.", SETTINGS.COLOR_ERROR)] });

    // Calc Time
    let finalDuration = SETTINGS.DEFAULT_VERIFY_MS;
    let ruleName = "Default";
    
    if (isPollPunished) {
        finalDuration = SETTINGS.DEFAULT_PUNISH_MS;
        ruleName = "⚠️ POLL PENALTY";
    } else {
        // Boost Logic
        try {
            const member = await guild.members.fetch(user.id);
            const { data: rules } = await supabase.from("role_rules").select("*");
            if (rules) {
                let max = SETTINGS.DEFAULT_VERIFY_MS;
                rules.forEach(r => {
                    if (member.roles.cache.has(r.role_id)) {
                        const d = parseDuration(r.duration);
                        if (d === "LIFETIME") { max = "LIFETIME"; ruleName = "👑 Lifetime"; }
                        else if (max !== "LIFETIME" && d > max) { max = d; ruleName = `⭐ ${r.role_name}`; }
                    }
                });
                finalDuration = max;
            }
        } catch (e) {}
    }

    const expiryTime = finalDuration === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + finalDuration).toISOString();
    await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: user.id }).eq("id", userData.id);

    // LOG IF SUSPICIOUS (2 Keys)
    const { data: activeKeys } = await supabase.from("verifications").select("*").eq("discord_id", user.id).eq("verified", true);
    if (activeKeys && activeKeys.length > 1) {
        logToWebhook("⚠️ Suspicious Activity", `<@${user.id}> verified multiple keys!\nKeys: ${activeKeys.map(k=>k.code).join(", ")}`);
    }

    const embed = createEmbed(isPollPunished ? "⚠️ Verified (Restricted)" : "✅ Verification Successful", 
        isPollPunished ? `**You didn't vote!**\n[Click here to Vote](${pollUrl})\nPenalty applied.` : "**Access Granted!**", 
        isPollPunished ? SETTINGS.COLOR_WARN : SETTINGS.COLOR_SUCCESS, user)
        .addFields(
            { name: "🔑 Key", value: `\`${code}\``, inline: true },
            { name: "⏳ Time", value: `\`${formatTime(finalDuration)}\``, inline: true },
            { name: "📜 Logic", value: `\`${ruleName}\``, inline: true },
            { name: "📅 Expires", value: finalDuration === "LIFETIME" ? "**Never**" : `<t:${Math.floor(new Date(expiryTime).getTime()/1000)}:R>`, inline: false }
        );

    return replyCallback({ embeds: [embed] });
}

module.exports = { processVerification, handleActiveUsers, handleRules, handleLookup };
