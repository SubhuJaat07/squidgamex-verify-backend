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
// 🎨 HELPER: FETCH ROBLOX AVATAR
// =====================================================================
async function getRobloxAvatar(userId) {
    try {
        const res = await fetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userId}&size=420x420&format=Png&isCircular=false`);
        const json = await res.json();
        return json.data?.[0]?.imageUrl || null;
    } catch (e) {
        return null;
    }
}

// =====================================================================
// 🌐 SECTION 1: INTERACTIVE VERIFICATION FLOW
// =====================================================================

/**
 * Handles the main /verify command.
 */
async function handleVerifyCommand(interaction) {
    // 1. Defer Reply to prevent timeouts
    await interaction.deferReply();
    
    const code = interaction.options.getString("code");
    
    // 2. Check Link Status
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", interaction.user.id).maybeSingle();
    
    // 3. If NOT Linked -> Show Beautiful Prompt
    if (!link) {
        const embed = createEmbed(
            "⚠️ Verification Requirement", 
            `Hey <@${interaction.user.id}>, welcome!\n\nTo verify your key, you must first **link your Roblox account**.\nThis ensures your key is secure and tied to you.\n\nClick the button below to start.`, 
            SETTINGS.COLOR_WARN
        );
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`link_start_${code}`)
                .setLabel("🔗 Link Roblox Account")
                .setStyle(ButtonStyle.Primary)
                .setEmoji("🎮")
        );
        
        // Using editReply because we deferred
        return interaction.editReply({ embeds: [embed], components: [row] });
    }

    // 4. If Linked -> Verify
    await processVerification(interaction.user, code, interaction.guild, (opts) => interaction.editReply(opts));
}

async function handleLinkButton(interaction) {
    const code = interaction.customId.split('_')[2];
    
    const modal = new ModalBuilder()
        .setCustomId(`link_modal_${code}`)
        .setTitle("🎮 Link Roblox Account");

    const input = new TextInputBuilder()
        .setCustomId("r_username")
        .setLabel("What is your Roblox Username?")
        .setPlaceholder("e.g. Builderman")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

    const row = new ActionRowBuilder().addComponents(input);
    modal.addComponents(row);

    await interaction.showModal(modal);
}

async function handleLinkModal(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    const username = interaction.fields.getTextInputValue("r_username");
    const code = interaction.customId.split('_')[2]; 

    try {
        const res = await fetch(SETTINGS.ROBLOX_API, { 
            method: 'POST', headers: {'Content-Type': 'application/json'}, 
            body: JSON.stringify({ usernames: [username], excludeBannedUsers: true }) 
        });
        const json = await res.json();
        
        if (!json.data || json.data.length === 0) {
            return interaction.editReply({ 
                embeds: [createEmbed("❌ User Not Found", `We couldn't find a Roblox user named **${username}**.\nPlease check the spelling and try again.`, SETTINGS.COLOR_ERROR)] 
            });
        }
        
        const rUser = json.data[0];
        const avatarUrl = await getRobloxAvatar(rUser.id);

        const embed = createEmbed("👤 Confirm Identity", `Is this your Roblox account?`, SETTINGS.COLOR_INFO);
        
        embed.addFields(
            { name: "📛 Username", value: `\`${rUser.name}\``, inline: true },
            { name: "🆔 Roblox ID", value: `\`${rUser.id}\``, inline: true }
        );
        
        if (avatarUrl) embed.setThumbnail(avatarUrl);
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`link_confirm_${rUser.id}_${rUser.name}_${code}`).setLabel("✅ Yes, This is me").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("link_cancel").setLabel("❌ No, Wrong Account").setStyle(ButtonStyle.Secondary)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });

    } catch(e) { 
        console.error("Roblox API Error:", e);
        interaction.editReply({ content: "❌ **API Error:** Failed to fetch data from Roblox." }); 
    }
}

async function handleLinkConfirm(interaction) {
    if (interaction.customId === "link_cancel") {
        return interaction.update({ content: "❌ **Cancelled.** You can try again anytime.", embeds: [], components: [] });
    }

    await interaction.deferUpdate();
    
    const [_, __, rId, rName, code] = interaction.customId.split('_');

    // Alt Check
    const { data: existing } = await supabase.from("roblox_links").select("discord_id").eq("roblox_id", rId).maybeSingle();
    if (existing && existing.discord_id !== interaction.user.id) {
        logToWebhook("⚠️ **Alt Link Detected**", 
            `**User:** <@${interaction.user.id}> (${interaction.user.tag})\n` +
            `**Action:** Linked Roblox ID \`${rId}\` (${rName})\n` +
            `**Previous Owner:** <@${existing.discord_id}>\n` +
            `**Result:** Ownership Transferred.`
        );
    }

    // Save Link
    await supabase.from("roblox_links").upsert({ 
        discord_id: interaction.user.id, 
        roblox_id: rId, 
        roblox_username: rName 
    }, { onConflict: 'discord_id' });

    // Trigger Verification
    await processVerification(interaction.user, code, interaction.guild, (opts) => interaction.editReply(opts));
}

// =====================================================================
// 🛡️ SECTION 2: ADMIN COMMANDS (Detailed Responses)
// =====================================================================

async function handleSetExpiry(interaction) {
    if (!await require("./config").isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Admin Only", ephemeral: true });

    await interaction.deferReply();

    const target = interaction.options.getString("target");
    const durationStr = interaction.options.getString("duration");
    const note = interaction.options.getString("note") || null;

    let ms = parseDuration(durationStr);
    const isLifetime = durationStr.toLowerCase() === 'lifetime';

    if ((!ms || isNaN(ms)) && !isLifetime) {
        return interaction.editReply({ embeds: [createEmbed("❌ Invalid Format", "Please use valid time formats:\n`1d`, `12h`, `30m` or `lifetime`.", SETTINGS.COLOR_ERROR)] });
    }

    let newExpiryDate;
    if (isLifetime) newExpiryDate = new Date(Date.now() + 3153600000000); 
    else newExpiryDate = new Date(Date.now() + ms);

    // Sanity Check
    if (isNaN(newExpiryDate.getTime())) return interaction.editReply({ content: "❌ Error: Date Calculation Failed." });

    const { data: user } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`).maybeSingle();
    
    if (!user) return interaction.editReply({ embeds: [createEmbed("❌ Not Found", `User with target \`${target}\` not found in database.`, SETTINGS.COLOR_ERROR)] });

    // Update
    await supabase.from("verifications").update({ 
        verified: true, 
        expires_at: newExpiryDate.toISOString(), 
        admin_note: note 
    }).eq("id", user.id);

    // Fetch Roblox Avatar for Embed
    const { data: rLink } = await supabase.from("roblox_links").select("roblox_id").eq("discord_id", user.discord_id).maybeSingle();
    const avatar = rLink ? await getRobloxAvatar(rLink.roblox_id) : null;

    const embed = createEmbed("✅ Expiry Updated", `Access duration has been modified successfully.`, SETTINGS.COLOR_SUCCESS)
        .addFields(
            { name: "👤 User", value: `<@${user.discord_id || 'Unlinked'}>`, inline: true },
            { name: "🔑 Key", value: `\`${user.code}\``, inline: true },
            { name: "⏱️ New Duration", value: `\`${durationStr}\``, inline: true },
            { name: "📅 New Expiry", value: `<t:${Math.floor(newExpiryDate.getTime()/1000)}:F>`, inline: false },
            { name: "📝 Note", value: note || "*No note provided*", inline: false },
            { name: "👮 Admin", value: `<@${interaction.user.id}>`, inline: true }
        );
    
    if (avatar) embed.setThumbnail(avatar);

    return interaction.editReply({ embeds: [embed] });
}

async function handleSetNote(interaction) {
    if (!await require("./config").isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Admin Only", ephemeral: true });
    
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const note = interaction.options.getString("note");

    const { data: user } = await supabase.from("verifications").select("id, discord_id, code").or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`).maybeSingle();
    
    if (!user) return interaction.editReply("❌ User Not Found");

    await supabase.from("verifications").update({ admin_note: note }).eq("id", user.id);
    
    return interaction.editReply({ 
        embeds: [createEmbed("✅ Admin Note Updated", `**User:** <@${user.discord_id}>\n**Key:** \`${user.code}\`\n**Note:** \`\`\`${note}\`\`\``, SETTINGS.COLOR_SUCCESS)] 
    });
}

async function handleBanSystem(interaction) {
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getString("target");

    // LIST BANS
    if (sub === 'list') {
        await interaction.deferReply();
        const { data } = await supabase.from("verifications").select("*").eq("is_banned", true);
        
        if (!data || data.length === 0) return interaction.editReply({ embeds: [createEmbed("📜 Ban List", "No active bans found.", SETTINGS.COLOR_SUCCESS)] });

        const list = data.map(u => `• **Key:** \`${u.code}\` | **HWID:** \`...${u.hwid.slice(-6)}\` | **User:** <@${u.discord_id}>`).join("\n");
        return interaction.editReply({ embeds: [createEmbed(`🚫 Banned Users (${data.length})`, list, SETTINGS.COLOR_WARN)] });
    }

    // BAN / UNBAN
    await interaction.deferReply();
    const { data: user } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`).maybeSingle();
    
    if (!user) return interaction.editReply({ embeds: [createEmbed("❌ Error", "User not found in database.", SETTINGS.COLOR_ERROR)] });

    if (sub === "ban") {
        await supabase.from("verifications").update({ is_banned: true, verified: false }).eq("id", user.id);
        return interaction.editReply({ 
            embeds: [createEmbed("🚫 User Banned", `**Target:** <@${user.discord_id}>\n**Key:** \`${user.code}\`\n**HWID:** \`${user.hwid}\`\n\n*Access has been permanently revoked.*`, SETTINGS.COLOR_ERROR)] 
        });
    }
    
    if (sub === "unban") {
        await supabase.from("verifications").update({ is_banned: false }).eq("id", user.id);
        return interaction.editReply({ 
            embeds: [createEmbed("✅ User Unbanned", `**Target:** <@${user.discord_id}>\n**Key:** \`${user.code}\`\n\n*Access has been restored.*`, SETTINGS.COLOR_SUCCESS)] 
        });
    }
}

// 🔥 PREMIUM LOOKUP (Avatar + Full Details)
async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    
    const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target},discord_id.eq.${target}`).maybeSingle();
    
    if (!data) return interaction.editReply({ embeds: [createEmbed("❌ Not Found", `No records found for: \`${target}\``, SETTINGS.COLOR_ERROR)] });

    const { data: rLink } = await supabase.from("roblox_links").select("*").eq("discord_id", data.discord_id).maybeSingle();
    
    // FETCH ROBLOX INFO
    let robloxField = "⚫ `Unlinked`";
    let avatarUrl = null;
    
    if (rLink) {
        try {
            const rRes = await fetch(`https://users.roblox.com/v1/users/${rLink.roblox_id}`);
            const rInfo = await rRes.json();
            const created = new Date(rInfo.created).toLocaleDateString();
            
            robloxField = `**Display:** ${rInfo.displayName}\n` +
                          `**Username:** [${rLink.roblox_username}](https://www.roblox.com/users/${rLink.roblox_id}/profile)\n` +
                          `**ID:** \`${rLink.roblox_id}\`\n` +
                          `**Created:** ${created}`;
            
            avatarUrl = await getRobloxAvatar(rLink.roblox_id);
        } catch(e) {
            robloxField = `**User:** ${rLink.roblox_username} (API Error)`;
        }
    }

    // STATUS
    const isExpired = data.expires_at && new Date(data.expires_at) < new Date();
    const status = data.is_banned ? "🚫 **BANNED**" : (isExpired ? "🔴 **EXPIRED**" : "🟢 **ACTIVE**");
    const color = data.is_banned ? SETTINGS.COLOR_ERROR : (status.includes("ACTIVE") ? SETTINGS.COLOR_SUCCESS : SETTINGS.COLOR_WARN);

    // FETCH DISCORD USER
    let discordUser = null;
    try { if (data.discord_id) discordUser = await interaction.client.users.fetch(data.discord_id); } catch(e){}

    const embed = createEmbed("🔍 User Information", "", color, discordUser);
    
    // Set Thumbnail (Priority: Roblox > Discord > None)
    if (avatarUrl) embed.setThumbnail(avatarUrl);
    else if (discordUser) embed.setThumbnail(discordUser.displayAvatarURL());

    embed.addFields(
        { name: "👤 Discord Identity", value: data.discord_id ? `<@${data.discord_id}>\nID: \`${data.discord_id}\`` : "`Unlinked`", inline: true },
        { name: "🎮 Roblox Identity", value: robloxField, inline: true },
        { name: "\u200b", value: "\u200b", inline: false }, // Spacer
        { name: "🔑 License Key", value: `\`${data.code}\``, inline: true },
        { name: "📡 Account Status", value: status, inline: true },
        { name: "📝 Admin Notes", value: data.admin_note ? `\`${data.admin_note}\`` : "*No notes*", inline: true },
        { name: "🖥️ Hardware ID (HWID)", value: `\`${data.hwid}\``, inline: false }, 
        { name: "⏳ Expiration Date", value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:F> (<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:R>)` : "`Lifetime / Never`", inline: false }
    );

    return interaction.editReply({ embeds: [embed] });
}

// =====================================================================
// ⚙️ SECTION 3: RULES & CONFIGURATION
// =====================================================================

async function handleRules(interaction) {
    const sub = interaction.options.getSubcommand();
    
    if (sub === "list") {
        await interaction.deferReply(); // Added Defer
        const { data } = await supabase.from("role_rules").select("*");
        const list = data && data.length > 0 
            ? data.map((r, i) => `**${i+1}.** <@&${r.role_id}> ➜ **${r.duration}**`).join("\n") 
            : "No custom rules set.";
        return interaction.editReply({ embeds: [createEmbed("📜 Verification Rules", list, SETTINGS.COLOR_INFO)] });
    }

    if (sub === "add" || sub === "set") {
        await interaction.deferReply(); // Added Defer
        const role = interaction.options.getRole("role");
        const dur = interaction.options.getString("duration");
        await supabase.from("role_rules").upsert({ role_id: role.id, role_name: role.name, duration: dur }, { onConflict: 'role_id' });
        return interaction.editReply({ embeds: [createEmbed("✅ Rule Configured", `**Role:** ${role}\n**Duration:** \`${dur}\``, SETTINGS.COLOR_SUCCESS)] });
    }

    if (sub === "remove") {
        await interaction.deferReply(); // Added Defer
        const role = interaction.options.getRole("role");
        await supabase.from("role_rules").delete().eq("role_id", role.id);
        return interaction.editReply({ embeds: [createEmbed("🗑️ Rule Removed", `Removed configuration for ${role}.`, SETTINGS.COLOR_WARN)] });
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

async function processVerification(user, codeInput, guild, replyCallback, originalInteraction = null) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 **System Maintenance Mode**", ephemeral: true });

    const code = codeInput.replace(/verify/gi, "").trim();

    // 1. Validate Code
    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).maybeSingle();
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "This key does not exist or has been deleted.", SETTINGS.COLOR_ERROR)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "This key is blacklisted. Access Denied.", SETTINGS.COLOR_ERROR)] });

    // 2. Fetch User Link
    let { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();

    // 2.1 Auto-Detect Logic (From Script Execution)
    if (userData.executed_roblox_id && !link) {
        const rID = userData.executed_roblox_id;
        const rName = userData.executed_roblox_username || "Unknown";
        const avatarUrl = await getRobloxAvatar(rID);

        const embed = createEmbed("👋 Welcome!", `The script detected you are playing as:\n\n**${rName}**\nID: \`${rID}\`\n\nIs this your account? Click **Yes** to link and verify instantly.`, SETTINGS.COLOR_INFO);
        if (avatarUrl) embed.setThumbnail(avatarUrl);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`link_confirm_${rID}_${rName}_${code}`).setLabel("✅ Yes, This is me").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`link_start_${code}`).setLabel("✏️ No, Enter Manually").setStyle(ButtonStyle.Secondary)
        );
        return replyCallback({ embeds: [embed], components: [row] });
    }

    if (!link) {
        const embed = createEmbed("⚠️ Verification Required", "You must link your Roblox account to verify.\nClick below to start.", SETTINGS.COLOR_WARN);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`link_start_${code}`).setLabel("🔗 Link Roblox Account").setStyle(ButtonStyle.Primary)
        );
        return replyCallback({ embeds: [embed], components: [row] });
    }

    // 3. Executor Mismatch Log
    if (userData.executed_roblox_id && userData.executed_roblox_id !== link.roblox_id) {
        logToWebhook("⚠️ **Suspicious Verification**", 
            `**User:** <@${user.id}>\n` +
            `**Linked:** ${link.roblox_username} (\`${link.roblox_id}\`)\n` +
            `**Executor:** ${userData.executed_roblox_username} (\`${userData.executed_roblox_id}\`)\n` +
            `**Key:** \`${code}\`\n` + 
            `**Status:** Mismatch detected but allowed.`,
            SETTINGS.COLOR_WARN
        );
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

    // 5. Time Calculation
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

    // 6. Detailed Alt Logging
    const { data: activeKeys } = await supabase.from("verifications").select("*").eq("discord_id", user.id).eq("verified", true);
    
    if (activeKeys && activeKeys.length > 0) {
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

    // 8. Success Response
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

// 🌐 RE-EXPORTED UTILS
async function handleSetCode(interaction) {
    await interaction.deferReply(); // Added Defer
    const user = interaction.options.getUser("user");
    const code = interaction.options.getString("code");
    await supabase.from("verifications").upsert({ discord_id: user.id, code: code, verified: false, hwid: "RESET_ADMIN" }, { onConflict: 'discord_id' });
    return interaction.editReply({ embeds: [createEmbed("✅ Code Updated", `User: ${user}\nCode: \`${code}\``, SETTINGS.COLOR_SUCCESS)] });
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

async function handleActiveUsers(interaction, page = 1) {
    const LIMIT = 10, offset = (page - 1) * LIMIT;
    const replyMethod = interaction.message ? interaction.update.bind(interaction) : interaction.reply.bind(interaction);
    
    const { data: users, count } = await supabase.from("verifications").select("*", { count: 'exact' }).eq("verified", true).gt("expires_at", new Date().toISOString()).range(offset, offset + LIMIT - 1);
    
    if (!users || users.length === 0) return replyMethod({ embeds: [createEmbed("🔴 Active Users", "None", SETTINGS.COLOR_ERROR)], components:[] });

    const list = users.map((u, i) => `**${offset + i + 1}.** <@${u.discord_id}>\n   └ 🔑 \`${u.code}\` | ⏳ <t:${Math.floor(new Date(u.expires_at).getTime()/1000)}:R>`).join("\n\n");
    const totalPages = Math.ceil(count / LIMIT);
    
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`active_prev_${page-1}`).setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
        new ButtonBuilder().setCustomId(`active_next_${page+1}`).setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
    );
    await replyMethod({ embeds: [createEmbed(`Active Users (${count})`, list, SETTINGS.COLOR_SUCCESS)], components: [row] });
}

module.exports = { 
    handleVerifyCommand, handleLinkButton, handleLinkModal, handleLinkConfirm,
    handleSetNote, handleBanSystem, handleLookup, handleCheckAlts, handleRules,
    processVerification, handleKeyUpdate, handleSetCode, handleSetExpiry, handleActiveUsers,
    handleGetRobloxId: async(i) => i.reply({ content: "⚠️ Please use `/verify`. The system will automatically detect your user.", ephemeral: true }),
    handleLinkRoblox: async(i) => i.reply({ content: "⚠️ Please use `/verify` to link your account via the button.", ephemeral: true })
};
