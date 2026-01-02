const { SETTINGS, supabase, createEmbed, formatTime, parseDuration, logToWebhook } = require("./config");
const { EmbedBuilder } = require("discord.js");

// 🔥 1. ROBLOX LINKING
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
        return interaction.reply({ content: "❌ User not found.", ephemeral: true });
    } catch (e) { return interaction.reply({ content: "❌ API Error", ephemeral: true }); }
}

async function handleLinkRoblox(interaction) {
    const rId = interaction.options.getString("roblox_id");
    if (!/^\d+$/.test(rId)) return interaction.reply({ content: "❌ Invalid ID.", ephemeral: true });
    await supabase.from("roblox_links").upsert({ discord_id: interaction.user.id, roblox_id: rId });
    return interaction.reply({ embeds: [createEmbed("✅ Account Linked", `Linked to Roblox ID: \`${rId}\``, SETTINGS.COLOR_SUCCESS)] });
}

// 🔥 2. CUSTOM CODE & BAN SYSTEM
async function handleSetCode(interaction) {
    const user = interaction.options.getUser("user");
    const code = interaction.options.getString("code");
    await supabase.from("verifications").upsert({ discord_id: user.id, code: code, hwid: "RESET", verified: false }, { onConflict: 'discord_id' });
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

// 🔥 3. ACTIVE USERS & LOOKUP (Pro View)
async function handleActiveUsers(interaction, page = 1) {
    const LIMIT = 10;
    const offset = (page - 1) * LIMIT;
    const { data: users, count } = await supabase.from("verifications").select("*", { count: 'exact' }).eq("verified", true).gt("expires_at", new Date().toISOString()).range(offset, offset + LIMIT - 1);

    if (!users || users.length === 0) return interaction.reply({ embeds: [createEmbed("🔴 Active Users", "No active sessions.", SETTINGS.COLOR_ERROR)], ephemeral: true });

    const list = users.map((u, i) => {
        const left = new Date(u.expires_at).getTime() - Date.now();
        const userTag = u.discord_id ? `<@${u.discord_id}>` : (u.note ? `📝 *${u.note}*` : "`Unknown`");
        return `**${offset + i + 1}.** ${userTag}\n   └ 🔑 \`${u.code}\` | ⏳ ${formatTime(left)}`;
    }).join("\n\n");

    return interaction.reply({ embeds: [createEmbed(`🟢 Active Users (${count})`, list, SETTINGS.COLOR_SUCCESS)] });
}

// 🔥 4. VERIFICATION LOGIC (With Poll Check)
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 Maintenance", ephemeral: true });

    // Link Check
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    if (!link) return replyCallback({ embeds: [createEmbed("⚠️ Link Required", "Please link Roblox first!\nUse `/linkroblox`", SETTINGS.COLOR_WARN)] });

    // Poll Punishment Logic
    let isPollPunished = false;
    let pollUrl = "";
    if (SETTINGS.POLL_LOCK) {
        const { data: activePoll } = await supabase.from("polls").select("*").eq("is_active", true).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) {
                isPollPunished = true;
                pollUrl = `https://discord.com/channels/${SETTINGS.GUILD_ID}/${activePoll.channel_id}`; 
            }
        }
    }

    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "Get key from game.", SETTINGS.COLOR_ERROR)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "You are permanently banned.", SETTINGS.COLOR_ERROR)] });

    // Time Calc
    let finalDuration = SETTINGS.DEFAULT_VERIFY_MS;
    let ruleName = "Default (18h)";
    
    if (isPollPunished) {
        finalDuration = 1 * 60 * 60 * 1000; // 1 Hour Penalty
        ruleName = "⚠️ POLL PENALTY (No Vote)";
    } else {
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

    // LOG 2-KEY USERS
    const { data: activeKeys } = await supabase.from("verifications").select("*").eq("discord_id", user.id).eq("verified", true);
    if (activeKeys.length > 1) logToWebhook("⚠️ Multi-Key User", `<@${user.id}> verified multiple keys!`);

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

module.exports = { processVerification, handleGetRobloxId, handleLinkRoblox, handleActiveUsers, handleSetCode, handleBanSystem };
