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

// ===============================
// !hostfriendly command
// ===============================
if (command === "hostfriendly") {
    const HOST_ROLE_ID = "1383970211933454378";

    // Role check
    if (!message.member.roles.cache.has(HOST_ROLE_ID)) {
        return message.reply("❌ You are not allowed to host friendlies.");
    }

    const positions = ["GK", "CB", "CB2", "CM", "LW", "RW", "ST"];
    const numbers = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣"];

    let lineup = {}; // { userId: posIndex }
    let taken = new Array(positions.length).fill(null);

    // Preclaim logic (host reserves a slot if passed)
    let preclaimIndex = null;
    if (args[0]) {
        const arg = args[0].toLowerCase();
        let chosen = -1;

        // Check if number
        if (!isNaN(arg)) {
            chosen = parseInt(arg) - 1;
        } else {
            chosen = positions.findIndex(p => p.toLowerCase() === arg);
        }

        if (chosen >= 0 && chosen < positions.length && !taken[chosen]) {
            lineup[message.author.id] = chosen;
            taken[chosen] = message.author.id;
            preclaimIndex = chosen;
        }
    }

    // Embed builder
    const buildEmbed = () => {
        let desc = positions.map((pos, i) => {
            const userId = taken[i];
            return `${numbers[i]} ➝ **${pos}**\n${userId ? `<@${userId}>` : "_-_"}`;
        }).join("\n\n");

        let finalLineup = positions.map((pos, i) => {
            const userId = taken[i];
            return `${pos}: ${userId ? `<@${userId}>` : "_-_"}`;
        }).join("\n");

        return new EmbedBuilder()
            .setTitle("AGNELLO FC 7v7 FRIENDLY")
            .setColor("Green")
            .setDescription(desc + "\n\nReact to claim a position. Only 1 position per user. Please do not glitch out the bot, by attempting to react to all positions. There will be a punishment.\n\n" +
                "✅ **Final Lineup:**\n" + finalLineup);
    };

    const embedMsg = await message.channel.send({ embeds: [buildEmbed()] });

    for (const emoji of numbers) {
        await embedMsg.react(emoji);
    }

    // Reaction collector
    const collector = embedMsg.createReactionCollector({
        filter: (reaction, user) => numbers.includes(reaction.emoji.name) && !user.bot,
        dispose: true
    });

    collector.on("collect", async (reaction, user) => {
        const posIndex = numbers.indexOf(reaction.emoji.name);

        if (lineup[user.id] !== undefined) {
            await reaction.users.remove(user.id);
            return message.channel.send(`<@${user.id}> ❌ You are already in the lineup!`);
        }

        if (taken[posIndex]) {
            await reaction.users.remove(user.id);
            return message.channel.send(`<@${user.id}> ❌ That position is already filled.`);
        }

        lineup[user.id] = posIndex;
        taken[posIndex] = user.id;

        try {
            await user.send(`✅ You have been confirmed for **${positions[posIndex]}** in the lineup!`);
        } catch {
            message.channel.send(`⚠️ Could not DM <@${user.id}>.`);
        }

        await embedMsg.edit({ embeds: [buildEmbed()] });
        await message.channel.send(`✅ ${positions[posIndex]} confirmed for <@${user.id}>`);
    });

    // Save embed & lineup to memory for !editlineup
    client.lineupData = { embedMsg, lineup, taken, positions, numbers };
}

// ===============================
// !editlineup command (host only)
// ===============================
if (command === "editlineup") {
    const HOST_ROLE_ID = "1383970211933454378";
    if (!message.member.roles.cache.has(HOST_ROLE_ID)) {
        return message.reply("❌ Only the friendly host can edit the lineup.");
    }

    if (!client.lineupData) {
        return message.reply("❌ No active lineup found.");
    }

    const { embedMsg, lineup, taken, positions, numbers } = client.lineupData;

    const posArg = args[0]?.toLowerCase();
    const user = message.mentions.users.first();
    if (!posArg || !user) {
        return message.reply("⚠️ Usage: `!editlineup <pos> <@user>` (e.g. `!editlineup cm @Player`)");
    }

    let posIndex = -1;
    if (!isNaN(posArg)) {
        posIndex = parseInt(posArg) - 1;
    } else {
        posIndex = positions.findIndex(p => p.toLowerCase() === posArg);
    }

    if (posIndex < 0 || posIndex >= positions.length) {
        return message.reply("❌ Invalid position.");
    }

    // Free position if taken
    if (taken[posIndex]) {
        const prevUserId = taken[posIndex];
        delete lineup[prevUserId];
    }

    // Assign new player
    lineup[user.id] = posIndex;
    taken[posIndex] = user.id;

    await embedMsg.edit({ embeds: [new EmbedBuilder()
        .setTitle("AGNELLO FC 7v7 FRIENDLY")
        .setColor("Green")
        .setDescription(positions.map((pos, i) =>
            `${numbers[i]} ➝ **${pos}**\n${taken[i] ? `<@${taken[i]}>` : "_-_"}`
        ).join("\n\n") + "\n\n✅ **Final Lineup:**\n" +
            positions.map((pos, i) =>
                `${pos}: ${taken[i] ? `<@${taken[i]}>` : "_-_"}`
            ).join("\n"))] });

    await message.channel.send(`✏️ ${positions[posIndex]} updated → <@${user.id}>`);
}


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
