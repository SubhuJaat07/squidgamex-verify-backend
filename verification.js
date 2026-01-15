const { 
    SETTINGS, 
    supabase, 
    createEmbed, 
    formatTime, 
    parseDuration, 
    logToWebhook 
} = require("./config");

const { 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} = require("discord.js");

// =====================================================================
// 🌐 SECTION 1: ROBLOX LINKING SYSTEM
// =====================================================================

/**
 * Handles fetching a Roblox ID from a username.
 * Usage: /getid <username>
 */
async function handleGetRobloxId(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const username = interaction.options.getString("username");

    try {
        // Fetch data from Roblox API
        const response = await fetch(SETTINGS.ROBLOX_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                usernames: [username], 
                excludeBannedUsers: true 
            })
        });

        const json = await response.json();

        // Check if user exists
        if (json.data && json.data.length > 0) {
            const rUser = json.data[0];
            
            const embed = createEmbed("✅ Roblox User Found", null, SETTINGS.COLOR_SUCCESS)
                .addFields(
                    { name: "👤 Username", value: `\`${rUser.name}\``, inline: true },
                    { name: "🆔 Roblox ID", value: `\`${rUser.id}\``, inline: true },
                    { name: "🔗 How to Link", value: `Copy the command below and run it:\n\`\`\`/linkroblox roblox_id:${rUser.id}\`\`\``, inline: false }
                );

            return interaction.editReply({ embeds: [embed] });
        } else {
            return interaction.editReply({ 
                embeds: [createEmbed("❌ User Not Found", `Could not find a Roblox user with the name **${username}**.`, SETTINGS.COLOR_ERROR)] 
            });
        }
    } catch (error) {
        console.error("Roblox API Error:", error);
        return interaction.editReply({ content: "❌ **API Error:** Failed to connect to Roblox API." });
    }
}

/**
 * Links a Discord account to a Roblox ID.
 * Usage: /linkroblox <id>
 */
async function handleLinkRoblox(interaction) {
    const rId = interaction.options.getString("roblox_id");

    // Validate ID format (Must be numeric)
    if (!/^\d+$/.test(rId)) {
        return interaction.reply({ 
            content: "❌ **Invalid ID:** Roblox ID must contain only numbers.", 
            ephemeral: true 
        });
    }

    try {
        // Upsert link to database
        const { error } = await supabase.from("roblox_links").upsert({ 
            discord_id: interaction.user.id, 
            roblox_id: rId 
        }, { onConflict: 'discord_id' });

        if (error) throw error;

        const embed = createEmbed("✅ Account Linked Successfully", null, SETTINGS.COLOR_SUCCESS)
            .setDescription(`Your Discord account has been successfully linked to Roblox ID: \`${rId}\`.\n\nYou can now proceed to verify using:\n• \`/verify <code>\`\n• Or type \`verify <code>\` in chat.`)
            .setThumbnail(interaction.user.displayAvatarURL());

        return interaction.reply({ embeds: [embed] });

    } catch (error) {
        console.error("DB Link Error:", error);
        return interaction.reply({ content: "❌ Database error while linking.", ephemeral: true });
    }
}

// =====================================================================
// 🛡️ SECTION 2: ADMIN SECURITY & BAN SYSTEM
// =====================================================================

/**
 * Manually sets a custom verification code for a user.
 * Usage: /setcode <user> <code>
 */
async function handleSetCode(interaction) {
    const user = interaction.options.getUser("user");
    const code = interaction.options.getString("code");

    try {
        await supabase.from("verifications").upsert({ 
            discord_id: user.id, 
            code: code, 
            verified: false, 
            hwid: "RESET_BY_ADMIN" // Reset HWID to allow new connection
        }, { onConflict: 'discord_id' });

        const embed = createEmbed("✅ Custom Code Set", null, SETTINGS.COLOR_SUCCESS)
            .addFields(
                { name: "👤 Target User", value: `<@${user.id}>`, inline: true },
                { name: "🔑 New Code", value: `\`${code}\``, inline: true },
                { name: "ℹ️ Status", value: "HWID Reset & Ready to Verify", inline: false }
            );

        return interaction.reply({ embeds: [embed] });
    } catch (e) {
        return interaction.reply({ content: "❌ Failed to set code.", ephemeral: true });
    }
}

/**
 * Handles Ban/Unban/List operations.
 * Usage: /bansystem <ban/unban/list>
 */
async function handleBanSystem(interaction) {
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getString("target"); // Can be Code or HWID

    if (sub === "ban") {
        // Ban logic: Update is_banned = true
        const { error } = await supabase.from("verifications")
            .update({ is_banned: true, verified: false })
            .or(`code.eq.${target},hwid.eq.${target}`);

        if (error) return interaction.reply({ content: "❌ Database Error.", ephemeral: true });

        return interaction.reply({ 
            embeds: [createEmbed("🚫 User Banned", `Target \`${target}\` has been permanently banned from using the script.`, SETTINGS.COLOR_ERROR)] 
        });
    }

    if (sub === "unban") {
        // Unban logic: Update is_banned = false
        const { error } = await supabase.from("verifications")
            .update({ is_banned: false })
            .or(`code.eq.${target},hwid.eq.${target}`);

        if (error) return interaction.reply({ content: "❌ Database Error.", ephemeral: true });

        return interaction.reply({ 
            embeds: [createEmbed("✅ User Unbanned", `Target \`${target}\` has been unbanned. Access restored.`, SETTINGS.COLOR_SUCCESS)] 
        });
    }

    if (sub === "list") {
        // List logic
        const { data } = await supabase.from("verifications").select("*").eq("is_banned", true);
        
        let description = "No banned users found.";
        if (data && data.length > 0) {
            description = data.map((u, i) => `**${i+1}.** Code: \`${u.code}\` | HWID: \`...${u.hwid.slice(-6)}\``).join("\n");
        }

        return interaction.reply({ 
            embeds: [createEmbed("📜 Banned Users List", description, SETTINGS.COLOR_WARN)] 
        });
    }
}

// =====================================================================
// 📊 SECTION 3: USER MANAGEMENT & MONITORING
// =====================================================================

/**
 * Displays active users with pagination.
 * Usage: /activeusers
 */
async function handleActiveUsers(interaction, page = 1) {
    const LIMIT = 10;
    const offset = (page - 1) * LIMIT;
    
    // Determine how to reply (New message or Edit existing)
    const replyMethod = interaction.message ? interaction.update.bind(interaction) : interaction.reply.bind(interaction);

    // Fetch active users (verified = true AND expiry > now)
    const { data: users, count } = await supabase.from("verifications")
        .select("*", { count: 'exact' })
        .eq("verified", true)
        .gt("expires_at", new Date().toISOString())
        .range(offset, offset + LIMIT - 1);

    if (!users || users.length === 0) {
        return replyMethod({ 
            embeds: [createEmbed("🔴 No Active Users", "Currently, no one is using the script.", SETTINGS.COLOR_ERROR)], 
            components: [] 
        });
    }

    // Check for Alts (Same Discord ID used multiple times)
    const { data: allActive } = await supabase.from("verifications").select("discord_id").eq("verified", true);
    const altMap = {};
    allActive.forEach(u => { if(u.discord_id) altMap[u.discord_id] = (altMap[u.discord_id] || 0) + 1; });

    // Build the list
    const description = users.map((u, i) => {
        const expiryDate = new Date(u.expires_at);
        const timeLeft = expiryDate.getTime() - Date.now();
        
        const userDisplay = u.discord_id ? `<@${u.discord_id}>` : (u.note ? `📝 **${u.note}**` : "`Unknown/Unlinked`");
        const altBadge = (u.discord_id && altMap[u.discord_id] > 1) ? "⚠️ **MULTI-KEY**" : "✅";
        
        return `**${offset + i + 1}.** ${userDisplay} ${altBadge}\n   └ 🔑 \`${u.code}\` | ⏳ **Remaining:** ${formatTime(timeLeft)}`;
    }).join("\n\n");

    const totalPages = Math.ceil(count / LIMIT);
    
    const embed = createEmbed(`🟢 Active Users List (Page ${page}/${totalPages})`, description, SETTINGS.COLOR_SUCCESS)
        .setFooter({ text: `Total Online Users: ${count}`, iconURL: SETTINGS.FOOTER_ICON });

    // Pagination Buttons
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`active_prev_${page-1}`).setLabel("◀ Previous").setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
        new ButtonBuilder().setCustomId(`active_next_${page+1}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
    );

    await replyMethod({ embeds: [embed], components: [row] });
}

/**
 * Checks for users with multiple active keys (Alts).
 * Usage: /checkalts
 */
async function handleCheckAlts(interaction) {
    await interaction.deferReply();
    
    const { data: all } = await supabase.from("verifications")
        .select("*")
        .eq("verified", true)
        .gt("expires_at", new Date().toISOString());
    
    if (!all || all.length === 0) return interaction.editReply("✅ No active data to analyze.");
    
    const map = new Map();
    all.forEach(u => { 
        if(u.discord_id) { 
            if(!map.has(u.discord_id)) map.set(u.discord_id, []); 
            map.get(u.discord_id).push(u); 
        }
    });
    
    // Filter users with > 1 key
    const alts = Array.from(map.entries()).filter(([_, arr]) => arr.length > 1);
    
    if (alts.length === 0) {
        return interaction.editReply({ 
            embeds: [createEmbed("✅ Clean Status", "No users detected running multiple keys simultaneously.", SETTINGS.COLOR_SUCCESS)] 
        });
    }

    const description = alts.map(([id, keys]) => 
        `<@${id}> is using **${keys.length}** keys:\n` + keys.map(k => `└ 🔑 \`${k.code}\` (HWID: ...${k.hwid.slice(-4)})`).join("\n")
    ).join("\n\n");

    return interaction.editReply({ 
        embeds: [createEmbed(`⚠️ Detected ${alts.length} Multi-Key Users`, description, SETTINGS.COLOR_WARN)] 
    });
}

/**
 * Looks up detailed info about a Key or HWID.
 * Usage: /lookup <target>
 */
async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");

    const { data } = await supabase.from("verifications")
        .select("*")
        .or(`code.eq.${target},hwid.eq.${target}`)
        .maybeSingle();
    
    if (!data) {
        return interaction.editReply({ 
            embeds: [createEmbed("❌ Not Found", `No record found for target: \`${target}\``, SETTINGS.COLOR_ERROR)] 
        });
    }

    // Try to fetch Discord User Object for Avatar/Tag
    let discordUser = null;
    if (data.discord_id) { 
        try { discordUser = await interaction.client.users.fetch(data.discord_id); } catch(e){} 
    }

    // Determine Status
    const isExpired = data.expires_at && new Date(data.expires_at) < new Date();
    let statusText = "🟢 **ACTIVE**";
    let statusColor = SETTINGS.COLOR_SUCCESS;

    if (data.is_banned) {
        statusText = "🚫 **BANNED**";
        statusColor = SETTINGS.COLOR_ERROR;
    } else if (isExpired) {
        statusText = "🔴 **EXPIRED**";
        statusColor = SETTINGS.COLOR_WARN;
    }

    const embed = createEmbed("🔍 Lookup Details", null, statusColor, discordUser)
        .addFields(
            { name: "👤 User", value: data.discord_id ? `<@${data.discord_id}>` : "`Unlinked`", inline: true },
            { name: "🔑 License Key", value: `\`${data.code}\``, inline: true },
            { name: "📝 Admin Note", value: data.note ? `\`${data.note}\`` : "`None`", inline: true },
            { name: "📡 Status", value: statusText, inline: true },
            { name: "🖥️ Hardware ID", value: `\`${data.hwid}\``, inline: false },
            { name: "📅 Expiry Date", value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:F>` : "`Never`", inline: true },
            { name: "⏳ Time Remaining", value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:R>` : "`N/A`", inline: true }
        );

    return interaction.editReply({ embeds: [embed] });
}

// =====================================================================
// ⚙️ SECTION 4: SETTINGS & RULES
// =====================================================================

/**
 * Admin command to manually set expiry time for a user.
 * Usage: /setexpiry <target> <duration> [note]
 */
async function handleSetExpiry(interaction) {
    // Double check admin just in case
    if (!await require("./config").isAdmin(interaction.user.id)) {
        return interaction.reply({ content: "❌ Admin Only", ephemeral: true });
    }

    await interaction.deferReply();
    
    const target = interaction.options.getString("target");
    const durationStr = interaction.options.getString("duration");
    const note = interaction.options.getString("note") || null;

    const ms = parseDuration(durationStr);
    
    // Validate Duration
    if (!ms && durationStr.toLowerCase() !== "lifetime") {
        return interaction.editReply("❌ **Invalid Format:** Use `1d`, `12h`, `30m` or `lifetime`.");
    }

    const newExpiry = (durationStr.toLowerCase() === "lifetime") 
        ? new Date(Date.now() + 3153600000000).toISOString() // +100 Years
        : new Date(Date.now() + ms).toISOString();

    const { error } = await supabase.from("verifications")
        .update({ verified: true, expires_at: newExpiry, note: note })
        .or(`code.eq.${target},hwid.eq.${target}`);

    if (error) return interaction.editReply("❌ Database Error: Could not update user.");

    return interaction.editReply({ 
        embeds: [createEmbed("✅ Expiry Updated", `**Target:** \`${target}\`\n**New Duration:** \`${durationStr}\`\n**Expires:** <t:${Math.floor(new Date(newExpiry).getTime()/1000)}:R>\n**Note:** ${note || "None"}`, SETTINGS.COLOR_SUCCESS)] 
    });
}

/**
 * Manages Role-based time rules.
 * Usage: /rules <set/remove/list>
 */
async function handleRules(interaction) {
    const sub = interaction.options.getSubcommand();
    
    if (sub === "set") {
        const role = interaction.options.getRole("role");
        const dur = interaction.options.getString("duration");
        
        await supabase.from("role_rules").upsert({ 
            role_id: role.id, 
            role_name: role.name, 
            duration: dur 
        }, { onConflict: 'role_id' });

        return interaction.reply({ 
            embeds: [createEmbed("✅ Rule Configured", `**Role:** ${role}\n**Duration:** \`${dur}\`\n\n*Users with this role will verify for this duration.*`, SETTINGS.COLOR_SUCCESS)] 
        });
    }
    
    if (sub === "remove") {
        const role = interaction.options.getRole("role");
        await supabase.from("role_rules").delete().eq("role_id", role.id);
        return interaction.reply({ 
            embeds: [createEmbed("🗑️ Rule Removed", `Configuration deleted for role **${role.name}**.`, SETTINGS.COLOR_WARN)] 
        });
    }

    if (sub === "list") {
        const { data } = await supabase.from("role_rules").select("*");
        const list = data.map(r => `• <@&${r.role_id}> ➜ **${r.duration}**`).join("\n") || "No custom rules set.";
        
        return interaction.reply({ 
            embeds: [createEmbed("📜 Verification Rules", list, SETTINGS.COLOR_INFO)] 
        });
    }
}

// =====================================================================
// 🔑 SECTION 5: CORE VERIFICATION LOGIC
// =====================================================================

/**
 * The main function to process a verification request.
 * Compatible with both Slash Commands (/verify) and Text Messages (verify 123).
 * * @param {User} user - The Discord User
 * @param {string} codeInput - The code string provided
 * @param {Guild} guild - The Guild object
 * @param {Function} replyCallback - Callback to send the reply (reply/editReply)
 */
async function processVerification(user, codeInput, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) {
        return replyCallback({ content: "🚧 **System Maintenance:** Verification is currently paused.", ephemeral: true });
    }

    // 1. Sanitize Input (Remove 'verify' keyword if user typed 'verify 123456')
    const code = codeInput.replace(/verify/gi, "").trim();

    // 2. Check Roblox Link
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    
    if (!link) {
        return replyCallback({ 
            embeds: [createEmbed("⚠️ Link Required", `Hello <@${user.id}>, you are not linked!\n\n1️⃣ **Get ID:** \`/getid <username>\`\n2️⃣ **Link:** \`/linkroblox <id>\`\n3️⃣ **Verify:** Retry verifying after linking.`, SETTINGS.COLOR_WARN)] 
        });
    }

    // 3. Check Active Polls (Punishment Logic)
    let isPollPunished = false;
    let pollUrl = "";
    
    if (SETTINGS.POLL_LOCK) { // Can be toggled in config if needed
        // Find latest active poll
        const { data: activePoll } = await supabase.from("polls").select("*").eq("is_active", true).order('created_at', { ascending: false }).limit(1).maybeSingle();
        
        if (activePoll) {
            // Check if user voted
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            
            if (!vote) {
                isPollPunished = true;
                pollUrl = `https://discord.com/channels/${SETTINGS.GUILD_ID}/${activePoll.channel_id}`; 
            }
        }
    }

    // 4. Validate Code in Database
    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    
    if (!userData) {
        return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "This code does not exist. Please get a valid key from the game.", SETTINGS.COLOR_ERROR)] });
    }
    
    if (userData.is_banned) {
        return replyCallback({ embeds: [createEmbed("🚫 ACCESS DENIED", "You are permanently banned from this system.", SETTINGS.COLOR_ERROR)] });
    }

    // 5. Calculate Duration (Boosts vs Punishments)
    let finalDuration = SETTINGS.DEFAULT_VERIFY_MS;
    let ruleName = "Default Access (18h)";
    
    if (isPollPunished) {
        finalDuration = SETTINGS.DEFAULT_PUNISH_MS; // e.g., 1 Hour
        ruleName = "⚠️ POLL PENALTY (Vote Missed)";
    } else {
        // Check Role Rules
        try {
            const member = await guild.members.fetch(user.id);
            const { data: rules } = await supabase.from("role_rules").select("*");
            
            if (rules && rules.length > 0) {
                let maxDuration = SETTINGS.DEFAULT_VERIFY_MS;
                
                rules.forEach(r => {
                    if (member.roles.cache.has(r.role_id)) {
                        const d = parseDuration(r.duration);
                        // Priority: Lifetime > Higher Time
                        if (d === "LIFETIME") { 
                            maxDuration = "LIFETIME"; 
                            ruleName = `👑 ${r.role_name} (Lifetime)`; 
                        } else if (maxDuration !== "LIFETIME" && d > maxDuration) { 
                            maxDuration = d; 
                            ruleName = `⭐ ${r.role_name}`; 
                        }
                    }
                });
                finalDuration = maxDuration;
            }
        } catch (e) {
            console.error("Role Check Error:", e);
        }
    }

    // 6. Update Database
    const expiryTime = finalDuration === "LIFETIME" 
        ? new Date(Date.now() + 3153600000000).toISOString() 
        : new Date(Date.now() + finalDuration).toISOString();
        
    await supabase.from("verifications")
        .update({ verified: true, expires_at: expiryTime, discord_id: user.id })
        .eq("id", userData.id);

    // 7. Security Logging (Multi-Key Check)
    const { data: activeKeys } = await supabase.from("verifications").select("*").eq("discord_id", user.id).eq("verified", true);
    if (activeKeys && activeKeys.length > 1) {
        logToWebhook("⚠️ Suspicious Activity", `User <@${user.id}> verified Key \`${code}\` but already has active keys!`);
    }

    // 8. Final Response
    const embed = createEmbed(
        isPollPunished ? "⚠️ Verified (With Restrictions)" : "✅ Verification Successful", 
        isPollPunished 
            ? `**You missed a Poll!**\n[Click here to Vote](${pollUrl}) to get full time next access.\n\n*Penalty Applied.*` 
            : "**Access Granted!** Enjoy your script session.",
        isPollPunished ? SETTINGS.COLOR_WARN : SETTINGS.COLOR_SUCCESS, 
        user
    ).addFields(
        { name: "🔑 License Key", value: `\`${code}\``, inline: true },
        { name: "⏳ Time Granted", value: `\`${formatTime(finalDuration)}\``, inline: true },
        { name: "📜 Applied Logic", value: `\`${ruleName}\``, inline: true },
        { name: "📅 Expires At", value: finalDuration === "LIFETIME" ? "**Never**" : `<t:${Math.floor(new Date(expiryTime).getTime()/1000)}:R>`, inline: false }
    );

    return replyCallback({ embeds: [embed] });
}

// =====================================================================
// 📤 EXPORTS
// =====================================================================
module.exports = { 
    processVerification, 
    handleGetRobloxId, 
    handleLinkRoblox, 
    handleActiveUsers, 
    handleSetCode, 
    handleBanSystem, 
    handleRules, 
    handleLookup, 
    handleSetExpiry,
    handleCheckAlts 
};
