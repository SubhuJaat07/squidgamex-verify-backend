/**********************************************************************
 * 🔐 VERIFICATION & USER MANAGEMENT
 * Handles all logic related to user auth, rules, and admin oversight.
 **********************************************************************/

const { SETTINGS, supabase, EmbedFactory, TimeUtils, Logger } = require("./config");
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// ==========================================
// 🔥 1. ROBLOX INTEGRATION
// ==========================================
async function handleGetRobloxId(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const username = interaction.options.getString("username");

    try {
        const response = await fetch(SETTINGS.ROBLOX_API_USER, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ usernames: [username], excludeBannedUsers: true })
        });
        
        const json = await response.json();
        
        if (json.data && json.data.length > 0) {
            const rUser = json.data[0];
            const embed = EmbedFactory.success("✅ Roblox Account Found", 
                `**Username:** ${rUser.name}\n**ID:** \`${rUser.id}\`\n\n👇 **Copy & Run Command:**\n\`/linkroblox roblock_id:${rUser.id}\``
            );
            return interaction.editReply({ embeds: [embed] });
        } else {
            return interaction.editReply({ embeds: [EmbedFactory.error("❌ Not Found", `User **${username}** does not exist on Roblox.`)] });
        }
    } catch (e) {
        console.error(e);
        return interaction.editReply({ content: "⚠️ Roblox API Error. Try again later." });
    }
}

async function handleLinkRoblox(interaction) {
    const rId = interaction.options.getString("roblox_id");
    
    // Validation
    if (!/^\d+$/.test(rId)) {
        return interaction.reply({ embeds: [EmbedFactory.error("❌ Invalid Format", "Roblox ID must contain only numbers.")], ephemeral: true });
    }

    try {
        await supabase.from("roblox_links").upsert({ discord_id: interaction.user.id, roblox_id: rId });
        return interaction.reply({ embeds: [EmbedFactory.success("✅ Linked Successfully", `Your Discord is now linked to Roblox ID: \`${rId}\`.\nYou can now verify.`)] });
    } catch (e) {
        return interaction.reply({ content: "❌ Database Error", ephemeral: true });
    }
}

// ==========================================
// 🔥 2. CUSTOM CODE & LOOKUP
// ==========================================
async function handleSetCode(interaction) {
    const user = interaction.options.getUser("user");
    const code = interaction.options.getString("code");

    try {
        await supabase.from("verifications").upsert({ 
            discord_id: user.id, 
            code: code, 
            verified: false 
        }, { onConflict: 'discord_id' });

        return interaction.reply({ embeds: [EmbedFactory.success("✅ Code Updated", `**User:** ${user}\n**New Code:** \`${code}\``)] });
    } catch (e) {
        return interaction.reply({ content: "❌ Failed to set code.", ephemeral: true });
    }
}

async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");

    const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();

    if (!data) return interaction.editReply({ embeds: [EmbedFactory.error("❌ Not Found", `No data found for \`${target}\`.`)] });

    // Fetch Discord Info
    let discordInfo = "`Unlinked`";
    if (data.discord_id) {
        try {
            const u = await interaction.client.users.fetch(data.discord_id);
            discordInfo = `${u} (\`${u.id}\`)`;
        } catch {}
    }

    const expiry = data.expires_at ? new Date(data.expires_at) : null;
    const isActive = expiry && expiry > new Date();
    const status = data.is_banned ? "🔴 **BANNED**" : (isActive ? "🟢 **ACTIVE**" : "🟡 **EXPIRED**");

    const embed = EmbedFactory.create("🔍 User Lookup", "", data.is_banned ? SETTINGS.COLORS.ERROR : SETTINGS.COLORS.INFO)
        .addFields(
            { name: "👤 User", value: discordInfo, inline: false },
            { name: "🔑 License Key", value: `\`${data.code}\``, inline: true },
            { name: "📡 Status", value: status, inline: true },
            { name: "📝 Note", value: data.note ? `\`${data.note}\`` : "`None`", inline: true },
            { name: "🖥️ Hardware ID", value: `\`${data.hwid || "None"}\``, inline: false },
            { name: "⏳ Expires In", value: expiry ? `<t:${Math.floor(expiry.getTime()/1000)}:R>` : "`Never`", inline: true }
        );

    return interaction.editReply({ embeds: [embed] });
}

// ==========================================
// 🔥 3. ACTIVE USERS & RULES
// ==========================================
async function handleActiveUsers(interaction, page = 1) {
    const LIMIT = 10;
    const offset = (page - 1) * LIMIT;

    try {
        const { data, count } = await supabase.from("verifications")
            .select("*", { count: 'exact' })
            .eq("verified", true)
            .gt("expires_at", new Date().toISOString())
            .range(offset, offset + LIMIT - 1);

        if (!data || data.length === 0) {
            return interaction.reply({ embeds: [EmbedFactory.error("🔴 No Active Users", "No one is currently verified.")], ephemeral: true });
        }

        const list = data.map((u, i) => {
            const timeLeft = TimeUtils.formatMs(new Date(u.expires_at).getTime() - Date.now());
            const userRef = u.discord_id ? `<@${u.discord_id}>` : `\`Unknown\``;
            return `**${offset + i + 1}.** ${userRef}\n   └ 🔑 \`${u.code}\` • ⏳ ${timeLeft}`;
        }).join("\n\n");

        const embed = EmbedFactory.create(`🟢 Active Sessions (Page ${page})`, list, SETTINGS.COLORS.SUCCESS)
            .setFooter({ text: `Total Online: ${count} Users • Page ${page}` });

        // Add Pagination Buttons (Logic in index.js)
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`active_prev_${page}`).setLabel("◀ Prev").setStyle(ButtonStyle.Secondary).setDisabled(page===1),
            new ButtonBuilder().setCustomId(`active_next_${page}`).setLabel("Next ▶").setStyle(ButtonStyle.Secondary).setDisabled(offset + LIMIT >= count)
        );

        if (interaction.message) await interaction.update({ embeds: [embed], components: [row] });
        else await interaction.reply({ embeds: [embed], components: [row] });

    } catch (e) {
        console.error(e);
        return interaction.reply({ content: "❌ Error fetching list.", ephemeral: true });
    }
}

// ==========================================
// 🔥 4. MAIN VERIFICATION PROCESS
// ==========================================
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE_MODE) return replyCallback({ content: "🚧 System is in Maintenance Mode.", ephemeral: true });

    // 1. Check Roblox Link
    const { data: link } = await supabase.from("roblox_links").select("*").eq("discord_id", user.id).maybeSingle();
    if (!link) {
        return replyCallback({ 
            embeds: [EmbedFactory.create("⚠️ Action Required", "You must link your Roblox account first.\n\n👉 Use `/getid` then `/linkroblox`.", SETTINGS.COLORS.WARNING)] 
        });
    }

    // 2. Poll Punishment Check
    let isPunished = false;
    let pollUrl = null;
    if (SETTINGS.POLL_LOCK_SYSTEM) {
        const { data: activePoll } = await supabase.from("polls").select("*").eq("is_active", true).limit(1).maybeSingle();
        if (activePoll) {
            const { data: vote } = await supabase.from("poll_votes").select("*").eq("poll_id", activePoll.id).eq("user_id", user.id).maybeSingle();
            if (!vote) {
                isPunished = true;
                pollUrl = `https://discord.com/channels/${guild.id}/${activePoll.channel_id}`;
            }
        }
    }

    // 3. Validate Code
    const { data: userData } = await supabase.from("verifications").select("*").eq("code", code).limit(1).maybeSingle();
    if (!userData) return replyCallback({ embeds: [EmbedFactory.error("❌ Invalid Code", "Please get a valid key from the game.")] });
    if (userData.is_banned) return replyCallback({ embeds: [EmbedFactory.error("🚫 BANNED", "Your access has been permanently revoked.")] });

    // 4. Calculate Time
    let duration = SETTINGS.DEFAULT_VERIFY_MS;
    let ruleText = "Default";

    if (isPunished) {
        duration = SETTINGS.DEFAULT_PUNISH_MS;
        ruleText = "⚠️ Poll Penalty (No Vote)";
    } else {
        try {
            const member = await guild.members.fetch(user.id);
            const { data: rules } = await supabase.from("role_rules").select("*");
            if (rules) {
                rules.forEach(r => {
                    if (member.roles.cache.has(r.role_id)) {
                        const d = TimeUtils.parseDuration(r.duration);
                        if (d === "LIFETIME" || d > duration) {
                            duration = d;
                            ruleText = `⭐ ${r.role_name} Boost`;
                        }
                    }
                });
            }
        } catch (e) { console.error("Role Check Error:", e); }
    }

    // 5. Update Database
    const expiryDate = duration === "LIFETIME" ? new Date(Date.now() + 3153600000000) : new Date(Date.now() + duration);
    await supabase.from("verifications").update({ verified: true, expires_at: expiryDate.toISOString(), discord_id: user.id }).eq("id", userData.id);

    // 6. Security Log
    const { data: keys } = await supabase.from("verifications").select("*").eq("discord_id", user.id).eq("verified", true);
    if (keys.length > 1) Logger.log("Suspicious Activity", `<@${user.id}> verified with multiple keys!`);

    // 7. Success Embed
    const embed = EmbedFactory.create(
        isPunished ? "⚠️ Verified (Restricted)" : "✅ Verification Successful",
        isPunished ? `**You have been punished for not voting!**\n[Click here to Vote](${pollUrl})` : "**Access Granted Successfully.**",
        isPunished ? SETTINGS.COLORS.WARNING : SETTINGS.COLORS.SUCCESS,
        user
    ).addFields(
        { name: "🔑 License Key", value: `\`${code}\``, inline: true },
        { name: "⏳ Time Added", value: `\`${TimeUtils.formatMs(duration)}\``, inline: true },
        { name: "📜 Logic", value: `\`${ruleText}\``, inline: true },
        { name: "📅 Expires At", value: `<t:${Math.floor(expiryDate.getTime()/1000)}:F>`, inline: false }
    );

    return replyCallback({ embeds: [embed] });
}

module.exports = { processVerification, handleGetRobloxId, handleLinkRoblox, handleActiveUsers, handleSetCode, handleLookup };
