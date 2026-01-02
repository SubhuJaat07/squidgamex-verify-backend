const { EmbedBuilder } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- ⚙️ ULTIMATE SETTINGS ---
const SETTINGS = {
    PORT: process.env.PORT || 8000,
    SUPER_OWNER_ID: "1169492860278669312", 
    GUILD_ID: "1257403231127076915", 
    VERIFY_CHANNEL_ID: "1444769950421225542", 
    
    // Default Times
    DEFAULT_VERIFY_MS: 18 * 60 * 60 * 1000, // 18 Hours
    DEFAULT_PUNISH_MS: 1 * 60 * 60 * 1000,  // 1 Hour (Poll Punishment)
    
    // API
    ROBLOX_API: "https://users.roblox.com/v1/usernames/users",
    
    // Graphics
    BANNER_URL: "https://share.creavite.co/67761d3e2079a40733d9396e.gif", // Replace with your GIF/Img
    FOOTER_ICON: "https://i.imgur.com/AfFp7pu.png",
    FOOTER_TEXT: "Squid Game X • Developed By Subhu Jaat",
    
    MAINTENANCE: false
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// --- 🎨 PROFESSIONAL EMBED BUILDER ---
function createEmbed(title, description, color = 0x0099FF) {
    const safeDesc = (description && description.length > 0) ? description : "Processing data...";
    return new EmbedBuilder()
        .setTitle(title)
        .setDescription(safeDesc)
        .setColor(color)
        .setThumbnail(SETTINGS.FOOTER_ICON)
        .setFooter({ text: SETTINGS.FOOTER_TEXT, iconURL: SETTINGS.FOOTER_ICON })
        .setTimestamp();
}

// --- ⏳ TIME PARSERS ---
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
    if (typeof ms !== 'number' || ms < 0) return 'Expired';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    
    let parts = [];
    if(d > 0) parts.push(`${d}d`);
    if(h > 0) parts.push(`${h}h`);
    if(m > 0) parts.push(`${m}m`);
    return parts.join(' ') || "0m";
}

async function isAdmin(userId) {
    if (userId === SETTINGS.SUPER_OWNER_ID) return true;
    const { data } = await supabase.from("bot_admins").select("*").eq("discord_id", userId).maybeSingle();
    return !!data;
}

module.exports = { SETTINGS, supabase, createEmbed, parseDuration, formatTime, isAdmin };
