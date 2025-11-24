const express = require("express");
const cors = require("cors");
const { Client, GatewayIntentBits } = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("Squid Game X Backend is Alive! 🟢");
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const TABLE = "verifications";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

client.login(process.env.DISCORD_BOT_TOKEN);

client.once("clientready", () => {
  console.log(`Bot Ready: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith("!verify")) return;

  const args = message.content.split(" ");
  if (args.length < 2) return message.reply("❌ Use: `!verify 123456`");

  const code = args[1];

  const { data } = await supabase
    .from(TABLE)
    .select("*")
    .eq("code", code)
    .limit(1)
    .maybeSingle();

  if (!data) return message.reply("❌ Invalid code!");

  await supabase
    .from(TABLE)
    .update({ verified: true })
    .eq("id", data.id);

  return message.reply("✅ Success! You can play now.");
});

app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "No HWID" });

  const { data: existing } = await supabase
    .from(TABLE)
    .select("*")
    .eq("hwid", hwid)
    .limit(1)
    .maybeSingle();

  if (existing) {
    if (existing.verified === true) {
      return res.json({ status: "VALID" });
    }
    return res.json({ status: "NEED_VERIFY", code: existing.code });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await supabase.from(TABLE).insert([
    {
      hwid: hwid,
      code: code,
      verified: false,
      expires_at: null
    }
  ]);

  return res.json({ status: "NEED_VERIFY", code });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
