const { EmbedBuilder } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- ⚙️ SETTINGS ---
const SETTINGS = {
    PORT: process.env.PORT || 10000,
    SUPER_OWNER_ID: "1169492860278669312", 
    GUILD_ID: "1257403231127076915", 
    VERIFY_CHANNEL_ID: "1444769950421225542", 
    DEFAULT_VERIFY_MS: 18 * 60 * 60 * 1000, 
    DEFAULT_PUNISH_MS: 5 * 60 * 1000, // 5 Mins Default
    ROBLOX_API_USER: "https://users.roblox.com/v1/usernames/users",
    MAINTENANCE: false,
    POLL_LOCK: false
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- HELPERS ---
function createEmbed(title, description, color = 0x0099FF) {
    const safeDesc = (description && description.length > 0) ? description : "Processing...";
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(safeDesc)
        .setColor(color)
        .setFooter({ text: "Developed By Subhu Jaat", iconURL: "https://i.imgur.com/AfFp7pu.png" })
        .setTimestamp();
}

function parseDuration(str) {
    if (!str) return 0;
    if (str.toLowerCase() === "lifetime") return "LIFETIME";
    const match = str.match(/^(\d+)([mhdw])$/);
    if (!match) return 0;
    const val = parseInt(match[1]);
    const unit = match[2];
    if (unit === 'm') return val * 60 * 1000;
    if (unit === 'h') return val * 60 * 60 * 1000;
    if (unit === 'd') return val * 24 * 60 * 60 * 1000;
    if (unit === 'w') return val * 7 * 24 * 60 * 60 * 1000;
    return 0;
}

function formatTime(ms) {
    if (ms === "LIFETIME") return "Lifetime ♾️";
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    let parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    return parts.length === 0 ? "Less than 1m" : parts.join(' ');
}

async function isAdmin(userId) {
    if (userId === SETTINGS.SUPER_OWNER_ID) return true;
    const { data } = await supabase.from("bot_admins").select("*").eq("discord_id", userId).maybeSingle();
    return !!data;
}

async function safeReply(interaction, options) {
    try {
        if (interaction.replied || interaction.deferred) await interaction.editReply(options);
        else await interaction.reply(options);
    } catch (e) {}
}

module.exports = { SETTINGS, supabase, createEmbed, parseDuration, formatTime, isAdmin, safeReply };
