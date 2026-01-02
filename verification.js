const { SETTINGS, supabase, createEmbed, formatTime, parseDuration, logToWebhook } = require("./config");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// 🔥 1. ROBLOX UTILS
async function handleGetRobloxId(interaction) {
    const username = interaction.options.getString("username");
    try {
        const response = await fetch(SETTINGS.ROBLOX_API, {
            method: 'POST', headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
        });
        const json = await response.json();
        if (json.data?.length > 0) {
            const rUser = json.data[0];
            return interaction.reply({ embeds: [createEmbed("✅ Roblox ID Found", `**User:** ${rUser.name}\n**ID:** \`${rUser.id}\`\n\n👇 **Link Command:**\n\`/linkroblox roblox_id:${rUser.id}\``, SETTINGS.COLOR_SUCCESS)] });
        }
        return interaction.reply({ content: "❌ Not Found", ephemeral: true });
    } catch (e) { return interaction.reply({ content: "❌ API Error", ephemeral: true }); }
}

async function handleLinkRoblox(interaction) {
    const rId = interaction.options.getString("roblox_id");
    if (!/^\d+$/.test(rId)) return interaction.reply({ content: "❌ Invalid ID.", ephemeral: true });
    await supabase.from("roblox_links").upsert({ discord_id: interaction.user.id, roblox_id: rId });
    // FIXED SYNTAX HERE
    return interaction.reply({ embeds: [createEmbed("✅ Account Linked", `**Success!** Linked to Roblox ID: \`${rId}\`.\nNow you can use \`/verify\` or \`verify <code>\`.`, SETTINGS.COLOR_SUCCESS)] });
}

// 🔥 2. CUSTOM CODE & BAN
async function handleSetCode(interaction) {
    const user = interaction.options.getUser("user");
    const code = interaction.options.getString("code");
    await supabase.from("verifications").upsert({ discord_id: user.id, code: code, verified: false, hwid: "RESET_ADMIN" }, { onConflict: 'discord_id' });
    return interaction.reply({ embeds: [createEmbed("✅ Code Updated", `User: ${user}\nNew Code: \`${code}\``, SETTINGS.COLOR_SUCCESS)] });
}

async function handleBanSystem(interaction) {
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getString("target");

    if (sub === "ban") {
        await supabase.from("verifications").update({ is_banned: true, verified: false }).or(`code.eq.${target},hwid.eq.${target}`);
        return interaction.reply({ embeds: [createEmbed("🚫 User Banned", `Target: \`${target}\` banned.`, SETTINGS.COLOR_ERROR)] });
    }
    if (sub === "unban") {
        await supabase.from("verifications").update({ is_banned: false }).or(`code.eq.${target},hwid.eq.${target}`);
        return interaction.reply({ embeds: [createEmbed("✅ User Unbanned", `Target: \`${target}\` unbanned.`, SETTINGS.COLOR_SUCCESS)] });
    }
    if (sub === "list") {
        const { data } = await supabase.from("verifications").select("*").eq("is_banned", true);
        const list = data.map(u => `\`${u.code}\` | HWID: ...${u.hwid.slice(-5)}`).join("\n") || "No bans.";
        return interaction.reply({ embeds: [createEmbed("📜 Ban List", list, SETTINGS.COLOR_WARN)] });
    }
}

// 🔥 3. ACTIVE USERS (PAGINATION)
async function handleActiveUsers(interaction, page = 1) {
    const LIMIT = 10;
    const offset = (page - 1) * LIMIT;
    
    const replyMethod = interaction.message ? interaction.update.bind(interaction) : interaction.reply.bind(interaction);

    const { data: users, count } = await supabase.from("verifications").select("*", { count: 'exact' }).eq("verified", true).gt("expires_at", new Date().toISOString()).range(offset, offset + LIMIT - 1);

    if (!users || users.length === 0) return replyMethod({ embeds: [createEmbed("🔴 Active Users", "No active sessions.", SETTINGS.COLOR_ERROR)], components: [] });

    // Check Alts
    const { data: allActive } = await supabase.from("verifications").select("discord_id").eq("verified", true);
    const altMap = {};
    allActive.forEach(u => { if(u.discord_id) altMap[u.discord_id] = (altMap[u.discord_id] || 0) + 1; });

    const list = users.map((u, i) => {
        const left = new Date(u.expires_at).getTime() - Date.now();
        const userTag = u.discord_id ? `<@${u.discord_id}>` : (u.note ? `📝 *${u.note}*` : "`Unknown`");
        const badge = (u.discord_id && altMap[u.discord_id] > 1) ? "⚠️ **ALT**" : "";
        return `**${offset + i + 1}.** ${userTag} ${badge}\n   └ 🔑 \`${u.code}\` | ⏳ ${formatTime(left)}`;
    }).join("\n\n");

    const totalPages = Math.ceil(count / LIMIT);
    const embed = createEmbed(`🟢 Active Users (Page ${page}/${totalPages})`, list, SETTINGS.COLOR_SUCCESS).setFooter({ text: `Total Online: ${count}` });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`active_prev_${page-1}`).setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
        new ButtonBuilder().setCustomId(`active_next_${page+1}`).setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
    );

    await replyMethod({ embeds: [embed], components: [row] });
}

async function handleCheckAlts(interaction) {
    await interaction.deferReply();
    const { data: all } = await supabase.from("verifications").select("*").eq("verified", true).gt("expires_at", new Date().toISOString());
    if (!all) return interaction.editReply("No Data.");
    const map = new Map();
    all.forEach(u => { if(u.discord_id) { if(!map.has(u.discord_id)) map.set(u.discord_id, []); map.get(u.discord_id).push(u); }});
    const alts = Array.from(map.entries()).filter(([_, arr]) => arr.length > 1);
    if (alts.length === 0) return interaction.editReply({ embeds: [createEmbed("✅ Clean", "No users with multiple keys.", SETTINGS.COLOR_SUCCESS)] });
    const desc = alts.map(([id, keys]) => `<@${id}> has **${keys.length}** keys:\n` + keys.map(k => `└ \`${k.code}\``).join("\n")).join("\n\n");
    return interaction.editReply({ embeds: [createEmbed(`⚠️ ${alts.length} Alt Users`, desc, SETTINGS.COLOR_WARN)] });
}

// 🔥 4. ADMIN: SET EXPIRY
async function handleSetExpiry(interaction) {
    if (interaction.user.id !== SETTINGS.SUPER_OWNER_ID && !await require("./config").isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Admin Only", ephemeral: true });
    await interaction.deferReply();
    const ms = parseDuration(interaction.options.getString("duration"));
    const target = interaction.options.getString("target");
    const note = interaction.options.getString("note") || null;
    const expiry = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString();
    await supabase.from("verifications").update({ verified: true, expires_at: expiry, note: note }).or(`code.eq.${target},hwid.eq.${target}`);
    return interaction.editReply({ embeds: [createEmbed("✅ Expiry Updated", `Target: \`${target}\`\nNote: ${note || "None"}`, SETTINGS.COLOR_SUCCESS)] });
}

async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.editReply("❌ Not Found");
    let userObj = null;
    if (data.discord_id) try { userObj = await interaction.client.users.fetch(data.discord_id); } catch(e){}
    const status = data.is_banned ? "🚫 **BANNED**" : (new Date(data.expires_at) < new Date() ? "🔴 **EXPIRED**" : "🟢 **ACTIVE**");
    const embed = createEmbed("🔍 Lookup", "", data.is_banned ? SETTINGS.COLOR_ERROR : SETTINGS.COLOR_INFO, userObj)
        .addFields({ name: "User", value: data.discord_id ? `<@${data.discord_id}>` : "Unlinked", inline: true }, { name: "Code", value: `\`${data.code}\``, inline: true }, { name: "Note", value: data.note || "None", inline: true }, { name: "Status", value: status, inline: true }, { name: "HWID", value: `\`${data.hwid}\``, inline: false }, { name: "Expiry", value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:R>` : "N/A", inline: true });
    return interaction.editReply({ embeds: [embed] });
}

// 🔥 5. RULE SYSTEM
async function handleRules(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "set") {
        const role = interaction.options.getRole("role");
        const dur = interaction.options.getString("duration");
        await supabase.from("role_rules").upsert({ role_id: role.id, role_name: role.name, duration: dur }, { onConflict: 'role_id' });
        return interaction.reply({ embeds: [createEmbed("✅ Rule Set", `**Role:** ${role}\n**Time:** \`${dur}\``, SETTINGS.COLOR_SUCCESS)] });
    }
    if (sub === "remove") {
        const role = interaction.options.getRole("role");
        await supabase.from("role_rules").delete().eq("role_id", role.id);
        return interaction.reply({ embeds: [createEmbed("🗑️ Removed", `Rule for **${role.name}** deleted.`, SETTINGS.COLOR_WARN)] });
    }
    if (sub === "list") {
        const { data } = await supabase.from("role_rules").select("*");
        const list = data.map(r => `• <@&${r.role_id}> ➜ **${r.duration}**`).join("\n") || "No rules.";
        return interaction.reply({ embeds: [createEmbed("📜 Rules", list, SETTINGS.COLOR_INFO)] });
    }
}

// 🔥 6. VERIFICATION PROCESS
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 Maintenance", ephemeral: true });

    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    if (!link) return replyCallback({ embeds: [createEmbed("⚠️ Link Required", `Link Roblox first!\nUse \`/getid\` then \`/linkroblox\``, SETTINGS.COLOR_WARN)] });

    let isPollPunished = false, pollUrl = "";
    if (SETTINGS.POLL_LOCK) {
        const { data: activePoll } = await supabase.from("polls").select("*").eq("is_active", true).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) { isPollPunished = true; pollUrl = `https://discord.com/channels/${SETTINGS.GUILD_ID}/${activePoll.channel_id}`; }
        }
    }

    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "Get key from game.", SETTINGS.COLOR_ERROR)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "You are banned.", SETTINGS.COLOR_ERROR)] });

    let finalDuration = SETTINGS.DEFAULT_VERIFY_MS, ruleName = "Default";
    if (isPollPunished) { finalDuration = SETTINGS.DEFAULT_PUNISH_MS; ruleName = "⚠️ POLL PENALTY"; } 
    else {
        try {
            const member = await guild.members.fetch(user.id);
            const { data: rules } = await supabase.from("role_rules").select("*");
            if (rules) {
                let max = SETTINGS.DEFAULT_VERIFY_MS;
                rules.forEach(r => { if (member.roles.cache.has(r.role_id)) { const d = parseDuration(r.duration); if (d === "LIFETIME") { max = "LIFETIME"; ruleName = "👑 Lifetime"; } else if (max !== "LIFETIME" && d > max) { max = d; ruleName = `⭐ ${r.role_name}`; } } });
                finalDuration = max;
            }
        } catch (e) {}
    }

    const expiryTime = finalDuration === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + finalDuration).toISOString();
    await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: user.id }).eq("id", userData.id);

    const { data: keys } = await supabase.from("verifications").select("*").eq("discord_id", user.id).eq("verified", true);
    if(keys && keys.length > 1) logToWebhook("⚠️ Multi-Key", `<@${user.id}> verified key \`${code}\` but has active keys!`);

    return replyCallback({ embeds: [createEmbed(isPollPunished?"⚠️ Restricted":"✅ Verified", isPollPunished?`**Missed Poll!**\n[Vote Here](${pollUrl})`:"**Access Granted!**", isPollPunished?SETTINGS.COLOR_WARN:SETTINGS.COLOR_SUCCESS, user).addFields({ name: "Key", value: `\`${code}\``, inline: true }, { name: "Time", value: `\`${formatTime(finalDuration)}\``, inline: true }, { name: "Logic", value: ruleName, inline: true }, { name: "Expires", value: finalDuration==="LIFETIME"?"**Never**":`<t:${Math.floor(new Date(expiryTime).getTime()/1000)}:R>`, inline: false })] });
}

module.exports = { processVerification, handleGetRobloxId, handleLinkRoblox, handleActiveUsers, handleSetCode, handleBanSystem, handleRules, handleLookup, handleSetExpiry, handleCheckAlts };
