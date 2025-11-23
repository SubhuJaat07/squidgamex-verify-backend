const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { Client, GatewayIntentBits } = require("discord.js");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// 🔥 Firebase Init
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
});
const db = admin.firestore();
const verifyDB = db.collection("verifications");

// 🔥 Discord Bot Init
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});
client.login(process.env.BOT_TOKEN);

client.once("clientready", () => {
  console.log(`🤖 BOT READY — Logged in as ${client.user.tag}`);
});

// Discord Command: !verify CODE
client.on("messageCreate", async (message) => {
  if (!message.content.startsWith("!verify")) return;
  const args = message.content.split(" ");

  if (args.length < 2) {
    return message.reply("❌ Use: `!verify 123456`");
  }

  const code = args[1];

  const snapshot = await verifyDB.where("code", "==", code).get();
  if (snapshot.empty) return message.reply("❌ Invalid or expired code!");

  const doc = snapshot.docs[0];
  await doc.ref.update({ verified: true });

  return message.reply("✅ Verification Success! You are now connected.");
});

// 🎯 Roblox Check Route
app.get("/check", async (req, res) => {
  const { hwid } = req.query;
  if (!hwid) return res.json({ status: "ERROR", message: "HWID Missing" });

  // Search HWID
  const snap = await verifyDB.where("hwid", "==", hwid).get();
  if (!snap.empty) {
    const data = snap.docs[0].data();
    if (data.verified === true) return res.json({ status: "VALID" });
    return res.json({ status: "NEED_VERIFY", code: data.code });
  }

  // Generate new code
  const code = Math.floor(100000 + Math.random() * 900000).toString();
  await verifyDB.add({
    hwid,
    code,
    verified: false,
    created: Date.now(),
  });

  return res.json({ status: "NEED_VERIFY", code });
});

// Start Server
app.listen(PORT, () => console.log(`🚀 API Running on ${PORT}`));
