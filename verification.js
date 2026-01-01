const { SETTINGS, supabase, createEmbed, formatTime } = require("./config");

// 🔥 1. ROBLOX ID FETCH (New Command)
async function handleGetRobloxId(interaction) {
    const username = interaction.options.getString("username");
    try {
        // Fetch from Roblox API
        const response = await fetch(SETTINGS.ROBLOX_API_USER, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
        });
        const json = await response.json();
        
        if (json.data && json.data.length > 0) {
            const rUser = json.data[0];
            return interaction.reply({ embeds: [createEmbed("✅ Roblox ID Found", `**Username:** ${rUser.name}\n**ID:** \`${rUser.id}\`\n\n👇 **Copy this command:**\n\`/linkroblox roblox_id:${rUser.id}\``, 0x00FF00)], ephemeral: true });
        } else {
            return interaction.reply({ content: "❌ User not found on Roblox.", ephemeral: true });
        }
    } catch (e) { return interaction.reply({ content: "❌ API Error", ephemeral: true }); }
}

// 🔥 2. LINK ROBLOX ID (New Command)
async function handleLinkRoblox(interaction) {
    const rId = interaction.options.getString("roblox_id");
    // Validate number
    if (!/^\d+$/.test(rId)) return interaction.reply({ content: "❌ Invalid ID. Numbers only.", ephemeral: true });

    await supabase.from("roblox_links").upsert({
        discord_id: interaction.user.id,
        roblox_id: rId
    });

    return interaction.reply({ embeds: [createEmbed("✅ Linked Successfully", `Your Discord is now linked to Roblox ID: \`${rId}\`.\nNow you can use \`/verify\` commands.`, 0x00FF00)], ephemeral: true });
}

// 🔥 3. PROCESS VERIFICATION (Updated Check)
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 **System Under Maintenance**", ephemeral: true });

    // A. Check if Linked
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    if (!link) {
        return replyCallback({ 
            embeds: [createEmbed("⚠️ Action Required", "You must link your Roblox ID first!\n\n1️⃣ Use `/getid <username>` to find your ID.\n2️⃣ Use `/linkroblox <id>` to link it.\n3️⃣ Then use `/verify <code>`.", 0xFFA500)] 
        });
    }

    // B. Poll Check
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
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "Please check your code in the game.", 0xFF0000)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "You are permanently banned.", 0x000000)] });

    // D. Calculate Time
    let calculation = { duration: SETTINGS.DEFAULT_VERIFY_MS, ruleText: "Default Access", isPunished: false };
    
    if (isPollPunished) {
        calculation = { duration: 1 * 60 * 60 * 1000, ruleText: "⚠️ **Penalty:** Vote on Poll!", isPunished: true }; // 1 Hour Fixed
    } else {
        try {
            const member = await guild.members.fetch(user.id);
            const { data: rules } = await supabase.from("role_rules").select("*");
            if(rules && rules.length > 0) calculation.ruleText = "Role Boost Active"; 
        } catch (e) {}
    }

    const { duration, ruleText, isPunished } = calculation;
    const expiryTime = duration === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + duration).toISOString();
    
    await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: user.id }).eq("id", userData.id);

    const embed = createEmbed(isPunished ? "⚠️ Verified (with Penalty)" : "✅ Verification Successful", `**User:** <@${user.id}>\n**Roblox ID:** \`${link.roblox_id}\``, isPunished ? 0xFFA500 : 0x00FF00);
    embed.addFields({ name: "🔑 Code", value: `\`${code}\``, inline: true }, { name: "⏳ Validity", value: `\`${formatTime(duration)}\``, inline: true }, { name: "📜 Logic", value: ruleText, inline: false }).setThumbnail(user.displayAvatarURL());
    return replyCallback({ embeds: [embed] });
}

module.exports = { processVerification, handleGetRobloxId, handleLinkRoblox };
