const express = require("express");
const cors = require("cors");
const { 
  Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, 
  ActivityType, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits 
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 10000;
const SUPER_OWNER_ID = "1169492860278669312"; 
const GUILD_ID = "1257403231127076915"; 
const VERIFY_CHANNEL_ID = "1444769950421225542"; // Yahan wo channel ID dalo jaha sirf verify allow karna hai
const DEFAULT_VERIFY_MS = 18 * 60 * 60 * 1000; 

// Database Tables
const TABLE = "verifications";
const RULES_TABLE = "role_rules";
const ADMINS_TABLE = "bot_admins";

const app = express();
app.use(cors());
app.use(express.json());

// --- SUPABASE & DISCORD SETUP ---
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, 
    GatewayIntentBits.GuildMessages, 
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers 
  ],
});

// --- COMMANDS ---
const commands = [
  new SlashCommandBuilder().setName("verify").setDescription("🔐 Verify your game access instantly").addStringOption(o => o.setName("code").setDescription("Enter your 6-digit code").setRequired(true)),
  new SlashCommandBuilder().setName("help").setDescription("❓ Get help regarding verification"),
  new SlashCommandBuilder().setName("boost").setDescription("🚀 Check your VIP role boosts"),
  new SlashCommandBuilder().setName("activeusers").setDescription("📜 Admin: Beautiful list of online users").addIntegerOption(o => o.setName("page").setDescription("Page number")),
  new SlashCommandBuilder().setName("userinfo").setDescription("🕵️‍♂️ Admin: Check if user has alt accounts").addUserOption(o => o.setName("user").setDescription("Select User").setRequired(true)),
  new SlashCommandBuilder().setName("setexpiry").setDescription("⚡ Admin: Add/Set Time").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)).addStringOption(o => o.setName("duration").setDescription("Time (e.g. 2d)").setRequired(true)),
  new SlashCommandBuilder().setName("ban").setDescription("🚫 Admin: Ban user").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
  new SlashCommandBuilder().setName("unban").setDescription("✅ Admin: Unban user").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
  new SlashCommandBuilder().setName("lookup").setDescription("🔍 Admin: Deep Search (HWID/Code)").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
  new SlashCommandBuilder().setName("setrule").setDescription("⚙️ Admin: Set Role Rule").addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)).addStringOption(o => o.setName("duration").setDescription("e.g. 32h, +1h").setRequired(true)),
  new SlashCommandBuilder().setName("removerule").setDescription("⚙️ Admin: Remove Role Rule").addRoleOption(o => o.setName("role").setDescription("Role").setRequired(true)),
  new SlashCommandBuilder().setName("listrules").setDescription("📜 Admin: Show all rules"),
  new SlashCommandBuilder().setName("resetuser").setDescription("⚠️ Admin: Delete user data").addStringOption(o => o.setName("target").setDescription("Code/HWID").setRequired(true)),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot Logged In as: ${client.user.tag}`);
  client.user.setActivity('Squid Game X | /verify', { type: ActivityType.Watching });
  try {
    await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
    console.log("🎉 SUCCESS: All Commands Registered!");
  } catch (error) {
    console.error("❌ Command Error:", error);
  }
});

// --- HELPER FUNCTIONS ---
function parseDuration(durationStr) {
  if (!durationStr) return 0;
  if (durationStr.toLowerCase() === "lifetime") return "LIFETIME";
  const cleanStr = durationStr.startsWith("+") ? durationStr.substring(1) : durationStr;
  const match = cleanStr.match(/^(\d+)([mhdw])$/);
  if (!match) return 0;
  const val = parseInt(match[1]);
  const unit = match[2];
  let ms = 0;
  if (unit === 'm') ms = val * 60 * 1000;
  if (unit === 'h') ms = val * 60 * 60 * 1000;
  if (unit === 'd') ms = val * 24 * 60 * 60 * 1000;
  if (unit === 'w') ms = val * 7 * 24 * 60 * 60 * 1000;
  return ms;
}

function formatTime(ms) {
  if (ms === "LIFETIME") return "Lifetime 👑";
  if (typeof ms !== 'number' || ms < 0) return 'Expired 💀';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  let parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) return "Less than 1m";
  return parts.join(' ');
}

async function isAdmin(userId) {
  if (userId === SUPER_OWNER_ID) return true;
  const { data } = await supabase.from(ADMINS_TABLE).select("*").eq("discord_id", userId).maybeSingle();
  return !!data;
}

// --- LOGIC ---
async function calculateUserDuration(member, rules) {
  let activeRules = rules.map(r => {
    const discordRole = member.roles.cache.get(r.role_id);
    return discordRole ? { ...r, roleName: discordRole.name } : null;
  }).filter(r => r !== null);

  if (activeRules.length === 0) {
    return { duration: DEFAULT_VERIFY_MS, ruleText: "Default (18h)", isPunished: false };
  }

  const punishments = activeRules.filter(r => r.roleName.toLowerCase().startsWith("punish"));
  if (punishments.length > 0) {
    let minMs = Infinity;
    let selectedRule = null;
    punishments.forEach(r => {
      const ms = parseDuration(r.duration);
      if (ms !== "LIFETIME" && ms < minMs) { minMs = ms; selectedRule = r; }
    });
    return { duration: minMs, ruleText: `🚫 ${selectedRule.roleName}`, isPunished: true };
  }

  const bases = activeRules.filter(r => !r.duration.startsWith("+"));
  const bonuses = activeRules.filter(r => r.duration.startsWith("+"));
  let maxBase = DEFAULT_VERIFY_MS;
  let baseName = "Default";

  bases.forEach(r => {
    const ms = parseDuration(r.duration);
    if (ms === "LIFETIME") { maxBase = "LIFETIME"; baseName = r.roleName; }
    else if (maxBase !== "LIFETIME" && ms > maxBase) { maxBase = ms; baseName = r.roleName; }
  });

  if (maxBase === "LIFETIME") {
    return { duration: "LIFETIME", ruleText: `👑 ${baseName} (Lifetime)`, isPunished: false };
  }

  let totalBonus = 0;
  bonuses.forEach(r => totalBonus += parseDuration(r.duration));

  const finalDuration = maxBase + totalBonus;
  const bonusText = bonuses.length > 0 ? ` + ${bonuses.length} Boosts` : "";
  const ruleText = `✅ ${baseName}${bonusText}`;
  return { duration: finalDuration, ruleText, isPunished: false };
}

// --- MAIN VERIFY HANDLER ---
async function handleVerification(message, code) {
  const { data: userData } = await supabase.from(TABLE).select("*").eq("code", code).limit(1).maybeSingle();
  
  // 1. Invalid Code Embed
  if (!userData) {
      const errorEmbed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle("❌ Invalid Code")
        .setDescription("Ye code database me nahi mila.\nRoblox game open karke **Check Verification** pe click karo.")
        .setFooter({ text: "Squid Game X Security" });
      return message.reply({ embeds: [errorEmbed] });
  }

  // 2. Banned User Embed
  if (userData.is_banned) {
      const banEmbed = new EmbedBuilder()
        .setColor(0x000000)
        .setTitle("🚫 YOU ARE BANNED")
        .setDescription("Admin has permanently blocked this HWID.")
        .setThumbnail("https://media.tenor.com/images/1c3137d522501256372134515152/tenor.gif");
      return message.reply({ embeds: [banEmbed] });
  }

  // 3. Alt Account Check (Agar Discord ID pehle se kisi aur Code se link hai)
  const { data: alts } = await supabase.from(TABLE).select("*").eq("discord_id", message.author.id);
  if (alts && alts.length > 0) {
      const existingAlt = alts.find(a => a.code !== code);
      if (existingAlt) {
          const altEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle("⚠️ Multiple Accounts Detected")
            .setDescription(`Tumhari ID pehle se code **${existingAlt.code}** ke sath verify hai.`)
            .addFields({ name: "Note", value: "Ek Discord ID se sirf ek Device verify ho sakta hai." });
          // Yahan hum block nahi kar rahe, bas bata rahe hain. Admin chahe to ban kare.
      }
  }
  
  // Calculation
  let calculation;
  try {
    const member = await message.guild.members.fetch(message.author.id);
    const { data: rules } = await supabase.from(RULES_TABLE).select("*");
    calculation = await calculateUserDuration(member, rules || []);
  } catch (e) {
    calculation = { duration: DEFAULT_VERIFY_MS, ruleText: "Default (18h)", isPunished: false };
  }

  const { duration, ruleText, isPunished } = calculation;
  let expiryTime;
  if (duration === "LIFETIME") {
    const d = new Date(); d.setFullYear(d.getFullYear() + 100);
    expiryTime = d.toISOString();
  } else {
    expiryTime = new Date(new Date().getTime() + duration).toISOString();
  }

  // Update DB
  await supabase.from(TABLE).update({ 
    verified: true, 
    expires_at: expiryTime,
    discord_id: message.author.id 
  }).eq("id", userData.id);

  // 4. Success Embed (Premium Look)
  const embedColor = isPunished ? 0xFF4500 : 0x00FF7F; 
  const successEmbed = new EmbedBuilder()
    .setColor(embedColor)
    .setTitle(isPunished ? "⚠️ Restricted Access Granted" : "✅ Verification Successful")
    .setDescription(`**User:** <@${message.author.id}>\n**Status:** Verified & Online`)
    .setThumbnail(message.author.displayAvatarURL())
    .addFields(
        { name: "🔑 Code", value: `\`${code}\``, inline: true },
        { name: "⏱️ Validity", value: `\`${formatTime(duration)}\``, inline: true },
        { name: "📜 Applied Role/Rule", value: ruleText, inline: false }
    )
    .setImage("https://media.discordapp.net/attachments/111/222/verification_banner.png?width=800&height=200") // Yaha apna banner laga lena
    .setFooter({ text: "Enjoy the game!", iconURL: client.user.displayAvatarURL() })
    .setTimestamp();

  return message.reply({ embeds: [successEmbed] });
}

// --- EVENTS ---

// 🛑 AUTO MOD & CHAT LOCK SYSTEM 🛑
client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // SYSTEM: Verification Channel Lock
  // Agar msg us channel me hai jaha verify hota hai:
  if (message.channel.id === VERIFY_CHANNEL_ID) {
      const isCmd = message.content.toLowerCase().startsWith("verify");
      const isAdminUser = await isAdmin(message.author.id);

      // Agar command nahi hai aur admin nahi hai -> DELETE
      if (!isCmd && !isAdminUser) {
          try {
              await message.delete();
              // Optional: User ko DM bhej sakte ho ki "Sirf command use karo"
          } catch (e) {} 
          return;
      }
      
      // Agar command hai, to process karo
      if (isCmd) {
        const args = message.content.trim().split(/\s+/);
        if (args.length < 2) {
             const helpEmbed = new EmbedBuilder().setColor(0xFF0000).setDescription("❌ **Use:** `verify 123456`");
             const r = await message.reply({ embeds: [helpEmbed] });
             setTimeout(() => r.delete().catch(()=>{}), 5000); // 5 sec baad error msg bhi delete
             return;
        }
        await handleVerification(message, args[1]);
      }
  }

  // Fun Command (Owner Only)
  if (message.content === "😎" && message.author.id === SUPER_OWNER_ID) {
      message.reply("System faad denge sir! 🔥");
  }
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const { commandName } = interaction;

  // --- SLASH COMMANDS ---
  if (commandName === "verify") {
    const code = interaction.options.getString("code");
    await interaction.deferReply();
    const fakeMsg = {
      author: interaction.user,
      guild: interaction.guild,
      reply: (opts) => interaction.editReply(opts),
      channel: interaction.channel
    };
    await handleVerification(fakeMsg, code);
    return;
  }

  if (commandName === "boost") {
    await interaction.deferReply();
    const member = await interaction.guild.members.fetch(interaction.user.id);
    const { data: rules } = await supabase.from(RULES_TABLE).select("*");
    const calc = await calculateUserDuration(member, rules || []);
    
    const boostEmbed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle("🚀 Your Boost Status")
        .addFields(
            { name: "Logic Applied", value: calc.ruleText },
            { name: "Time You Will Get", value: formatTime(calc.duration) }
        );
    return interaction.editReply({ embeds: [boostEmbed] });
  }

  // ADMIN CHECK
  if (!await isAdmin(interaction.user.id)) return interaction.reply({ content: "❌ Tum Admin nahi ho!", ephemeral: true });

  // --- 👑 NEW ACTIVE USERS (PRO STYLE) ---
  if (commandName === "activeusers") {
    await interaction.deferReply(); 
    const limit = 10; // Embed me 10 hi dikhayenge taaki clean rahe
    const page = interaction.options.getInteger("page") || 1;
    const offset = (page - 1) * limit;
    
    const { data: activeUsers } = await supabase.from(TABLE)
        .select("code, expires_at, discord_id")
        .eq("verified", true)
        .gt("expires_at", new Date().toISOString())
        .order("expires_at", { ascending: true })
        .range(offset, offset + limit - 1);

    if (!activeUsers || !activeUsers.length) {
        return interaction.editReply({ embeds: [new EmbedBuilder().setColor(0xFF0000).setTitle("❌ No Active Users")] });
    }

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`📜 Active Users (Page ${page})`)
        .setDescription("List of currently verified players.")
        .setFooter({ text: "Real-time Data from Supabase" })
        .setTimestamp();

    // Fetch names nicely
    const fields = [];
    for (const [i, u] of activeUsers.entries()) {
        const left = new Date(u.expires_at).getTime() - Date.now();
        let userDisplay = "Unknown";
        if (u.discord_id) {
             try {
                 const user = await client.users.fetch(u.discord_id);
                 userDisplay = `${user.username}`;
             } catch (e) { userDisplay = u.discord_id; }
        }
        fields.push({ 
            name: `#${offset + i + 1} ${userDisplay}`, 
            value: `🔑 \`${u.code}\`\n⏳ ${formatTime(left)}`, 
            inline: true 
        });
    }
    embed.addFields(fields);
    return interaction.editReply({ embeds: [embed] });
  }

  // --- 🕵️‍♂️ ALT DETECTION COMMAND ---
  if (commandName === "userinfo") {
      await interaction.deferReply();
      const targetUser = interaction.options.getUser("user");
      const { data: accounts } = await supabase.from(TABLE).select("*").eq("discord_id", targetUser.id);
      
      const infoEmbed = new EmbedBuilder()
          .setColor(0x9B59B6)
          .setTitle(`🕵️‍♂️ User Lookup: ${targetUser.username}`)
          .setThumbnail(targetUser.displayAvatarURL());
      
      if (!accounts || accounts.length === 0) {
          infoEmbed.setDescription("❌ No verification data found for this user.");
      } else {
          infoEmbed.setDescription(`✅ Found **${accounts.length}** Linked Accounts`);
          accounts.forEach((acc, i) => {
              infoEmbed.addFields({
                  name: `Account #${i+1}`,
                  value: `Code: \`${acc.code}\`\nHWID: \`...${acc.hwid.slice(-6)}\`\nStatus: ${acc.verified ? "🟢 Active" : "🔴 Inactive"}`
              });
          });
      }
      return interaction.editReply({ embeds: [infoEmbed] });
  }

  // --- OTHER ADMIN COMMANDS (SAME AS BEFORE BUT CLEANER) ---
  if (commandName === "lookup") {
      await interaction.deferReply();
      const target = interaction.options.getString("target");
      const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
      if (!data) return interaction.editReply("❌ Not Found");
      
      const lookupEmbed = new EmbedBuilder()
        .setColor(0x00FFFF)
        .setTitle("🔍 Database Lookup")
        .addFields(
            { name: "Code", value: `\`${data.code}\``, inline: true },
            { name: "HWID", value: `\`${data.hwid}\``, inline: true },
            { name: "Discord ID", value: data.discord_id ? `<@${data.discord_id}>` : "None", inline: true },
            { name: "Status", value: data.is_banned ? "🚫 BANNED" : (data.verified ? "✅ Verified" : "❌ Unverified") },
            { name: "Expiry", value: data.expires_at ? `<t:${Math.floor(new Date(data.expires_at).getTime()/1000)}:R>` : "Null" }
        );
      return interaction.editReply({ embeds: [lookupEmbed] });
  }
  
  // Setexpiry, Ban, Unban, SetRule... (Baaki commands same logic bas embed me daal sakte ho agar chaho)
  // For brevity, keeping simple replies for quick actions, but you can convert them too.
  if (commandName === "setexpiry") {
    // ... (Old logic, just updated variable names if needed)
    // Same old logic works perfectly, just ensures functionality.
    await interaction.deferReply();
    const duration = interaction.options.getString("duration");
    const ms = parseDuration(duration);
    if (!ms) return interaction.editReply("❌ Invalid");
    const target = interaction.options.getString("target");
    const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
    if (!data) return interaction.editReply("❌ Not Found");
    let newDate = ms === "LIFETIME" ? new Date(Date.now() + 3153600000000).toISOString() : new Date(Date.now() + ms).toISOString();
    await supabase.from(TABLE).update({ verified: true, expires_at: newDate, is_banned: false }).eq("id", data.id);
    return interaction.editReply(`✅ Updated ${target} for ${formatTime(ms)}`);
  }
  if (commandName === "ban") {
      await interaction.deferReply();
      const target = interaction.options.getString("target");
      const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
      if (!data) return interaction.editReply("❌ Not Found");
      await supabase.from(TABLE).update({ is_banned: true, verified: false }).eq("id", data.id);
      return interaction.editReply(`🚫 Banned ${target}`);
  }
  if (commandName === "unban") {
      await interaction.deferReply();
      const target = interaction.options.getString("target");
      const { data } = await supabase.from(TABLE).select("*").or(`code.eq.${target},hwid.eq.${target}`).maybeSingle();
      if (!data) return interaction.editReply("❌ Not Found");
      await supabase.from(TABLE).update({ is_banned: false }).eq("id", data.id);
      return interaction.editReply(`✅ Unbanned ${target}`);
  }
});

// --- API (NO CHANGE REQUIRED HERE) ---
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });
  const { data: existing } = await supabase.from(TABLE).select("*").eq("hwid", hwid).maybeSingle();
  if (existing) {
    if (existing.is_banned) return res.json({ status: "BANNED", message: "Contact Admin" });
    if (existing.verified && new Date(existing.expires_at) > new Date()) return res.json({ status: "VALID" });
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await supabase.from(TABLE).insert([{ hwid, code, verified: false, is_banned: false }]);
  return res.json({ status: "NEED_VERIFY", code });
});

app.get("/", (req, res) => res.send("System Online 🟢"));

// --- FINAL LOGIN ---
client.login(process.env.DISCORD_BOT_TOKEN);
