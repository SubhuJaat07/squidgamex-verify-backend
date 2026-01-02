const { SETTINGS, supabase, createEmbed, formatTime, parseDuration } = require("./config");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// 🔥 1. ROBLOX UTILS
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
            return interaction.reply({ embeds: [createEmbed("✅ Roblox ID Found", `**Username:** ${rUser.name}\n**ID:** \`${rUser.id}\`\n\n👇 **Link Command:**\n\`/linkroblox roblox_id:${rUser.id}\``, 0x00FF00)] });
        }
        return interaction.reply({ content: "❌ User not found.", ephemeral: true });
    } catch (e) { return interaction.reply({ content: "❌ API Error", ephemeral: true }); }
}

async function handleLinkRoblox(interaction) {
    const rId = interaction.options.getString("roblox_id");
    if (!/^\d+$/.test(rId)) return interaction.reply({ content: "❌ Invalid ID (Numbers only).", ephemeral: true });
    await supabase.from("roblox_links").upsert({ discord_id: interaction.user.id, roblox_id: rId });
    return interaction.reply({ embeds: [createEmbed("✅ Account Linked", `Your Discord is now linked to Roblox ID: \`${rId}\`.\nYou can now use \`/verify\`.`, 0x00FF00)] });
}

// 🔥 2. ACTIVE USERS (PRO LIST)
async function handleActiveUsers(interaction) {
    await interaction.deferReply();
    const { data: users } = await supabase.from("verifications").select("*").eq("verified", true).gt("expires_at", new Date().toISOString());
    
    if (!users || users.length === 0) return interaction.editReply({ embeds: [createEmbed("🔴 Active Users", "No active key sessions found.", 0xFF0000)] });

    // Format List
    const list = users.map((u, i) => {
        const expiry = new Date(u.expires_at);
        return `\`${i+1}.\` <@${u.discord_id}> • ⏳ <t:${Math.floor(expiry.getTime()/1000)}:R>`;
    }).join("\n").substring(0, 4000);

    return interaction.editReply({ embeds: [createEmbed(`🟢 Active Sessions (${users.length})`, list, 0x00FF00)] });
}

// 🔥 3. LOOKUP (DETAILED)
async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    
    if (!data) return interaction.editReply({ embeds: [createEmbed("❌ Not Found", `No record found for: \`${target}\``, 0xFF0000)] });

    const expiryTime = data.expires_at ? new Date(data.expires_at) : null;
    const isExpired = expiryTime && expiryTime < new Date();
    const status = data.is_banned ? "🚫 BANNED" : (isExpired ? "🔴 EXPIRED" : "🟢 ACTIVE");

    const embed = new EmbedBuilder()
        .setTitle("🔍 User Lookup Details")
        .setColor(data.is_banned ? 0xFF0000 : 0x00FFFF)
        .addFields(
            { name: "👤 Discord User", value: data.discord_id ? `<@${data.discord_id}>` : "`Unlinked`", inline: true },
            { name: "🔑 License Key", value: `\`${data.code}\``, inline: true },
            { name: "📡 Status", value: `**${status}**`, inline: true },
            { name: "🖥️ Hardware ID", value: `\`${data.hwid}\``, inline: false },
            { name: "📅 Expiry Date", value: expiryTime ? `<t:${Math.floor(expiryTime.getTime()/1000)}:F>` : "`N/A`", inline: true },
            { name: "⏳ Time Left", value: expiryTime ? `<t:${Math.floor(expiryTime.getTime()/1000)}:R>` : "`N/A`", inline: true }
        )
        .setThumbnail(SETTINGS.FOOTER_ICON)
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

// 🔥 4. RULE MANAGEMENT
async function handleRules(interaction) {
    const sub = interaction.options.getSubcommand();
    
    if (sub === "set") {
        if(!await isAdmin(interaction.user.id)) return interaction.reply({content:"❌ Admin", ephemeral:true});
        const role = interaction.options.getRole("role");
        const dur = interaction.options.getString("duration");
        await supabase.from("role_rules").upsert({ role_id: role.id, role_name: role.name, duration: dur }, { onConflict: 'role_id' });
        return interaction.reply(`✅ **Rule Updated:**\nRole: ${role}\nTime: \`${dur}\``);
    }
    
    if (sub === "remove") {
        if(!await isAdmin(interaction.user.id)) return interaction.reply({content:"❌ Admin", ephemeral:true});
        const role = interaction.options.getRole("role");
        await supabase.from("role_rules").delete().eq("role_id", role.id);
        return interaction.reply(`🗑️ Rule removed for **${role.name}**.`);
    }

    if (sub === "list") {
        const { data } = await supabase.from("role_rules").select("*");
        const list = data.map(r => `• <@&${r.role_id}> ➜ **${r.duration}**`).join("\n") || "No rules configured.";
        return interaction.reply({ embeds: [createEmbed("📜 Verification Rules", list, 0x0099FF)] });
    }
}

// 🔥 5. VERIFICATION (THE BIG ONE)
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 Maintenance Mode", ephemeral: true });

    // Link Check
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    if (!link) return replyCallback({ embeds: [createEmbed("⚠️ Link Required", "You are not linked to Roblox.\nUse `/getid` then `/linkroblox`.", 0xFFA500)] });

    // Poll Punishment Check
    let isPollPunished = false;
    let pollLink = null;
    if (SETTINGS.POLL_LOCK) {
        const { data: activePoll } = await supabase.from("polls").select("*").eq("is_active", true).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) {
                isPollPunished = true;
                pollLink = `https://discord.com/channels/${SETTINGS.GUILD_ID}/${activePoll.channel_id}/${activePoll.message_id}`; // Need to store msg id
            }
        }
    }

    // Code Validation
    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [createEmbed("❌ Invalid Code", "Please check your code in the game.", 0xFF0000)] });
    if (userData.is_banned) return replyCallback({ embeds: [createEmbed("🚫 BANNED", "This HWID/User is banned from the system.", 0x000000)] });

    // 🧠 LOGIC: Calculate Time (Base + Boosts)
    let finalDuration = SETTINGS.DEFAULT_VERIFY_MS;
    let logicText = ["Default (18h)"];
    let appliedRoles = [];

    if (isPollPunished) {
        finalDuration = SETTINGS.DEFAULT_PUNISH_MS;
        logicText = ["⚠️ **POLL PENALTY APPLIED**"];
    } else {
        try {
            const member = await guild.members.fetch(user.id);
            const { data: rules } = await supabase.from("role_rules").select("*");
            
            if (rules && rules.length > 0) {
                // 1. Check Punishments (Override everything)
                const punishRule = rules.find(r => r.role_name.toLowerCase().includes("punish") && member.roles.cache.has(r.role_id));
                if (punishRule) {
                    finalDuration = parseDuration(punishRule.duration);
                    logicText = [`🚫 **Punished:** ${punishRule.role_name}`];
                } else {
                    // 2. Check Boosts (Highest Win)
                    let maxDuration = SETTINGS.DEFAULT_VERIFY_MS;
                    let bestRole = "Default";
                    
                    rules.forEach(r => {
                        if (member.roles.cache.has(r.role_id)) {
                            const d = parseDuration(r.duration);
                            if (d === "LIFETIME") {
                                maxDuration = "LIFETIME";
                                bestRole = `👑 ${r.role_name}`;
                            } else if (maxDuration !== "LIFETIME" && d > maxDuration) {
                                maxDuration = d;
                                bestRole = `⭐ ${r.role_name}`;
                            }
                            appliedRoles.push(r.role_name);
                        }
                    });
                    
                    if (appliedRoles.length > 0) {
                        finalDuration = maxDuration;
                        logicText = [`✅ **Active Rule:** ${bestRole}`];
                        if (appliedRoles.length > 1) logicText.push(`➕ **Roles Found:** ${appliedRoles.join(", ")}`);
                    }
                }
            }
        } catch (e) { console.error("Role Logic Error:", e); }
    }

    // Save
    const expiryTime = finalDuration === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + finalDuration).toISOString();
    await supabase.from("verifications").update({ verified: true, expires_at: expiryTime, discord_id: user.id }).eq("id", userData.id);

    // 🎨 FINAL PROFESSIONAL EMBED
    const embed = new EmbedBuilder()
        .setTitle(isPollPunished ? "⚠️ Verification Restricted" : "✅ Verification Successful")
        .setColor(isPollPunished ? 0xFFA500 : 0x00FF00)
        .setDescription(isPollPunished ? `**You have been punished for not voting!**\nVote now to get full time next access.` : `**Welcome back, ${user.username}!**`)
        .addFields(
            { name: "👤 User Verified", value: `<@${user.id}>`, inline: true },
            { name: "🎮 Linked Roblox", value: `\`${link.roblox_id}\``, inline: true },
            { name: "🔑 License Key", value: `\`${code}\``, inline: true },
            { name: "⏳ Time Granted", value: `\`${formatTime(finalDuration)}\``, inline: true },
            { name: "📅 Expires At", value: finalDuration === "LIFETIME" ? "**Never (Lifetime)**" : `<t:${Math.floor(new Date(expiryTime).getTime()/1000)}:F>`, inline: true },
            { name: "📜 System Logic", value: logicText.join("\n"), inline: false }
        )
        .setImage(SETTINGS.BANNER_URL)
        .setThumbnail(user.displayAvatarURL())
        .setFooter({ text: "Squid Game X • Secure System", iconURL: SETTINGS.FOOTER_ICON })
        .setTimestamp();

    return replyCallback({ embeds: [embed] });
}

module.exports = { processVerification, handleGetRobloxId, handleLinkRoblox, handleActiveUsers, handleRules, handleLookup };
