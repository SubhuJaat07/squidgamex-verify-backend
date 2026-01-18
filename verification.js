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
// 🌐 SECTION 1: SMART VERIFICATION FLOW
// =====================================================================

/**
 * Handles the /verify command (Slash)
 */
async function handleVerifyCommand(interaction) {
    await interaction.deferReply();
    const code = interaction.options.getString("code");
    
    // Pass editReply because we deferred
    await processVerification(interaction.user, code, interaction.guild, (opts) => interaction.editReply(opts), interaction);
}

/**
 * Handles "Link Roblox" Button Click -> Opens Modal
 */
async function handleLinkButton(interaction) {
    const code = interaction.customId.split('_')[2]; 

    const modal = new ModalBuilder()
        .setCustomId(`link_modal_${code}`)
        .setTitle("🔗 Link Roblox Account");

    const usernameInput = new TextInputBuilder()
        .setCustomId("r_username")
        .setLabel("Enter Roblox Username")
        .setPlaceholder("e.g. RobloxPlayer123")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const row = new ActionRowBuilder().addComponents(usernameInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
}

/**
 * Handles Modal Submit -> Fetches Profile -> Asks Confirmation
 */
async function handleLinkModal(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    const username = interaction.fields.getTextInputValue("r_username");
    const code = interaction.customId.split('_')[2]; 

    try {
        // Fetch User from Roblox API
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
                embeds: [createEmbed("❌ User Not Found", `Could not find any Roblox user named **${username}**`, SETTINGS.COLOR_ERROR)] 
            });
        }
        
        const rUser = json.data[0];
        const avatarUrl = `https://www.roblox.com/headshot-thumbnail/image?userId=${rUser.id}&width=420&height=420&format=png`;

        const embed = createEmbed("👤 Confirm Identity", `Is this your Roblox account?`, SETTINGS.COLOR_INFO)
            .addFields(
                { name: "📛 Username", value: `\`${rUser.name}\``, inline: true },
                { name: "🆔 Roblox ID", value: `\`${rUser.id}\``, inline: true }
            )
            .setThumbnail(avatarUrl);
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`link_confirm_${rUser.id}_${rUser.name}_${code}`).setLabel("✅ Yes, This is me").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("link_cancel").setLabel("❌ No, Wrong Account").setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });

    } catch(e) { 
        console.error("API Error:", e);
        interaction.editReply({ content: "❌ **Roblox API Error:** Failed to fetch user data." }); 
    }
}

/**
 * Handles the "Yes/No" Confirmation
 */
async function handleLinkConfirm(interaction) {
    // FIX: Handle "No" properly to avoid interaction error
    if (interaction.customId === "link_cancel") {
        return interaction.update({ 
            content: "❌ **Verification Cancelled.** You can try again with the correct username.", 
            embeds: [], 
            components: [] 
        });
    }

    await interaction.deferUpdate();
    
    const parts = interaction.customId.split('_');
    const rId = parts[2];
    const rName = parts[3];
    const code = parts[4];

    // Check for Alt Account (Is this Roblox ID linked to someone else?)
    const { data: existing } = await supabase.from("roblox_links")
        .select("discord_id")
        .eq("roblox_id", rId)
        .maybeSingle();

    if (existing && existing.discord_id !== interaction.user.id) {
        logToWebhook(
            "⚠️ **Alt Link Detected**", 
            `**User:** <@${interaction.user.id}> (${interaction.user.tag})\n` +
            `**Action:** Linked Roblox ID \`${rId}\` (${rName})\n` +
            `**Conflict:** This ID was previously linked to <@${existing.discord_id}>. Link has been overwritten.`
        );
    }

    // Save Link
    await supabase.from("roblox_links").upsert({ 
        discord_id: interaction.user.id, 
        roblox_id: rId, 
        roblox_username: rName 
    }, { onConflict: 'discord_id' });

    // Proceed to Verification
    // We pass 'interaction.message.edit' context effectively via editReply since we are in a button flow
    await processVerification(interaction.user, code, interaction.guild, (opts) => interaction.editReply(opts), interaction);
}

// =====================================================================
// 🛡️ SECTION 2: ADMIN & SECURITY
// =====================================================================

async function handleSetNote(interaction) {
    if (!await require("./config").isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Admin Only", ephemeral: true });

    const target = interaction.options.getString("target");
    const note = interaction.options.getString("note");

    const { data: user } = await supabase.from("verifications")
        .select("id, discord_id")
        .or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`)
        .maybeSingle();

    if (!user) return interaction.reply({ content: `❌ **Error:** No user found for target \`${target}\`.`, ephemeral: true });

    await supabase.from("verifications").update({ admin_note: note }).eq("id", user.id);
    
    return interaction.reply({ 
        embeds: [createEmbed("✅ Note Saved", `**Target:** <@${user.discord_id}>\n**Note:** ${note}`, SETTINGS.COLOR_SUCCESS)] 
    });
}

async function handleBanSystem(interaction) {
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getString("target");

    if (sub === 'list') {
        await interaction.deferReply();
        const { data } = await supabase.from("verifications").select("*").eq("is_banned", true);
        const list = data && data.length > 0 ? data.map(u => `\`${u.code}\` (HWID: ${u.hwid})`).join("\n") : "No active bans.";
        return interaction.editReply({ embeds: [createEmbed("📜 Banned Users", list, SETTINGS.COLOR_WARN)] });
    }

    // Lookup user first
    const { data: user } = await supabase.from("verifications")
        .select("*")
        .or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`)
        .maybeSingle();
    
    if (!user) return interaction.reply({ content: "❌ **User Not Found.** Check the Code/HWID/ID.", ephemeral: true });

    if (sub === "ban") {
        await supabase.from("verifications").update({ is_banned: true, verified: false }).eq("id", user.id);
        return interaction.reply({ embeds: [createEmbed("🚫 User Banned", `**Target:** \`${target}\`\n**Action:** Access Revoked Permanently.`, SETTINGS.COLOR_ERROR)] });
    }
    
    if (sub === "unban") {
        await supabase.from("verifications").update({ is_banned: false }).eq("id", user.id);
        return interaction.reply({ embeds: [createEmbed("✅ User Unbanned", `**Target:** \`${target}\`\n**Action:** Access Restored.`, SETTINGS.COLOR_SUCCESS)] });
    }
}

async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    
    const { data } = await supabase.from("verifications")
        .select("*")
        .or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`)
        .maybeSingle();
    
    if (!data) return interaction.editReply({ embeds: [createEmbed("❌ Not Found", `No records for \`${target}\``, SETTINGS.COLOR_ERROR)] });

    // Fetch Linked Roblox Data
    const { data: rLink } = await supabase.from("roblox_links").select("*").eq("discord_id", data.discord_id).maybeSingle();
    
    // Status Logic
    const isExpired = data.expires_at && new Date(data.expires_at) < new Date();
    const status = data.is_banned ? "🚫 **BANNED**" : (isExpired ? "🔴 **EXPIRED**" : "🟢 **ACTIVE**");
    const color = data.is_banned ? SETTINGS.COLOR_ERROR : (status.includes("ACTIVE") ? SETTINGS.COLOR_SUCCESS : SETTINGS.COLOR_WARN);

    // Fetch Discord Info
    let discordUser = null;
    try { if (data.discord_id) discordUser = await interaction.client.users.fetch(data.discord_id); } catch(e){}

    // Create Embed
    const embed = createEmbed("🔍 User Information", "", color, discordUser);
    
    // Fetch Roblox Avatar if linked
    if (rLink) {
        embed.setThumbnail(`https://www.roblox.com/headshot-thumbnail/image?userId=${rLink.roblox_id}&width=420&height=420&format=png`);
    }

    embed.addFields(
        { name: "👤 Discord", value: data.discord_id ? `<@${data.discord_id}>\n\`${data.discord_id}\`` : "`Unlinked`", inline: true },
        { name: "🎮 Roblox", value: rLink ? `[${rLink.roblox_username}](https://www.roblox.com/users/${rLink.roblox_id}/profile)\nID: \`${rLink.roblox_id}\`` : "`Unlinked`", inline: true },
        { name: "\u200b", value: "\u200b", inline: false },
        { name: "🔑 License Key", value: `\`${data.code}\``, inline: true },
        { name: "📝 Admin Note", value: data.admin_note ? `\`${data.admin_note}\`` : "`None`", inline: true },
        { name: "📡 Status", value: status, inline: true },
        { name: "🖥️ Hardware ID", value: `\`${data.hwid}\``, inline: false }, // FULL HWID SHOWN
        { name: "⏳ Expiry", value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:F> (<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:R>)` : "`N/A`", inline: false }
    );

    return interaction.editReply({ embeds: [embed] });
}

// =====================================================================
// ⚙️ SECTION 3: RULES & CONFIGURATION
// =====================================================================

async function handleRules(interaction) {
    const sub = interaction.options.getSubcommand();
    
    if (sub === "list") {
        const { data } = await supabase.from("role_rules").select("*");
        const list = data && data.length > 0 
            ? data.map((r, i) => `**${i+1}.** <@&${r.role_id}> ➜ **${r.duration}**`).join("\n") 
            : "No custom rules set.";
        return interaction.reply({ embeds: [createEmbed("📜 Verification Rules", list, SETTINGS.COLOR_INFO)] });
    }

    if (sub === "add" || sub === "set") {
        const role = interaction.options.getRole("role");
        const dur = interaction.options.getString("duration");
        await supabase.from("role_rules").upsert({ role_id: role.id, role_name: role.name, duration: dur }, { onConflict: 'role_id' });
        return interaction.reply({ embeds: [createEmbed("✅ Rule Configured", `**Role:** ${role}\n**Duration:** \`${dur}\``, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "remove") {
        const role = interaction.options.getRole("role");
        await supabase.from("role_rules").delete().eq("role_id", role.id);
        return interaction.reply({ embeds: [createEmbed("🗑️ Rule Removed", `Removed configuration for ${role}.`, SETTINGS.COLOR_WARN)] });
    }
}

async function handleCheckAlts(interaction) {
    await interaction.deferReply();
    const { data: all } = await supabase.from("verifications").select("*").eq("verified", true).gt("expires_at", new Date().toISOString());
    
    const map = new Map();
    all.forEach(u => { 
        if(u.discord_id) { 
            if(!map.has(u.discord_id)) map.set(u.discord_id, []); 
            map.get(u.discord_id).push(u); 
        }
    });
    
    const alts = Array.from(map.entries()).filter(([_, arr]) => arr.length > 1);
    
    if (alts.length === 0) return interaction.editReply({ embeds: [createEmbed("✅ Clean", "No users found with multiple active keys.", SETTINGS.COLOR_SUCCESS)] });

    const desc = alts.map(([id, keys]) => {
        return `<@${id}> **(${keys.length} Keys)**\n` + keys.map(k => `> 🔑 \`${k.code}\` | HWID: \`${k.hwid}\``).join("\n");
    }).join("\n\n");

    return interaction.editReply({ embeds: [createEmbed(`⚠️ Detected ${alts.length} Multi-Key Users`, desc, SETTINGS.COLOR_WARN)] });
}

// =====================================================================
// 🔑 SECTION 4: CORE VERIFICATION LOGIC (The Brain)
// =====================================================================

/**
 * Main Logic.
 * 1. Validates Code & Maintenance.
 * 2. Checks DB for Auto-Detected Roblox ID (New Feature).
 * 3. Handles Link Mismatch Logic (Webhook Logs).
 * 4. Applies Rules (Punish vs Boost).
 * 5. Success Message.
 */
async function processVerification(user, codeInput, guild, replyCallback, originalInteraction = null) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 **System Maintenance Mode**", ephemeral: true });

    const code = codeInput.replace(/verify/gi, "").trim();

    // 1. Get Key Data
    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).maybeSingle();
    
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "This key does not exist or has been deleted.", SETTINGS.COLOR_ERROR)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "This key is blacklisted. Access Denied.", SETTINGS.COLOR_ERROR)] });

    // 2. Fetch User Link
    let { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();

    // ---------------------------------------------------------
    // 🔥 NEW FEATURE: AUTO-DETECT ROBLOX ID FROM SCRIPT EXECUTION
    // ---------------------------------------------------------
    // If the Lua script sent the Roblox ID during /check, it's in userData.executed_roblox_id
    if (userData.executed_roblox_id && !link) {
        // If user is NOT linked, but script sent an ID -> Ask if this is them
        const rID = userData.executed_roblox_id;
        const rName = userData.executed_roblox_username || "Unknown";
        
        const avatarUrl = `https://www.roblox.com/headshot-thumbnail/image?userId=${rID}&width=420&height=420&format=png`;

        const embed = createEmbed("👋 Welcome!", `The script detected you are playing as:\n\n**${rName}**\nID: \`${rID}\`\n\nIs this your account? Click **Yes** to link and verify instantly.`, SETTINGS.COLOR_INFO)
            .setThumbnail(avatarUrl);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`link_confirm_${rID}_${rName}_${code}`).setLabel("✅ Yes, This is me").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`link_start_${code}`).setLabel("✏️ No, Enter Manually").setStyle(ButtonStyle.Secondary)
        );

        // If we have an original interaction (Slash), use it. For text, we reply normally.
        return replyCallback({ embeds: [embed], components: [row] });
    }

    // If still not linked after Auto-Detect check, Force Link
    if (!link) {
        const embed = createEmbed("⚠️ Verification Required", "You must link your Roblox account to verify.\nClick below to start.", SETTINGS.COLOR_WARN);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`link_start_${code}`).setLabel("🔗 Link Roblox Account").setStyle(ButtonStyle.Primary)
        );
        return replyCallback({ embeds: [embed], components: [row] });
    }

    // ---------------------------------------------------------
    // 🕵️ SECURITY LOG: EXECUTOR MISMATCH
    // ---------------------------------------------------------
    // If Script Executed by User A, but Linked Account is User B
    if (userData.executed_roblox_id && userData.executed_roblox_id !== link.roblox_id) {
        logToWebhook(
            "⚠️ **Suspicious Verification**",
            `**User:** <@${user.id}>\n` +
            `**Linked Account:** ${link.roblox_username} (\`${link.roblox_id}\`)\n` +
            `**Script Executor:** ${userData.executed_roblox_username} (\`${userData.executed_roblox_id}\`)\n` +
            `**Key:** \`${code}\`\n` + 
            `**Status:** Mismatch detected but allowed.`,
            SETTINGS.COLOR_WARN
        );
    }

    // 3. Poll Punishment Check
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

    // 4. Calculate Duration
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
                    // "Punish" keyword = Penalty
                    if (r.role_name.toLowerCase().includes("punish")) {
                        if (minPunish === null || d < minPunish) { 
                            minPunish = d; 
                            ruleName = `⚖️ ${r.role_name} (Penalty)`; 
                        }
                    } else {
                        // Boost
                        if (d === "LIFETIME") maxBoost = "LIFETIME";
                        else if (maxBoost !== "LIFETIME" && d > (maxBoost || 0)) {
                            maxBoost = d; 
                            ruleName = `⭐ ${r.role_name}`;
                        }
                    }
                }
            });

            if (minPunish !== null) finalDuration = minPunish;
            else if (maxBoost !== null) finalDuration = maxBoost;
        }
    } catch(e) {}

    if (isPollPunished) {
        finalDuration = SETTINGS.DEFAULT_PUNISH_MS; 
        ruleName = "⚠️ POLL PENALTY";
    }

    const expiryTime = finalDuration === "LIFETIME" 
        ? new Date(Date.now() + 3153600000000).toISOString() 
        : new Date(Date.now() + finalDuration).toISOString();

    // 5. Update Database
    await supabase.from("verifications")
        .update({ verified: true, expires_at: expiryTime, discord_id: user.id })
        .eq("id", userData.id);

    // 6. Success Response
    const { data: conf } = await supabase.from("guild_config").select("verify_success_msg").eq("guild_id", guild.id).maybeSingle();
    const customText = conf?.verify_success_msg ? `\n\n${conf.verify_success_msg}` : "";

    const embed = createEmbed(
        isPollPunished ? "⚠️ Verification Restricted" : "✅ Verification Successful", 
        isPollPunished 
            ? `**Access Granted, but you missed a Poll!**\n[Vote Here](${pollUrl}) to remove this penalty next time.`
            : `**Access Granted!**\n\n**🔑 Key:** \`${code}\`\n**⏳ Duration:** ${formatTime(finalDuration)}\n**📜 Logic:** ${ruleName}\n**📅 Expires:** ${finalDuration==="LIFETIME"?"**Never**":`<t:${Math.floor(new Date(expiryTime).getTime()/1000)}:R>`}` + customText,
        isPollPunished ? SETTINGS.COLOR_WARN : SETTINGS.COLOR_SUCCESS, 
        user
    );

    if (link) embed.setFooter({ text: `Authenticated as: ${link.roblox_username}`, iconURL: SETTINGS.FOOTER_ICON });

    return replyCallback({ embeds: [embed], components: [] }); // Empty components to remove buttons
}

// 🌐 EXPORTED UTILS
async function handleSetCode(interaction) {
    const user = interaction.options.getUser("user");
    const code = interaction.options.getString("code");
    await supabase.from("verifications").upsert({ discord_id: user.id, code: code, verified: false, hwid: "RESET_ADMIN" }, { onConflict: 'discord_id' });
    return interaction.reply({ embeds: [createEmbed("✅ Code Updated", `User: ${user}\nCode: \`${code}\``, SETTINGS.COLOR_SUCCESS)] });
}

async function handleKeyUpdate(interaction) {
    if (!await require("./config").isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Admin Only", ephemeral: true });
    
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const newCode = interaction.options.getString("new_code");

    const { data: record } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`).maybeSingle();
    
    if (!record) return interaction.editReply({ embeds: [createEmbed("❌ Not Found", `Target: \`${target}\``, SETTINGS.COLOR_ERROR)] });

    await supabase.from("verifications").update({ code: newCode }).eq("id", record.id);
    return interaction.editReply({ embeds: [createEmbed("✅ Key Updated", `User: <@${record.discord_id}>\nOld: \`${record.code}\`\nNew: \`${newCode}\``, SETTINGS.COLOR_SUCCESS)] });
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
        
    if(error) return interaction.editReply("❌ Database Error.");
    return interaction.editReply({ embeds: [createEmbed("✅ Expiry Updated", `Target: \`${target}\`\nTime: ${durationStr}`, SETTINGS.COLOR_SUCCESS)] });
}

async function handleActiveUsers(interaction, page = 1) {
    const LIMIT = 10, offset = (page - 1) * LIMIT;
    const replyMethod = interaction.message ? interaction.update.bind(interaction) : interaction.reply.bind(interaction);
    
    const { data: users, count } = await supabase.from("verifications").select("*", { count: 'exact' }).eq("verified", true).gt("expires_at", new Date().toISOString()).range(offset, offset + LIMIT - 1);
    
    if (!users || users.length === 0) return replyMethod({ embeds: [createEmbed("🔴 Active Users", "None", SETTINGS.COLOR_ERROR)] });

    const list = users.map((u, i) => `**${offset + i + 1}.** <@${u.discord_id}>\n   └ 🔑 \`${u.code}\` | ⏳ <t:${Math.floor(new Date(u.expires_at).getTime()/1000)}:R>`).join("\n\n");
    const totalPages = Math.ceil(count / LIMIT);
    
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`active_prev_${page-1}`).setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
        new ButtonBuilder().setCustomId(`active_next_${page+1}`).setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
    );
    await replyMethod({ embeds: [createEmbed(`Active Users (${count})`, list, SETTINGS.COLOR_SUCCESS)], components: [row] });
}

// 📤 EXPORTS
module.exports = { 
    handleVerifyCommand, handleLinkButton, handleLinkModal, handleLinkConfirm,
    handleSetNote, handleBanSystem, handleLookup, handleCheckAlts, handleRules,
    processVerification, handleKeyUpdate, handleSetCode, handleSetExpiry, handleActiveUsers,
    // Wrappers to redirect legacy commands to new flow
    handleGetRobloxId: async(i) => i.reply({ content: "⚠️ Please use `/verify`. The system will automatically detect your user.", ephemeral: true }),
    handleLinkRoblox: async(i) => i.reply({ content: "⚠️ Please use `/verify` to link your account via the button.", ephemeral: true })
};
