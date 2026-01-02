const { EmbedBuilder, WebhookClient } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const SETTINGS = {
    PORT: process.env.PORT || 8000,
    SUPER_OWNER_ID: "1169492860278669312", 
    GUILD_ID: "1257403231127076915", 
    VERIFY_CHANNEL_ID: "1444769950421225542", 
    LOG_WEBHOOK_URL: "https://discord.com/api/webhooks/1456482277180833914/IMGgjiLSqkIlBizpuaHmuZI2Qd7IVHXFZvACm_MkqaI2xWkJFyPfsIqhTyr77ZI9CcsQ",
    
    DEFAULT_VERIFY_MS: 18 * 60 * 60 * 1000, 
    DEFAULT_PUNISH_MS: 1 * 60 * 60 * 1000,
    ROBLOX_API: "https://users.roblox.com/v1/usernames/users",
    
    FOOTER_ICON: "https://i.imgur.com/AfFp7pu.png",
    FOOTER_TEXT: "Squid Game X • Developed By Subhu Jaat",
    
    // Colors
    COLOR_SUCCESS: 0x00FF00,
    COLOR_ERROR: 0xFF0000,
    COLOR_INFO: 0x0099FF,
    COLOR_WARN: 0xFFA500,
    
    MAINTENANCE: false
};

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const webhook = new WebhookClient({ url: SETTINGS.LOG_WEBHOOK_URL });

function createEmbed(title, description, color = SETTINGS.COLOR_INFO, user = null) {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description || "Processing...")
        .setColor(color)
        .setFooter({ text: SETTINGS.FOOTER_TEXT, iconURL: SETTINGS.FOOTER_ICON })
        .setTimestamp();
    if (user) embed.setThumbnail(user.displayAvatarURL({ dynamic: true }));
    return embed;
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
    return 0;
}

function formatTime(ms) {
    if (ms === "LIFETIME") return "Lifetime ♾️";
    if (typeof ms !== 'number' || ms < 0) return 'Expired';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${d}d ${h}h ${m}m`;
}

async function isAdmin(userId) {
    if (userId === SETTINGS.SUPER_OWNER_ID) return true;
    const { data } = await supabase.from("bot_admins").select("*").eq("discord_id", userId).maybeSingle();
    return !!data;
}

async function logToWebhook(title, desc, color) {
    try { await webhook.send({ embeds: [new EmbedBuilder().setTitle(title).setDescription(desc).setColor(color).setTimestamp()] }); } catch(e){}
}

module.exports = { SETTINGS, supabase, createEmbed, parseDuration, formatTime, isAdmin, logToWebhook };
