import { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } from "discord.js";
import { joinVoiceChannel, getVoiceConnection } from "@discordjs/voice";
import { SWEARS } from "./swears.js";
import dotenv from "dotenv";

dotenv.config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

const PREFIX = "!";
const ENABLE_VOICE = process.env.ENABLE_VOICE === "true";

const HOST_ROLE_ID = "YOUR_HOST_ROLE_ID"; // Host role ID here
const WELCOME_CHANNEL = "1403929923084882012";
const FAREWELL_CHANNEL = "1403930222222643220";

// Track warnings
const warnings = new Map();

// ----------------------------
// Welcome / Farewell
// ----------------------------
client.on("guildMemberAdd", member => {
  client.channels.cache.get(WELCOME_CHANNEL)?.send(`👋 Welcome, ${member}!`);
  member.send("Welcome to the server!");
});

client.on("guildMemberRemove", member => {
  client.channels.cache.get(FAREWELL_CHANNEL)?.send(`👋 Goodbye, ${member.user.tag}!`);
  member.send("Sad to see you leave 😢").catch(() => {});
});

// ----------------------------
// Auto ✅ reaction
// ----------------------------
client.on("messageCreate", async message => {
  if (message.mentions.everyone || message.content.includes("@here")) {
    await message.react("✅");
  }
});

// ----------------------------
// Profanity filter (Text)
// ----------------------------
client.on("messageCreate", async message => {
  if (message.author.bot) return;
  const lowered = message.content.toLowerCase();
  if (SWEARS.some(w => lowered.includes(w))) {
    await message.delete().catch(() => {});
    const count = (warnings.get(message.author.id) || 0) + 1;
    warnings.set(message.author.id, count);
    await message.author.send(`⚠️ Your message was removed for swearing.\n\nMessage: "${message.content}"\nThis is your **${count} warning**.`);
    const logCh = client.channels.cache.find(c => c.name.includes("log"));
    logCh?.send(`[LOG] ${message.author.tag} used profanity: "${message.content}" (Warning #${count})`);
  }
});

// ----------------------------
// Hostfriendly Reaction Roles
// ----------------------------
client.on("messageCreate", async message => {
  if (!message.content.startsWith(`${PREFIX}hostfriendly`)) return;
  if (!message.member.roles.cache.has(HOST_ROLE_ID)) {
    return message.reply("❌ You are not allowed to host friendlies.");
  }

  const embed = new EmbedBuilder()
    .setTitle("⚽ 7v7 Friendly Lineup")
    .setDescription("React with 1️⃣–7️⃣ to claim your spot!\nThe host can pre-claim a position.")
    .setColor("Green");

  const msg = await message.channel.send({ embeds: [embed] });
  for (const emoji of ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣"]) {
    await msg.react(emoji);
  }

  const filter = (reaction, user) => !user.bot;
  const collector = msg.createReactionCollector({ filter });

  const lineup = new Map();

  collector.on("collect", async (reaction, user) => {
    const member = await message.guild.members.fetch(user.id);
    if (lineup.has(user.id)) {
      return user.send("❌ You are already in the lineup!");
    }
    if (Array.from(lineup.values()).includes(reaction.emoji.name)) {
      return user.send("❌ That position is already taken!");
    }
    lineup.set(user.id, reaction.emoji.name);
    await user.send(`✅ You have been assigned position ${reaction.emoji.name}`);
    message.channel.send(`📌 ${user.tag} confirmed for position ${reaction.emoji.name}`);
  });
});

// ----------------------------
// Activity Check
// ----------------------------
client.on("messageCreate", async message => {
  if (!message.content.startsWith(`${PREFIX}activitycheck`)) return;
  const args = message.content.split(" ");
  const goal = parseInt(args[1]) || 40;
  const embed = new EmbedBuilder()
    .setTitle("📊 Activity Check")
    .setDescription(`React with ✅ to check in!\nGoal: **${goal}** members.`)
    .setColor("Blue");
  const msg = await message.channel.send({ embeds: [embed] });
  await msg.react("✅");
});

// ----------------------------
// Moderation Commands
// ----------------------------
client.on("messageCreate", async message => {
  if (!message.content.startsWith(PREFIX) || message.author.bot) return;
  const args = message.content.slice(PREFIX.length).trim().split(" ");
  const cmd = args.shift().toLowerCase();

  if (cmd === "ban") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
    const member = message.mentions.members.first();
    if (!member) return;
    await member.ban();
    message.channel.send(`🔨 Banned ${member.user.tag}`);
  }

  if (cmd === "unban") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return;
    const userId = args[0];
    await message.guild.members.unban(userId);
    message.channel.send(`✅ Unbanned ${userId}`);
  }

  if (cmd === "kick") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return;
    const member = message.mentions.members.first();
    await member.kick();
    message.channel.send(`👢 Kicked ${member.user.tag}`);
  }

  if (cmd === "timeout") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return;
    const member = message.mentions.members.first();
    const seconds = parseInt(args[1]) * 1000;
    await member.timeout(seconds);
    message.channel.send(`⏲️ Timed out ${member.user.tag} for ${args[1]}s`);
  }

  if (cmd === "dmall") {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    const msgContent = args.join(" ");
    message.guild.members.fetch().then(members => {
      members.forEach(m => {
        if (!m.user.bot) {
          m.send(`${msgContent}\n\n*DM sent by ${message.author.tag}*`).catch(() => {});
        }
      });
    });
    message.channel.send("✅ DMs sent.");
  }
});

// ----------------------------
// Voice moderation (Render friendly)
// ----------------------------
client.on("voiceStateUpdate", (oldState, newState) => {
  if (!ENABLE_VOICE) return;
  if (newState.channelId && !oldState.channelId) {
    const logCh = newState.guild.channels.cache.find(c => c.name.includes("log"));
    logCh?.send(`[VC] ${newState.member.user.tag} joined VC`);
  }
});

// ----------------------------
// Bot Ready
// ----------------------------
client.once("ready", () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Voice: ${ENABLE_VOICE ? "Enabled" : "Disabled (Render-safe)"}`);
});

client.login(process.env.TOKEN);
