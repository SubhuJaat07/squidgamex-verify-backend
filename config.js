/**********************************************************************
 * ⚙️ CONFIGURATION & UTILITIES
 * Holds all settings, database connection, and helper classes.
 **********************************************************************/

const { EmbedBuilder, WebhookClient, Colors } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- 🔧 SYSTEM SETTINGS ---
const SETTINGS = {
    // Server & API
    PORT: process.env.PORT || 8000,
    ROBLOX_API_USER: "https://users.roblox.com/v1/usernames/users",
    
    // IDs (Update these)
    SUPER_OWNER_ID: "1169492860278669312", 
    GUILD_ID: "1257403231127076915", 
    VERIFY_CHANNEL_ID: "1444769950421225542", 
    LOG_WEBHOOK_URL: "https://discord.com/api/webhooks/1456482277180833914/IMGgjiLSqkIlBizpuaHmuZI2Qd7IVHXFZvACm_MkqaI2xWkJFyPfsIqhTyr77ZI9CcsQ",

    // Timings (ms)
    DEFAULT_VERIFY_MS: 18 * 60 * 60 * 1000, // 18 Hours
    DEFAULT_PUNISH_MS: 1 * 60 * 60 * 1000,  // 1 Hour
    
    // Branding
    BRAND_NAME: "Squid Game X",
    BRAND_ICON: "https://i.imgur.com/AfFp7pu.png",
    BRAND_BANNER: "https://share.creavite.co/67761d3e2079a40733d9396e.gif",
    
    // System Toggles
    MAINTENANCE_MODE: false,
    POLL_LOCK_SYSTEM: false,

    // Colors Palette
    COLORS: {
        SUCCESS: 0x00FF00,  // Green
        ERROR: 0xFF0000,    // Red
        WARNING: 0xFFA500,  // Orange
        INFO: 0x0099FF,     // Blue
        DARK: 0x2b2d31,     // Discord Dark
        GOLD: 0xFFD700      // Gold
    }
};

// --- 🗄️ DATABASE CONNECTION ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const webhookClient = new WebhookClient({ url: SETTINGS.LOG_WEBHOOK_URL });

// --- 🎨 ADVANCED EMBED BUILDER ---
class EmbedFactory {
    static create(title, description, color = SETTINGS.COLORS.INFO, user = null) {
        const embed = new EmbedBuilder()
            .setTitle(title)
            .setDescription(description || "No content provided.")
            .setColor(color)
            .setFooter({ text: `${SETTINGS.BRAND_NAME} • Security System`, iconURL: SETTINGS.BRAND_ICON })
            .setTimestamp();

        if (user) embed.setThumbnail(user.displayAvatarURL({ dynamic: true, size: 512 }));
        return embed;
    }

    static success(title, description) {
        return this.create(title, description, SETTINGS.COLORS.SUCCESS);
    }

    static error(title, description) {
        return this.create(title, description, SETTINGS.COLORS.ERROR);
    }
}

// --- 📜 LOGGER SYSTEM ---
class Logger {
    static async log(title, message, color = SETTINGS.COLORS.WARNING) {
        try {
            console.log(`[LOG] ${title}: ${message}`);
            const embed = new EmbedBuilder()
                .setTitle(`📝 ${title}`)
                .setDescription(message)
                .setColor(color)
                .setTimestamp();
            await webhookClient.send({ embeds: [embed] });
        } catch (e) {
            console.error("Webhook Logging Failed:", e.message);
        }
    }
}

// --- ⏳ TIME UTILITIES ---
const TimeUtils = {
    parseDuration: (str) => {
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
    },

    formatMs: (ms) => {
        if (ms === "LIFETIME") return "♾️ **Lifetime**";
        if (typeof ms !== 'number' || ms <= 0) return "❌ **Expired**";
        const seconds = Math.floor(ms / 1000);
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        
        let parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (hours > 0) parts.push(`${hours}h`);
        if (minutes > 0) parts.push(`${minutes}m`);
        return parts.join(' ') || "0m";
    }
};

// --- 🛡️ PERMISSION CHECK ---
async function isAdmin(userId) {
    if (userId === SETTINGS.SUPER_OWNER_ID) return true;
    try {
        const { data } = await supabase.from("bot_admins").select("*").eq("discord_id", userId).maybeSingle();
        return !!data;
    } catch (e) {
        return false;
    }
}

module.exports = { SETTINGS, supabase, EmbedFactory, Logger, TimeUtils, isAdmin };
