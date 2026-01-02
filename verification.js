const { SETTINGS, supabase, createEmbed, formatTime, parseDuration, logToWebhook } = require("./config");
const { EmbedBuilder } = require("discord.js");

// 🔥 1. WHITELIST SYSTEM
async function handleWhitelist(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;
    const { data } = await supabase.from("guild_config").select("ping_whitelist").eq("guild_id", guildId).maybeSingle();
    let list = data?.ping_whitelist || [];

    if (sub === "add") {
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        let added = [];
        if (user && !list.includes(user.id)) { list.push(user.id); added.push(`<@${user.id}>`); }
        if (role && !list.includes(role.id)) { list.push(role.id); added.push(`<@&${role.id}>`); }
        if (added.length === 0) return interaction.reply({ embeds: [createEmbed("⚠️ Exists", "Already in whitelist.", SETTINGS.COLOR_WARN)], ephemeral: true });
        await supabase.from("guild_config").upsert({ guild_id: guildId, ping_whitelist: list }, { onConflict: 'guild_id' });
        return interaction.reply({ embeds: [createEmbed("✅ Whitelisted", `**Added:** ${added.join(", ")}`, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "remove") {
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        const initialLen = list.length;
        if (user) list = list.filter(id => id !== user.id);
        if (role) list = list.filter(id => id !== role.id);
        if (list.length === initialLen) return interaction.reply({ embeds: [createEmbed("❌ Not Found", "Target not in whitelist.", SETTINGS.COLOR_ERROR)], ephemeral: true });
        await supabase.from("guild_config").upsert({ guild_id: guildId, ping_whitelist: list }, { onConflict: 'guild_id' });
        return interaction.reply({ embeds: [createEmbed("🗑️ Removed", "Removed from whitelist.", SETTINGS.COLOR_WARN)] });
    }

    if (sub === "list") {
        const desc = list.length > 0 ? list.map(id => `🛡️ <@${id}> / <@&${id}>`).join("\n") : "No one whitelisted.";
        return interaction.reply({ embeds: [createEmbed("🛡️ Anti-Ping Whitelist", desc, SETTINGS.COLOR_INFO)] });
    }
}

// 🔥 2. CUSTOM CODE
async function handleSetCode(interaction) {
    const user = interaction.options.getUser("user");
    const code = interaction.options.getString("code");
    await supabase.from("verifications").upsert({ discord_id: user.id, code: code, verified: false }, { onConflict: 'discord_id' });
    return interaction.reply({ embeds: [createEmbed("✅ Custom Code", `User: ${user}\nCode: \`${code}\``, SETTINGS.COLOR_SUCCESS)] });
}

// 🔥 3. SET EXPIRY (Restored)
async function handleSetExpiry(interaction) {
    const ms = parseDuration(interaction.options.getString("duration"));
    const target = interaction.options.getString("target");
    const note = interaction.options.getString("note") || null;
    const expiry = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString();
    
    await supabase.from("verifications").update({ verified: true, expires_at: expiry, note: note }).or(`code.eq.${target},hwid.eq.${target}`);
    return interaction.reply({ embeds: [createEmbed("✅ Expiry Updated", `**Target:** \`${target}\`\n**Duration:** \`${interaction.options.getString("duration")}\`\n**Note:** ${note || "None"}`, SETTINGS.COLOR_SUCCESS)] });
}

// 🔥 4. CHECK ALTS (Restored)
async function handleCheckAlts(interaction) {
    const { data: all } = await supabase.from("verifications").select("*").eq("verified", true).gt("expires_at", new Date().toISOString());
    if (!all) return interaction.reply("✅ No Active Data");
    const map = {};
    all.forEach(u => { if(u.discord_id) map[u.discord_id] = (map[u.discord_id] || 0) + 1; });
    const alts = Object.entries(map).filter(([k,v]) => v > 1).map(([k,v]) => `<@${k}>: **${v} Keys**`).join("\n");
    return interaction.reply({ embeds: [createEmbed("🕵️ Alt Accounts", alts || "No alts detected.", alts ? SETTINGS.COLOR_WARN : SETTINGS.COLOR_SUCCESS)] });
}

// 🔥 5. ACTIVE USERS
async function handleActiveUsers(interaction) {
    const { data, count } = await supabase.from("verifications").select("*", { count: 'exact' }).eq("verified", true).gt("expires_at", new Date().toISOString()).limit(20);
    if (!data || data.length === 0) return interaction.reply({ embeds: [createEmbed("🔴 Active Users", "No active keys.", SETTINGS.COLOR_ERROR)] });
    
    const list = data.map((u, i) => {
        const user = u.discord_id ? `<@${u.discord_id}>` : (u.note ? `📝 ${u.note}` : "`Unknown`");
        const timeLeft = formatTime(new Date(u.expires_at).getTime() - Date.now());
        return `\`${i+1}.\` ${user} • \`${u.code}\` • ⏳ ${timeLeft}`;
    }).join("\n");
    return interaction.reply({ embeds: [createEmbed(`🟢 Active Sessions (${count})`, list, SETTINGS.COLOR_SUCCESS)] });
}

// 🔥 6. LOOKUP (Improved)
async function handleLookup(interaction) {
    const target = interaction.options.getString("target");
    const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.reply({ embeds: [createEmbed("❌ Not Found", `No record for \`${target}\``, SETTINGS.COLOR_ERROR)], ephemeral: true });

    let pfp = null;
    if (data.discord_id) { try { const u = await interaction.client.users.fetch(data.discord_id); pfp = u; } catch(e){} }

    const expiry = data.expires_at ? new Date(data.expires_at) : null;
    const isActive = expiry && expiry > new Date();
    const status = data.is_banned ? "🚫 BANNED" : (isActive ? "🟢 ACTIVE" : "🔴 EXPIRED");

    const embed = createEmbed("🔍 Lookup Details", "", data.is_banned ? SETTINGS.COLOR_ERROR : SETTINGS.COLOR_INFO, pfp)
        .addFields(
            { name: "👤 User", value: data.discord_id ? `<@${data.discord_id}>` : "`Unlinked`", inline: true },
            { name: "📝 Note", value: data.note ? `\`${data.note}\`` : "`None`", inline: true },
            { name: "🔑 Code", value: `\`${data.code}\``, inline: true },
            { name: "📡 Status", value: `**${status}**`, inline: true },
            { name: "🖥️ HWID", value: `\`${data.hwid}\``, inline: false },
            { name: "⏳ Expires", value: expiry ? `<t:${Math.floor(expiry.getTime()/1000)}:R>` : "`N/A`", inline: true }
        );
    return interaction.reply({ embeds: [embed] });
}

// 🔥 7. RULES SYSTEM
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
        return interaction.reply({ embeds: [createEmbed("🗑️ Removed", `Rule deleted for ${role}`, SETTINGS.COLOR_WARN)] });
    }
    if (sub === "list") {
        const { data } = await supabase.from("role_rules").select("*");
        const desc = data.map(r => `• <@&${r.role_id}> ➜ **${r.duration}**`).join("\n") || "None";
        return interaction.reply({ embeds: [createEmbed("📜 Rules", desc, SETTINGS.COLOR_INFO)] });
    }
}

// 🔥 8. VERIFICATION CORE
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 Maintenance", ephemeral: true });

    // Link Check
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    if (!link) return replyCallback({ embeds: [createEmbed("⚠️ Link Required", "Use `/getid` then `/linkroblox` to link your account first.", SETTINGS.COLOR_WARN)] });

    // Poll Punishment
    let isPollPunished = false;
    let pollLink = "";
    if (SETTINGS.POLL_LOCK) {
        const { data: activePoll } = await supabase.from("polls").select("id, channel_id").eq("is_active", true).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) {
                isPollPunished = true;
                pollLink = `https://discord.com/channels/${SETTINGS.GUILD_ID}/${activePoll.channel_id}`;
            }
        }
    }

    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "Get key from game.", SETTINGS.COLOR_ERROR)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "You are permanently banned.", SETTINGS.COLOR_ERROR)] });

    let duration = isPollPunished ? SETTINGS.DEFAULT_PUNISH_MS : SETTINGS.DEFAULT_VERIFY_MS;
    let ruleName = isPollPunished ? "⚠️ Poll Penalty" : "Default";

    if (!isPollPunished) {
        try {
            const member = await guild.members.fetch(user.id);
            const { data: rules } = await supabase.from("role_rules").select("*");
            rules?.forEach(r => {
                if (member.roles.cache.has(r.role_id)) {
                    const d = parseDuration(r.duration);
                    if (d > duration || d === "LIFETIME") { duration = d; ruleName = `⭐ ${r.role_name}`; }
                }
            });
        } catch(e){}
    }

    const expiry = duration === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + duration).toISOString();
    await supabase.from("verifications").update({ verified: true, expires_at: expiry, discord_id: user.id }).eq("id", userData.id);

    return replyCallback({ embeds: [createEmbed(isPollPunished?"⚠️ Verified (Restricted)":"✅ Verified", isPollPunished?`**Vote Penalty Applied!**\n[Vote Here](${pollLink})`:`**Access Granted**`, isPollPunished?SETTINGS.COLOR_WARN:SETTINGS.COLOR_SUCCESS, user).addFields({name:"⏳ Time",value:`\`${formatTime(duration)}\``,inline:true}, {name:"📜 Logic",value:ruleName,inline:true})] });
}

// Helpers
async function handleGetRobloxId(interaction) {
    const name = interaction.options.getString("username");
    try {
        const res = await fetch(SETTINGS.ROBLOX_API, { method: 'POST', headers: {'Content-Type': 'json'}, body: JSON.stringify({ usernames: [name], excludeBannedUsers: true }) });
        const json = await res.json();
        if(json.data?.length) return interaction.reply({ embeds: [createEmbed("✅ ID Found", `ID: \`${json.data[0].id}\``, SETTINGS.COLOR_SUCCESS)] });
        return interaction.reply({ content: "❌ Not found", ephemeral: true });
    } catch(e) { return interaction.reply({ content: "❌ Error", ephemeral: true }); }
}

async function handleLinkRoblox(interaction) {
    const id = interaction.options.getString("roblox_id");
    await supabase.from("roblox_links").upsert({ discord_id: interaction.user.id, roblox_id: id });
    return interaction.reply({ embeds: [createEmbed("✅ Linked", `ID: \`${id}\``, SETTINGS.COLOR_SUCCESS)] });
}

async function handleBanSystem(interaction) {
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getString("target");
    if(sub==="ban") { await supabase.from("verifications").update({is_banned:true, verified:false}).or(`code.eq.${target},hwid.eq.${target}`); return interaction.reply({embeds:[createEmbed("🚫 Banned", target, SETTINGS.COLOR_ERROR)]}); }
    if(sub==="unban") { await supabase.from("verifications").update({is_banned:false}).or(`code.eq.${target},hwid.eq.${target}`); return interaction.reply({embeds:[createEmbed("✅ Unbanned", target, SETTINGS.COLOR_SUCCESS)]}); }
    if(sub==="list") { const {data}=await supabase.from("verifications").select("*").eq("is_banned",true); return interaction.reply({embeds:[createEmbed("📜 Ban List", data.map(u=>u.code).join("\n")||"None", SETTINGS.COLOR_WARN)]}); }
}

module.exports = { processVerification, handleWhitelist, handleRules, handleActiveUsers, handleGetRobloxId, handleLinkRoblox, handleSetCode, handleSetExpiry, handleCheckAlts, handleLookup, handleBanSystem };
