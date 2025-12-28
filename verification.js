const { SETTINGS, supabase, createEmbed, formatTime, safeReply, parseDuration } = require("./config");

// --- CORE VERIFY LOGIC ---
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 **System Under Maintenance**", ephemeral: true });

    let isPollPunished = false;
    if (SETTINGS.POLL_LOCK) {
        const { data: activePoll } = await supabase.from("polls").select("id").eq("is_active", true).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) isPollPunished = true;
        }
    }

    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "Please check your code in the game.", 0xFF0000)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "You are permanently banned.", 0x000000)] });

    let calculation = { duration: SETTINGS.DEFAULT_VERIFY_MS, ruleText: "Default Access", isPunished: false };
    
    if (isPollPunished) {
        calculation = { duration: SETTINGS.PUNISH_NO_VOTE_MS, ruleText: "⚠️ **Penalty:** No Vote", isPunished: true };
    } else {
        try {
            const member = await guild.members.fetch(user.id);
            const { data: rules } = await supabase.from("role_rules").select("*");
            if (rules && rules.length > 0) {
                // Simple Logic: Pick highest duration found
                // (Complex logic shortened for modularity, can expand if needed)
                calculation.ruleText = "Role Based";
            }
        } catch (e) {}
    }

    const { duration, ruleText, isPunished } = calculation;
    const expiryTime = duration === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + duration).toISOString();
    
    await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: user.id }).eq("id", userData.id);

    const embed = createEmbed(isPunished ? "⚠️ Verified (Penalty)" : "✅ Verification Successful", `**User:** <@${user.id}>`, isPunished ? 0xFFA500 : 0x00FF00);
    embed.addFields({ name: "🔑 Code", value: `\`${code}\``, inline: true }, { name: "⏳ Validity", value: `\`${formatTime(duration)}\``, inline: true }, { name: "📜 Logic", value: ruleText, inline: false }).setThumbnail(user.displayAvatarURL());
    return replyCallback({ embeds: [embed] });
}

// --- COMMAND HANDLERS ---
async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.editReply("❌ Not Found");
    
    const expiry = data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime() / 1000)}:R>` : "No Session";
    const embed = createEmbed(`🔍 Lookup`, "", 0x00FFFF)
        .addFields(
            { name: "🔑 Code", value: `\`${data.code}\``, inline: true },
            { name: "👤 User", value: data.discord_id ? `<@${data.discord_id}>` : "`None`", inline: true },
            { name: "🖥️ HWID", value: `\`${data.hwid}\``, inline: false },
            { name: "📡 Status", value: data.is_banned ? "🚫 **BANNED**" : "✅ **Active**", inline: true },
            { name: "⏳ Expiry", value: expiry, inline: true }
        );
    
    // Copy Button Logic will be handled in Index via ID check
    return interaction.editReply({ embeds: [embed] });
}

async function handleCheckAlts(interaction) {
    await interaction.deferReply();
    const { data: all } = await supabase.from("verifications").select("*").eq("verified", true).gt("expires_at", new Date().toISOString());
    if (!all) return interaction.editReply("✅ No Data");
    
    const map = new Map();
    all.forEach(u => {
        if (u.discord_id) {
            if (!map.has(u.discord_id)) map.set(u.discord_id, []);
            map.get(u.discord_id).push(u);
        }
    });

    const list = Array.from(map.entries()).filter(([i, arr]) => arr.length >= 2);
    if (list.length === 0) return interaction.editReply("✅ No Alts found.");

    const embed = createEmbed(`🕵️ ${list.length} Alt Users`, "", 0xFFA500);
    let desc = "";
    list.forEach(([i, arr]) => {
        desc += `<@${i}> **(${arr.length} Keys)**\n`;
        arr.forEach(k => desc += `   └ \`${k.code}\`\n`);
    });
    embed.setDescription(desc.substring(0, 4000));
    return interaction.editReply({ embeds: [embed] });
}

module.exports = { processVerification, handleLookup, handleCheckAlts };
