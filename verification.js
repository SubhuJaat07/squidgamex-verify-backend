const { SETTINGS, supabase, createEmbed, formatTime, parseDuration, logToWebhook } = require("./config");
const { EmbedBuilder } = require("discord.js");

// 🔥 1. MERGED WHITELIST COMMAND (Add/Remove/List)
async function handleWhitelist(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;
    
    // Fetch current list
    const { data } = await supabase.from("guild_config").select("ping_whitelist").eq("guild_id", guildId).single();
    let list = data?.ping_whitelist || [];

    if (sub === "add") {
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        
        let added = "";
        if(user && !list.includes(user.id)) { list.push(user.id); added += `<@${user.id}> `; }
        if(role && !list.includes(role.id)) { list.push(role.id); added += `<@&${role.id}> `; }
        
        if(!added) return interaction.reply({ content: "❌ Already whitelisted or invalid.", ephemeral: true });
        
        await supabase.from("guild_config").upsert({ guild_id: guildId, ping_whitelist: list });
        return interaction.reply({ embeds: [createEmbed("✅ Whitelist Updated", `Added: ${added}`, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "remove") {
        const user = interaction.options.getUser("user");
        const role = interaction.options.getRole("role");
        
        const initialLen = list.length;
        if(user) list = list.filter(id => id !== user.id);
        if(role) list = list.filter(id => id !== role.id);
        
        if(list.length === initialLen) return interaction.reply({ content: "❌ Target not found in whitelist.", ephemeral: true });

        await supabase.from("guild_config").upsert({ guild_id: guildId, ping_whitelist: list });
        return interaction.reply({ embeds: [createEmbed("🗑️ Whitelist Removed", `Removed from whitelist.`, SETTINGS.COLOR_WARN)] });
    }

    if (sub === "list") {
        const formatted = list.map(id => `<@${id}> / <@&${id}>`).join("\n") || "No one whitelisted.";
        return interaction.reply({ embeds: [createEmbed("🛡️ Anti-Ping Whitelist", formatted, SETTINGS.COLOR_INFO)] });
    }
}

// 🔥 2. CUSTOM CODE
async function handleSetCode(interaction) {
    const user = interaction.options.getUser("user");
    const code = interaction.options.getString("code");
    await supabase.from("verifications").upsert({ discord_id: user.id, code: code, verified: false }, { onConflict: 'discord_id' });
    return interaction.reply({ embeds: [createEmbed("✅ Custom Code Set", `User: ${user}\nCode: \`${code}\``, SETTINGS.COLOR_SUCCESS)] });
}

// 🔥 3. ACTIVE USERS
async function handleActiveUsers(interaction) {
    // Basic logic for now (Pagination handled in index if needed, keeping simple here for stability)
    const { data, count } = await supabase.from("verifications").select("*", { count: 'exact' }).eq("verified", true).gt("expires_at", new Date().toISOString()).limit(20);
    if (!data || data.length === 0) return interaction.reply("🔴 No active users.");
    
    const list = data.map((u, i) => `\`${i+1}.\` <@${u.discord_id}> • \`${u.code}\``).join("\n");
    return interaction.reply({ embeds: [createEmbed(`🟢 Active Users (${count})`, list, SETTINGS.COLOR_SUCCESS)] });
}

// 🔥 4. VERIFICATION LOGIC
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 Maintenance", ephemeral: true });

    // Link Check
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    if (!link) return replyCallback({ embeds: [createEmbed("⚠️ Link Required", "First link your Roblox ID.\nUse `/getid` then `/linkroblox`.", SETTINGS.COLOR_WARN)] });

    // Poll Punishment Logic
    let isPollPunished = false;
    if (SETTINGS.POLL_LOCK) {
        const { data: activePoll } = await supabase.from("polls").select("id").eq("is_active", true).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) isPollPunished = true;
        }
    }

    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "Check code in game.", SETTINGS.COLOR_ERROR)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "Permanently banned.", SETTINGS.COLOR_ERROR)] });

    let duration = isPollPunished ? SETTINGS.DEFAULT_PUNISH_MS : SETTINGS.DEFAULT_VERIFY_MS;
    let ruleName = isPollPunished ? "⚠️ Poll Penalty" : "Default";

    // Boost Logic (Simplified for stability)
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

    return replyCallback({ embeds: [createEmbed(isPollPunished?"⚠️ Verified (Restricted)":"✅ Verified", `**Time:** ${formatTime(duration)}\n**Logic:** ${ruleName}`, isPollPunished?SETTINGS.COLOR_WARN:SETTINGS.COLOR_SUCCESS, user)] });
}

module.exports = { processVerification, handleWhitelist, handleSetCode, handleActiveUsers };
