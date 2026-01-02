const { SETTINGS, supabase, createEmbed, formatTime, parseDuration, logToWebhook } = require("./config");
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// =====================================================================
// 🔥 1. ROBLOX LINKING SYSTEM
// =====================================================================
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
            return interaction.reply({ embeds: [createEmbed("✅ Roblox ID Found", `**Username:** ${rUser.name}\n**ID:** \`${rUser.id}\`\n\n👇 **Copy & Run:**\n\`/linkroblox roblox_id:${rUser.id}\``, SETTINGS.COLOR_SUCCESS)] });
        }
        return interaction.reply({ content: "❌ User not found on Roblox.", ephemeral: true });
    } catch (e) { return interaction.reply({ content: "❌ Roblox API Error", ephemeral: true }); }
}

async function handleLinkRoblox(interaction) {
    const rId = interaction.options.getString("roblox_id");
    if (!/^\d+$/.test(rId)) return interaction.reply({ content: "❌ Invalid ID (Numbers Only).", ephemeral: true });
    await supabase.from("roblox_links").upsert({ discord_id: interaction.user.id, roblox_id: rId });
    return interaction.reply({ embeds: [createEmbed("✅ Account Linked", `**Success!** Your Discord is linked to Roblox ID: \`${rId}\`.\nNow you can use \`/verify\` or `verify <code>`.`, SETTINGS.COLOR_SUCCESS)] });
}

// =====================================================================
// 🔥 2. CUSTOM CODE & BAN SYSTEM
// =====================================================================
async function handleSetCode(interaction) {
    const user = interaction.options.getUser("user");
    const code = interaction.options.getString("code");
    // Upsert ensures we create or update
    await supabase.from("verifications").upsert({ discord_id: user.id, code: code, verified: false, hwid: "RESET_BY_ADMIN" }, { onConflict: 'discord_id' });
    return interaction.reply({ embeds: [createEmbed("✅ Custom Code Set", `**User:** ${user}\n**New Code:** \`${code}\``, SETTINGS.COLOR_SUCCESS)] });
}

async function handleBanSystem(interaction) {
    const sub = interaction.options.getSubcommand();
    const target = interaction.options.getString("target");

    if (sub === "ban") {
        const { error } = await supabase.from("verifications").update({ is_banned: true, verified: false }).or(`code.eq.${target},hwid.eq.${target}`);
        if(error) return interaction.reply("❌ Error banning user.");
        return interaction.reply({ embeds: [createEmbed("🚫 User Banned", `Target \`${target}\` has been banned from the system.`, SETTINGS.COLOR_ERROR)] });
    }
    if (sub === "unban") {
        await supabase.from("verifications").update({ is_banned: false }).or(`code.eq.${target},hwid.eq.${target}`);
        return interaction.reply({ embeds: [createEmbed("✅ User Unbanned", `Target \`${target}\` access restored.`, SETTINGS.COLOR_SUCCESS)] });
    }
    if (sub === "list") {
        const { data } = await supabase.from("verifications").select("*").eq("is_banned", true);
        const list = data.map(u => `• Code: \`${u.code}\` (HWID: ...${u.hwid.slice(-4)})`).join("\n") || "No banned users.";
        return interaction.reply({ embeds: [createEmbed("📜 Ban List", list, SETTINGS.COLOR_WARN)] });
    }
}

// =====================================================================
// 🔥 3. ACTIVE USERS & LOOKUP (Visuals+)
// =====================================================================
async function handleActiveUsers(interaction, page = 1) {
    const LIMIT = 10;
    const offset = (page - 1) * LIMIT;
    
    // Check reply method
    const replyMethod = interaction.message ? interaction.update.bind(interaction) : interaction.reply.bind(interaction);

    const { data: users, count } = await supabase.from("verifications").select("*", { count: 'exact' }).eq("verified", true).gt("expires_at", new Date().toISOString()).range(offset, offset + LIMIT - 1);

    if (!users || users.length === 0) return replyMethod({ embeds: [createEmbed("🔴 Active Users", "No active sessions found.", SETTINGS.COLOR_ERROR)], components: [] });

    // Check for Alts in current batch
    const { data: allActive } = await supabase.from("verifications").select("discord_id").eq("verified", true);
    const altMap = {};
    allActive.forEach(u => { if(u.discord_id) altMap[u.discord_id] = (altMap[u.discord_id] || 0) + 1; });

    const description = users.map((u, i) => {
        const expiry = new Date(u.expires_at);
        const left = expiry.getTime() - Date.now();
        const userTag = u.discord_id ? `<@${u.discord_id}>` : (u.note ? `📝 *${u.note}*` : "`Unknown`");
        const badge = (u.discord_id && altMap[u.discord_id] > 1) ? "⚠️ **ALT**" : "✅";
        
        return `**${offset + i + 1}.** ${userTag} ${badge}\n   └ 🔑 \`${u.code}\` | ⏳ ${formatTime(left)}`;
    }).join("\n\n");

    const totalPages = Math.ceil(count / LIMIT);
    const embed = createEmbed(`🟢 Active Users (Page ${page}/${totalPages})`, description, SETTINGS.COLOR_SUCCESS).setFooter({ text: `Total Online: ${count}` });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`active_prev_${page-1}`).setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page === 1),
        new ButtonBuilder().setCustomId(`active_next_${page+1}`).setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages)
    );

    await replyMethod({ embeds: [embed], components: [row] });
}

async function handleCheckAlts(interaction) {
    await interaction.deferReply();
    const { data: all } = await supabase.from("verifications").select("*").eq("verified", true).gt("expires_at", new Date().toISOString());
    
    if (!all) return interaction.editReply("No Data.");
    
    const map = new Map();
    all.forEach(u => { if(u.discord_id) { if(!map.has(u.discord_id)) map.set(u.discord_id, []); map.get(u.discord_id).push(u); }});
    
    const alts = Array.from(map.entries()).filter(([_, arr]) => arr.length > 1);
    
    if (alts.length === 0) return interaction.editReply({ embeds: [createEmbed("✅ Clean", "No users with multiple keys found.", SETTINGS.COLOR_SUCCESS)] });

    const desc = alts.map(([id, keys]) => `<@${id}> has **${keys.length}** keys:\n` + keys.map(k => `└ \`${k.code}\``).join("\n")).join("\n\n");
    return interaction.editReply({ embeds: [createEmbed(`⚠️ Found ${alts.length} Alt Users`, desc, SETTINGS.COLOR_WARN)] });
}

async function handleLookup(interaction) {
    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const { data } = await supabase.from("verifications").select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    
    if (!data) return interaction.editReply({ embeds: [createEmbed("❌ Not Found", `No record for \`${target}\``, SETTINGS.COLOR_ERROR)] });

    // Fetch User for PFP
    let userObj = null;
    if (data.discord_id) { try { userObj = await interaction.client.users.fetch(data.discord_id); } catch(e){} }

    const isExpired = new Date(data.expires_at) < new Date();
    const status = data.is_banned ? "🚫 **BANNED**" : (isExpired ? "🔴 **EXPIRED**" : "🟢 **ACTIVE**");

    const embed = createEmbed("🔍 User Lookup", "", data.is_banned ? SETTINGS.COLOR_ERROR : SETTINGS.COLOR_INFO, userObj)
        .addFields(
            { name: "👤 User", value: data.discord_id ? `<@${data.discord_id}>` : "`Unlinked`", inline: true },
            { name: "🔑 Code", value: `\`${data.code}\``, inline: true },
            { name: "📝 Note", value: data.note ? `\`${data.note}\`` : "`None`", inline: true },
            { name: "📡 Status", value: status, inline: true },
            { name: "🖥️ HWID", value: `\`${data.hwid}\``, inline: false },
            { name: "📅 Expires", value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:F>` : "`Never`", inline: true },
            { name: "⏳ Remaining", value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:R>` : "`N/A`", inline: true }
        );

    return interaction.editReply({ embeds: [embed] });
}

// =====================================================================
// 🔥 4. ADMIN: SET EXPIRY (The Missing Command)
// =====================================================================
async function handleSetExpiry(interaction) {
    // Permission check handled in index usually, but safety here
    if (interaction.user.id !== SETTINGS.SUPER_OWNER_ID && !await require("./config").isAdmin(interaction.user.id)) {
        return interaction.reply({ content: "❌ Admin Only", ephemeral: true });
    }

    await interaction.deferReply();
    const target = interaction.options.getString("target");
    const durationStr = interaction.options.getString("duration");
    const note = interaction.options.getString("note") || null;

    const ms = parseDuration(durationStr);
    if (!ms && durationStr.toLowerCase() !== "lifetime") return interaction.editReply("❌ Invalid duration format (e.g. 1d, 12h, lifetime)");

    const newExpiry = (durationStr.toLowerCase() === "lifetime") 
        ? new Date(Date.now() + 3153600000000).toISOString() 
        : new Date(Date.now() + ms).toISOString();

    const { error } = await supabase.from("verifications")
        .update({ verified: true, expires_at: newExpiry, note: note })
        .or(`code.eq.${target},hwid.eq.${target}`);

    if (error) return interaction.editReply("❌ Database Error.");

    return interaction.editReply({ embeds: [createEmbed("✅ Expiry Updated", `**Target:** \`${target}\`\n**New Time:** ${durationStr}\n**Note:** ${note || "None"}`, SETTINGS.COLOR_SUCCESS)] });
}

// =====================================================================
// 🔥 5. RULES SYSTEM
// =====================================================================
async function handleRules(interaction) {
    const sub = interaction.options.getSubcommand();
    
    if (sub === "set") {
        const role = interaction.options.getRole("role");
        const dur = interaction.options.getString("duration");
        await supabase.from("role_rules").upsert({ role_id: role.id, role_name: role.name, duration: dur }, { onConflict: 'role_id' });
        return interaction.reply({ embeds: [createEmbed("✅ Rule Set", `**Role:** ${role}\n**Duration:** \`${dur}\``, SETTINGS.COLOR_SUCCESS)] });
    }
    
    if (sub === "remove") {
        const role = interaction.options.getRole("role");
        await supabase.from("role_rules").delete().eq("role_id", role.id);
        return interaction.reply({ embeds: [createEmbed("🗑️ Rule Removed", `Deleted rule for **${role.name}**`, SETTINGS.COLOR_WARN)] });
    }

    if (sub === "list") {
        const { data } = await supabase.from("role_rules").select("*");
        const list = data.map(r => `• <@&${r.role_id}> ➜ **${r.duration}**`).join("\n") || "No rules found.";
        return interaction.reply({ embeds: [createEmbed("📜 Verification Rules", list, SETTINGS.COLOR_INFO)] });
    }
}

// =====================================================================
// 🔥 6. CORE VERIFICATION PROCESS (TEXT & SLASH COMPATIBLE)
// =====================================================================
async function processVerification(user, code, guild, replyCallback) {
    if (SETTINGS.MAINTENANCE) return replyCallback({ content: "🚧 **System Maintenance**", ephemeral: true });

    // 1. Link Check
    const { data: link } = await supabase.from("roblox_links").select("*").eq

