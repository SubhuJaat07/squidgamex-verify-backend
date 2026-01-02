const { SETTINGS, supabase, createEmbed, formatTime, parseDuration } = require("./config");
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
        if (json.data && json.data.length > 0) {
            const rUser = json.data[0];
            return interaction.reply({ embeds: [createEmbed("✅ Roblox ID Found", `**Username:** ${rUser.name}\n**ID:** \`${rUser.id}\`\n\n👇 **Command:**\n\`/linkroblox roblox_id:${rUser.id}\``, 0x00FF00)] });
        } else {
            return interaction.reply({ content: "❌ User not found.", ephemeral: true });
        }
    } catch (e) { return interaction.reply({ content: "❌ API Error", ephemeral: true }); }
}

async function handleLinkRoblox(interaction) {
    const rId = interaction.options.getString("roblox_id");
    if (!/^\d+$/.test(rId)) return interaction.reply({ content: "❌ Invalid ID (Numbers only).", ephemeral: true });
    await supabase.from("roblox_links").upsert({ discord_id: interaction.user.id, roblox_id: rId });
    return interaction.reply({ embeds: [createEmbed("✅ Linked", `Roblox ID: \`${rId}\` linked!`, 0x00FF00)] });
}

// 🔥 2. MAIN VERIFICATION LOGIC (PROFESSIONAL REPLY)
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 **System Under Maintenance**", ephemeral: true });

    // A. Check Link
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    if (!link) return replyCallback({ embeds: [createEmbed("⚠️ Link Required", "Use `/getid` and `/linkroblox` first.", 0xFFA500)] });

    // B. Check Poll
    let isPollPunished = false;
    if (SETTINGS.POLL_LOCK) {
        const { data: activePoll } = await supabase.from("polls").select("id").eq("is_active", true).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) isPollPunished = true;
        }
    }

    // C. Validate Code
    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "Check code in game.", 0xFF0000)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "You are permanently banned.", 0x000000)] });

    // D. Calculate Duration
    let finalDuration = SETTINGS.DEFAULT_VERIFY_MS;
    let ruleName = "Default (18h)";
    
    if (isPollPunished) {
        finalDuration = SETTINGS.PUNISH_NO_VOTE_MS;
        ruleName = "⚠️ Penalty (No Vote)";
    } else {
        try {
            const member = await guild.members.fetch(user.id);
            const { data: rules } = await supabase.from("role_rules").select("*");
            // Check Punish/Boost Logic
            if (rules) {
                const punishRule = rules.find(r => r.role_name.toLowerCase().includes("punish") && member.roles.cache.has(r.role_id));
                if (punishRule) {
                    finalDuration = parseDuration(punishRule.duration);
                    ruleName = `🚫 ${punishRule.role_name}`;
                } else {
                    let maxBase = SETTINGS.DEFAULT_VERIFY_MS;
                    rules.forEach(r => {
                        if (member.roles.cache.has(r.role_id)) {
                            const d = parseDuration(r.duration);
                            if (d === "LIFETIME") { maxBase = "LIFETIME"; ruleName = "👑 Lifetime"; }
                            else if (maxBase !== "LIFETIME" && d > maxBase) { maxBase = d; ruleName = `⭐ ${r.role_name}`; }
                        }
                    });
                    finalDuration = maxBase;
                }
            }
        } catch (e) {}
    }

    const expiryTime = finalDuration === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + finalDuration).toISOString();
    await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: user.id }).eq("id", userData.id);

    // E. PROFESSIONAL EMBED
    const embed = new EmbedBuilder()
        .setTitle(isPollPunished ? "⚠️ Verification Restricted" : "✅ Verification Successful")
        .setColor(isPollPunished ? 0xFFA500 : 0x00FF00)
        .setThumbnail(user.displayAvatarURL())
        .addFields(
            { name: "👤 User", value: `<@${user.id}>`, inline: true },
            { name: "🎮 Roblox ID", value: `\`${link.roblox_id}\``, inline: true },
            { name: "🔑 Code", value: `\`${code}\``, inline: true },
            { name: "⏳ Validity", value: `\`${formatTime(finalDuration)}\``, inline: true },
            { name: "📜 Applied Rule", value: `**${ruleName}**`, inline: true },
            { name: "📅 Expires", value: finalDuration === "LIFETIME" ? "**Never**" : `<t:${Math.floor(new Date(expiryTime).getTime() / 1000)}:R>`, inline: false }
        )
        .setFooter({ text: "Squid Game X", iconURL: "https://i.imgur.com/AfFp7pu.png" })
        .setTimestamp();

    return replyCallback({ embeds: [embed] });
}

// 🔥 3. ADMIN & UTILS (Ban, Rules, Lookup)
async function handleBanSystem(interaction) {
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getString("target");
    if (sub === "ban") {
        await supabase.from("verifications").update({ is_banned: true, verified: false }).or(`code.eq.${target},hwid.eq.${target}`);
        return interaction.reply({ embeds: [createEmbed("🚫 Banned", `Target: \`${target}\``, 0xFF0000)] });
    }
    if (sub === "unban") {
        await supabase.from("verifications").update({ is_banned: false }).or(`code.eq.${target},hwid.eq.${target}`);
        return interaction.reply({ embeds: [createEmbed("✅ Unbanned", `Target: \`${target}\``, 0x00FF00)] });
    }
    if (sub === "list") {
        const { data } = await supabase.from("verifications").select("*").eq("is_banned", true);
        return interaction.reply({ embeds: [createEmbed("📜 Ban List", data.map(u => u.code).join("\n") || "None", 0x000000)] });
    }
}

async function handleRules(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === "set") {
        const role = interaction.options.getRole("role");
        const dur = interaction.options.getString("duration");
        await supabase.from("role_rules").upsert({ role_id: role.id, role_name: role.name, duration: dur });
        return interaction.reply(`✅ Rule Set: **${role.name}** = \`${dur}\``);
    }
    if (sub === "list") {
        const { data } = await supabase.from("role_rules").select("*");
        return interaction.reply({ embeds: [createEmbed("📜 Rules", data.map(r => `<@&${r.role_id}>: \`${r.duration}\``).join("\n") || "None")] });
    }
}

async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.editReply("❌ Not Found");
    return interaction.editReply({ embeds: [createEmbed("🔍 Lookup", `**Code:** ${data.code}\n**HWID:** ${data.hwid}\n**User:** ${data.discord_id ? `<@${data.discord_id}>` : "None"}`)] });
}

async function handleCheckAlts(interaction) {
    await interaction.deferReply();
    const { data: all } = await supabase.from("verifications").select("*").eq("verified", true).gt("expires_at", new Date().toISOString());
    if(!all) return interaction.editReply("No Data");
    const map = new Map();
    all.forEach(u => { if(u.discord_id) { if(!map.has(u.discord_id)) map.set(u.discord_id, []); map.get(u.discord_id).push(u); }});
    const list = Array.from(map.entries()).filter(([i, arr]) => arr.length >= 2);
    if(list.length===0) return interaction.editReply("✅ No Alts found.");
    const embed = createEmbed(`🕵️ ${list.length} Alt Users`, list.map(([i, arr]) => `<@${i}>: ${arr.length} Keys`).join("\n"), 0xFFA500);
    return interaction.editReply({embeds: [embed]});
}

async function handleSetExpiry(interaction) {
    await interaction.deferReply();
    const ms = parseDuration(interaction.options.getString("duration"));
    const target = interaction.options.getString("target");
    const expiry = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString();
    await supabase.from("verifications").update({ verified: true, expires_at: expiry }).or(`code.eq.${target},hwid.eq.${target}`);
    return interaction.editReply(`✅ Updated ${target}`);
}

module.exports = { processVerification, handleGetRobloxId, handleLinkRoblox, handleBanSystem, handleRules, handleLookup, handleCheckAlts, handleSetExpiry };
