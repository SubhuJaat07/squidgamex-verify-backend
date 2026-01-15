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
    ButtonStyle, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle 
} = require("discord.js");

// =====================================================================
// 🌐 SECTION 1: INTERACTIVE VERIFICATION FLOW
// =====================================================================

/**
 * Handles the initial /verify command.
 * If user is linked -> Verifies directly.
 * If NOT linked -> Shows a button to start linking process.
 */
async function handleVerifyCommand(interaction) {
    const code = interaction.options.getString("code");
    
    // 1. Check if user is already linked
    const { data: link } = await supabase.from("roblox_links")
        .select("*")
        .eq("discord_id", interaction.user.id)
        .maybeSingle();
    
    // 2. If NOT linked, show the interactive button
    if (!link) {
        const embed = createEmbed(
            "⚠️ Account Not Linked", 
            "To verify, you must first link your Roblox account.\nClick the button below to start the process.", 
            SETTINGS.COLOR_WARN
        );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`link_start_${code}`) // Pass code to next step
                .setLabel("🔗 Link Roblox Account")
                .setStyle(ButtonStyle.Primary)
        );

        return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
    }

    // 3. If Linked, proceed to verification immediately
    await processVerification(interaction.user, code, interaction.guild, (opts) => interaction.reply(opts));
}

/**
 * Step 2: Opens the Modal for Roblox Username input.
 * Triggered by the "Link Roblox Account" button.
 */
async function handleLinkButton(interaction) {
    const code = interaction.customId.split('_')[2]; // Retrieve code from button ID

    const modal = new ModalBuilder()
        .setCustomId(`link_modal_${code}`)
        .setTitle("Link Roblox Account");

    const usernameInput = new TextInputBuilder()
        .setCustomId("r_username")
        .setLabel("Enter your Roblox Username")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const firstActionRow = new ActionRowBuilder().addComponents(usernameInput);
    modal.addComponents(firstActionRow);

    await interaction.showModal(modal);
}

/**
 * Step 3: Handles Modal Submit -> Fetches Roblox Info -> Shows Confirmation.
 */
async function handleLinkModal(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    const username = interaction.fields.getTextInputValue("r_username");
    const code = interaction.customId.split('_')[2]; 

    try {
        // Fetch User ID from Roblox
        const response = await fetch(SETTINGS.ROBLOX_API, { 
            method: 'POST', 
            headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({ 
                usernames: [username], 
                excludeBannedUsers: true 
            }) 
        });

        const json = await response.json();
        
        if (!json.data || json.data.length === 0) {
            return interaction.editReply({ 
                embeds: [createEmbed("❌ User Not Found", `Could not find Roblox user: **${username}**`, SETTINGS.COLOR_ERROR)] 
            });
        }
        
        const rUser = json.data[0];
        
        // Fetch Thumbnail for visual confirmation
        let avatarUrl = "";
        try {
            const thumbRes = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${rUser.id}&size=150x150&format=Png&isCircular=false`);
            const thumbJson = await thumbRes.json();
            if (thumbJson.data && thumbJson.data.length > 0) {
                avatarUrl = thumbJson.data[0].imageUrl;
            }
        } catch (e) {
            console.error("Thumbnail Fetch Error:", e);
        }

        // Show Confirmation Embed
        const embed = createEmbed("👤 Confirm Identity", `Is this your Roblox account?\n\n**Username:** ${rUser.name}\n**ID:** \`${rUser.id}\``, SETTINGS.COLOR_INFO);
        if (avatarUrl) embed.setThumbnail(avatarUrl);
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`link_confirm_${rUser.id}_${rUser.name}_${code}`)
                .setLabel("✅ Yes, Link & Verify")
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId("link_cancel")
                .setLabel("❌ No, Wrong Account")
                .setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });

    } catch (e) { 
        console.error("API Error:", e);
        interaction.editReply({ content: "❌ **API Error:** Failed to contact Roblox API." }); 
    }
}

/**
 * Step 4: Final Confirmation -> Save to DB -> Run Verification.
 */
async function handleLinkConfirm(interaction) {
    if (interaction.customId === "link_cancel") {
        return interaction.update({ content: "❌ Process Cancelled.", embeds: [], components: [] });
    }

    await interaction.deferUpdate();
    
    // Extract data from Custom ID: link_confirm_ID_NAME_CODE
    const parts = interaction.customId.split('_');
    const rId = parts[2];
    const rName = parts[3];
    const code = parts[4];

    // 1. Check if Roblox ID is already linked to ANOTHER Discord account (Alt Protection)
    const { data: existing } = await supabase.from("roblox_links")
        .select("discord_id")
        .eq("roblox_id", rId)
        .maybeSingle();

    if (existing && existing.discord_id !== interaction.user.id) {
        // Log this attempt
        await logToWebhook(
            "⚠️ **Alt Link Attempt Detected**", 
            `**User:** <@${interaction.user.id}> tried to link Roblox ID \`${rId}\` (${rName}).\n**Status:** This Roblox ID is already linked to <@${existing.discord_id}>.\n**Action:** Link Overwritten.`
        );
    }

    // 2. Save/Update Link
    await supabase.from("roblox_links").upsert({ 
        discord_id: interaction.user.id, 
        roblox_id: rId, 
        roblox_username: rName 
    }, { onConflict: 'discord_id' });

    // 3. Trigger Verification Process
    await processVerification(interaction.user, code, interaction.guild, (opts) => interaction.editReply(opts));
}

// =====================================================================
// 🛡️ SECTION 2: ADMIN & SECURITY COMMANDS
// =====================================================================

/**
 * Admin: Add a note to a user's verification record.
 * Usage: /setnote <target> <note>
 */
async function handleSetNote(interaction) {
    // Admin check is done in index.js, but safe to keep here too
    if (!await require("./config").isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Admin Only", ephemeral: true });

    const target = interaction.options.getString("target");
    const note = interaction.options.getString("note");

    // Find User
    const { data: user } = await supabase.from("verifications")
        .select("id, discord_id")
        .or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`)
        .maybeSingle();

    if (!user) {
        return interaction.reply({ content: `❌ **Error:** No user found for target \`${target}\`.`, ephemeral: true });
    }

    // Update Note
    await supabase.from("verifications").update({ admin_note: note }).eq("id", user.id);
    
    return interaction.reply({ 
        embeds: [createEmbed("✅ Note Updated", `**Target:** <@${user.discord_id}>\n**Note:** ${note}`, SETTINGS.COLOR_SUCCESS)] 
    });
}

/**
 * Admin: Ban or Unban a user from using the script.
 * Usage: /bansystem <ban/unban/list> <target>
 */
async function handleBanSystem(interaction) {
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getString("target");
    
    // Look up user first to confirm existence
    if (sub !== 'list') {
        const { data: user } = await supabase.from("verifications")
            .select("*")
            .or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`)
            .maybeSingle();
        
        if (!user) {
            return interaction.reply({ content: `❌ **User Not Found:** Could not find any record for \`${target}\`.`, ephemeral: true });
        }

        if (sub === "ban") {
            await supabase.from("verifications").update({ is_banned: true, verified: false }).eq("id", user.id);
            return interaction.reply({ 
                embeds: [createEmbed("🚫 User Banned", `**Target:** \`${target}\`\n**Status:** Permanently Banned`, SETTINGS.COLOR_ERROR)] 
            });
        }
        
        if (sub === "unban") {
            await supabase.from("verifications").update({ is_banned: false }).eq("id", user.id);
            return interaction.reply({ 
                embeds: [createEmbed("✅ User Unbanned", `**Target:** \`${target}\`\n**Status:** Access Restored`, SETTINGS.COLOR_SUCCESS)] 
            });
        }
    }

    if (sub === "list") {
        const { data } = await supabase.from("verifications").select("*").eq("is_banned", true);
        
        let description = "No active bans.";
        if (data && data.length > 0) {
            description = data.map((u, i) => `**${i+1}.** Code: \`${u.code}\` | HWID: \`...${u.hwid.slice(-4)}\``).join("\n");
        }
        
        return interaction.reply({ embeds: [createEmbed("📜 Ban List", description, SETTINGS.COLOR_WARN)] });
    }
}

/**
 * Admin: Lookup detailed info about a user/key.
 * Shows Roblox ID, Discord, Key, HWID, and Expiry.
 */
async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    
    const { data } = await supabase.from("verifications")
        .select("*")
        .or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`)
        .maybeSingle();
    
    if (!data) {
        return interaction.editReply({ embeds: [createEmbed("❌ Not Found", `No data found for \`${target}\``, SETTINGS.COLOR_ERROR)] });
    }

    // Fetch Linked Roblox Data
    const { data: rLink } = await supabase.from("roblox_links").select("*").eq("discord_id", data.discord_id).maybeSingle();
    
    // Status Logic
    const isExpired = data.expires_at && new Date(data.expires_at) < new Date();
    let statusText = "🟢 **ACTIVE**";
    let color = SETTINGS.COLOR_SUCCESS;

    if (data.is_banned) { statusText = "🚫 **BANNED**"; color = SETTINGS.COLOR_ERROR; }
    else if (isExpired) { statusText = "🔴 **EXPIRED**"; color = SETTINGS.COLOR_WARN; }

    // Fetch Discord User Object
    let discordUser = null;
    try { 
        if (data.discord_id) discordUser = await interaction.client.users.fetch(data.discord_id); 
    } catch(e){}

    const embed = createEmbed("🔍 User Lookup", "", color, discordUser)
        .addFields(
            { name: "👤 Discord", value: data.discord_id ? `<@${data.discord_id}>` : "`Unlinked`", inline: true },
            { name: "🎮 Roblox", value: rLink ? `[${rLink.roblox_username}](https://www.roblox.com/users/${rLink.roblox_id}/profile)` : "`Unlinked`", inline: true },
            { name: "🔑 License Key", value: `\`${data.code}\``, inline: true },
            { name: "📝 Admin Note", value: data.admin_note || "`None`", inline: true },
            { name: "📡 Status", value: statusText, inline: true },
            { name: "🖥️ HWID", value: `\`${data.hwid}\``, inline: false },
            { name: "⏳ Expiry", value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:F>` : "`Never`", inline: true }
        );

    return interaction.editReply({ embeds: [embed] });
}

// =====================================================================
// ⚙️ SECTION 3: RULES & CONFIGURATION
// =====================================================================

/**
 * Handles /rules command (add/remove/list).
 */
async function handleRules(interaction) {
    const sub = interaction.options.getSubcommand();
    
    if (sub === "list") {
        const { data } = await supabase.from("role_rules").select("*");
        if (!data || data.length === 0) return interaction.reply({ embeds: [createEmbed("📜 Verification Rules", "No rules configured.", SETTINGS.COLOR_WARN)] });

        const list = data.map((r, i) => `**${i+1}.** <@&${r.role_id}>\n   └ ⏳ Duration: **${r.duration}**`).join("\n");
        return interaction.reply({ embeds: [createEmbed("📜 Verification Rules", list, SETTINGS.COLOR_INFO)] });
    }

    if (sub === "add" || sub === "set") {
        const role = interaction.options.getRole("role");
        const dur = interaction.options.getString("duration");
        
        await supabase.from("role_rules").upsert({ 
            role_id: role.id, 
            role_name: role.name, 
            duration: dur 
        }, { onConflict: 'role_id' });

        return interaction.reply({ embeds: [createEmbed("✅ Rule Added", `**Role:** ${role}\n**Duration:** ${dur}`, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "remove") {
        const role = interaction.options.getRole("role");
        await supabase.from("role_rules").delete().eq("role_id", role.id);
        return interaction.reply({ embeds: [createEmbed("🗑️ Rule Removed", `Deleted rule for ${role}.`, SETTINGS.COLOR_WARN)] });
    }
}

/**
 * Handles /checkalts command.
 */
async function handleCheckAlts(interaction) {
    await interaction.deferReply();
    const { data: all } = await supabase.from("verifications")
        .select("*")
        .eq("verified", true)
        .gt("expires_at", new Date().toISOString());
    
    const map = new Map();
    all.forEach(u => { 
        if(u.discord_id) { 
            if(!map.has(u.discord_id)) map.set(u.discord_id, []); 
            map.get(u.discord_id).push(u); 
        }
    });
    
    const alts = Array.from(map.entries()).filter(([_, arr]) => arr.length > 1);
    
    if (alts.length === 0) return interaction.editReply({ embeds: [createEmbed("✅ No Alts Detected", "All active users are unique.", SETTINGS.COLOR_SUCCESS)] });

    const desc = alts.map(([id, keys]) => {
        return `<@${id}> **(${keys.length} Keys)**\n` + keys.map(k => `> 🔑 \`${k.code}\` | HWID: \`...${k.hwid.slice(-4)}\``).join("\n");
    }).join("\n\n");

    return interaction.editReply({ embeds: [createEmbed(`⚠️ Found ${alts.length} Multi-Key Users`, desc, SETTINGS.COLOR_WARN)] });
}

// =====================================================================
// 🔑 SECTION 4: CORE VERIFICATION LOGIC (The Brain)
// =====================================================================

/**
 * The main logic that processes verification.
 * 1. Checks Maintenance & Links
 * 2. Checks Poll Participation
 * 3. Validates Key & Ban Status
 * 4. Calculates Duration based on Roles (Punish vs Boost)
 * 5. Logs Alt Activity to Webhook
 * 6. Updates Database & Replies
 */
async function processVerification(user, codeInput, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 System Maintenance", ephemeral: true });

    // 1. Sanitize Input
    const code = codeInput.replace(/verify/gi, "").trim();

    // 2. Database Checks
    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).maybeSingle();
    
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "This key does not exist.", SETTINGS.COLOR_ERROR)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "Your access has been revoked.", SETTINGS.COLOR_ERROR)] });

    // 3. Link Check
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    // (Double check here for safety, though slash cmd handles it)
    if (!link) {
        return replyCallback({ embeds: [createEmbed("⚠️ Not Linked", "Please use `/verify` slash command to link your account first.", SETTINGS.COLOR_WARN)] });
    }

    // 4. Poll Punishment Check
    let isPollPunished = false;
    let pollUrl = "";
    if (SETTINGS.POLL_LOCK) {
        const { data: activePoll } = await supabase.from("polls").select("*").eq("is_active", true).order('created_at', { ascending: false }).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) { 
                isPollPunished = true; 
                pollUrl = `https://discord.com/channels/${SETTINGS.GUILD_ID}/${activePoll.channel_id}`; 
            }
        }
    }

    // 5. Time Calculation (Smart Logic: Punish < Boost)
    let finalDuration = SETTINGS.DEFAULT_VERIFY_MS;
    let ruleName = "Default";
    
    try {
        const member = await guild.members.fetch(user.id);
        const { data: rules } = await supabase.from("role_rules").select("*");
        
        if (rules && rules.length > 0) {
            let minPunish = null;
            let maxBoost = null;

            rules.forEach(r => {
                if (member.roles.cache.has(r.role_id)) {
                    const d = parseDuration(r.duration);
                    
                    // Logic: If role name contains "punish", treat as Penalty (Min Time)
                    if (r.role_name.toLowerCase().includes("punish")) {
                        if (minPunish === null || d < minPunish) { 
                            minPunish = d; 
                            ruleName = `⚖️ ${r.role_name} (Penalty)`; 
                        }
                    } else {
                        // Else treat as Boost (Max Time)
                        if (d === "LIFETIME") maxBoost = "LIFETIME";
                        else if (maxBoost !== "LIFETIME" && d > (maxBoost || 0)) {
                            maxBoost = d; 
                            ruleName = `⭐ ${r.role_name}`;
                        }
                    }
                }
            });

            // Punishment takes priority over Boost
            if (minPunish !== null) finalDuration = minPunish;
            else if (maxBoost !== null) finalDuration = maxBoost;
        }
    } catch(e) {}

    // Apply Poll Penalty if applicable (Overrides everything)
    if (isPollPunished) {
        finalDuration = SETTINGS.DEFAULT_PUNISH_MS; 
        ruleName = "⚠️ POLL PENALTY";
    }

    const expiryTime = finalDuration === "LIFETIME" 
        ? new Date(Date.now() + 3153600000000).toISOString() 
        : new Date(Date.now() + finalDuration).toISOString();

    // 6. DETAILED ALT LOGGING
    const { data: activeKeys } = await supabase.from("verifications").select("*").eq("discord_id", user.id).eq("verified", true);
    
    if (activeKeys && activeKeys.length > 0) {
        // Find if this is a different key
        const isNewKey = !activeKeys.some(k => k.code === code);
        
        if (isNewKey) {
            const oldKeyInfo = activeKeys.map(k => `\`${k.code}\` (HWID: \`...${k.hwid.slice(-4)}\`)`).join(", ");
            const rName = link ? link.roblox_username : "Unknown";
            const rID = link ? link.roblox_id : "Unknown";

            logToWebhook("⚠️ **Multi-Key Activity Detected**", 
                `**User:** <@${user.id}> (${user.tag})\n` +
                `**Roblox:** ${rName} (ID: \`${rID}\`)\n\n` +
                `**Previous Key(s):** ${oldKeyInfo}\n` +
                `**New Key:** \`${code}\` (HWID: \`...${userData.hwid.slice(-4)}\`)\n` +
                `**Time:** <t:${Math.floor(Date.now()/1000)}:F>`,
                SETTINGS.COLOR_WARN
            );
        }
    }

    // 7. Update DB
    await supabase.from("verifications")
        .update({ verified: true, expires_at: expiryTime, discord_id: user.id })
        .eq("id", userData.id);

    // 8. Success Message
    const { data: conf } = await supabase.from("guild_config").select("verify_success_msg").eq("guild_id", guild.id).maybeSingle();
    const customText = conf?.verify_success_msg ? `\n\n${conf.verify_success_msg}` : "";

    const embed = createEmbed(
        isPollPunished ? "⚠️ Verified (Restricted)" : "✅ Verification Successful", 
        isPollPunished 
            ? `**You missed a Poll!**\n[Vote Here](${pollUrl}) to remove restriction.\n\n*Penalty Applied.*`
            : `**Access Granted!**\n\n**🔑 Key:** \`${code}\`\n**⏳ Duration:** ${formatTime(finalDuration)}\n**📜 Logic:** ${ruleName}\n**📅 Expires:** ${finalDuration==="LIFETIME"?"**Never**":`<t:${Math.floor(new Date(expiryTime).getTime()/1000)}:R>`}` + customText,
        isPollPunished ? SETTINGS.COLOR_WARN : SETTINGS.COLOR_SUCCESS, 
        user
    );

    // If linked, show Roblox ID in footer
    if (link) embed.setFooter({ text: `Linked as: ${link.roblox_username} (${link.roblox_id})`, iconURL: SETTINGS.FOOTER_ICON });

    return replyCallback({ embeds: [embed] });
}

// 🔥 NEW: Handle Key Update
async function handleKeyUpdate(interaction) {
    if (!await require("./config").isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Admin Only", ephemeral: true });

    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const newCode = interaction.options.getString("new_code");

    // Search by all possible fields
    const { data: record } = await supabase.from("verifications")
        .select("*")
        .or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`)
        .maybeSingle();

    if (!record) return interaction.editReply({ embeds: [createEmbed("❌ Not Found", `Target not found: \`${target}\``, SETTINGS.COLOR_ERROR)] });

    await supabase.from("verifications").update({ code: newCode }).eq("id", record.id);

    return interaction.editReply({ 
        embeds: [createEmbed("✅ Key Updated", `**User:** <@${record.discord_id}>\n**Old Key:** \`${record.code}\`\n**New Key:** \`${newCode}\``, SETTINGS.COLOR_SUCCESS)] 
    });
}

// 🌐 RE-EXPORTED FUNCTIONS FOR INDEX.JS COMPATIBILITY
async function handleSetCode(interaction) {
    const user = interaction.options.getUser("user");
    const code = interaction.options.getString("code");
    await supabase.from("verifications").upsert({ discord_id: user.id, code: code, verified: false, hwid: "RESET_ADMIN" }, { onConflict: 'discord_id' });
    return interaction.reply({ embeds: [createEmbed("✅ Code Set", `User: ${user}\nCode: \`${code}\``, SETTINGS.COLOR_SUCCESS)] });
}

async function handleSetExpiry(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const durationStr = interaction.options.getString("duration");
    const note = interaction.options.getString("note") || null;
    
    const ms = parseDuration(durationStr);
    if (!ms && durationStr !== 'lifetime') return interaction.editReply("❌ Invalid Duration");
    
    const exp = durationStr === 'lifetime' ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString();
    
    const { error } = await supabase.from("verifications")
        .update({ verified: true, expires_at: exp, admin_note: note })
        .or(`code.eq.${target},hwid.eq.${target}`);
        
    if(error) return interaction.editReply("❌ Error updating.");
    return interaction.editReply({ embeds: [createEmbed("✅ Expiry Updated", `Target: \`${target}\`\nNew Time: ${durationStr}`, SETTINGS.COLOR_SUCCESS)] });
}

async function handleActiveUsers(interaction, page = 1) {
    const LIMIT = 10;
    const offset = (page - 1) * LIMIT;
    const replyMethod = interaction.message ? interaction.update.bind(interaction) : interaction.reply.bind(interaction);
    
    const { data: users, count } = await supabase.from("verifications")
        .select("*", { count: 'exact' })
        .eq("verified", true)
        .gt("expires_at", new Date().toISOString())
        .range(offset, offset + LIMIT - 1);

    if (!users || users.length === 0) return replyMethod({ embeds: [createEmbed("🔴 Active Users", "No active users.", SETTINGS.COLOR_ERROR)] });

    const list = users.map((u, i) => `**${offset + i + 1}.** <@${u.discord_id}>\n   └ 🔑 \`${u.code}\` | ⏳ <t:${Math.floor(new Date(u.expires_at).getTime()/1000)}:R>`).join("\n\n");
    const totalPages = Math.ceil(count / LIMIT);
    
    const embed = createEmbed(`🟢 Active Users (${page}/${totalPages})`, list, SETTINGS.COLOR_SUCCESS);
    
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`active_prev_${page-1}`).setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
        new ButtonBuilder().setCustomId(`active_next_${page+1}`).setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
    );
    
    await replyMethod({ embeds: [embed], components: [row] });
}

// 📤 EXPORTS
module.exports = { 
    handleVerifyCommand, handleLinkButton, handleLinkModal, handleLinkConfirm,
    handleSetNote, handleBanSystem, handleLookup, handleCheckAlts, handleRules,
    processVerification, handleKeyUpdate, handleSetCode, handleSetExpiry, handleActiveUsers,
    // Wrappers for Public GetID/Link to redirect to verify
    handleGetRobloxId: async(i) => i.reply({ content: "⚠️ Use `/verify` to link automatically.", ephemeral: true }),
    handleLinkRoblox: async(i) => i.reply({ content: "⚠️ Use `/verify` to link automatically.", ephemeral: true })
};
