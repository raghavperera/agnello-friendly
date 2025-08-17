// ==========================
// Agnello FC - index.js
// All-in-one bot: moderation, hostfriendly, activity check, music, dmrole,
// auto ✅ for @everyone/@here, optional voice auto-moderation (disabled by default for Render).
// ==========================

/**
 * IMPORTANT:
 * - By default voice features are disabled (to avoid Render UDP errors).
 * - To enable voice features (auto mute, recording, music in VC), set ENABLE_VOICE=true
 *   and run on a machine that allows UDP (VPS / dedicated server).
 *
 * ENV VARS:
 *  - TOKEN (required)
 *  - LOG_CHANNEL_ID (optional, defaults to 1362214241091981452)
 *  - VOICE_CHANNEL_ID (optional - default used for joinvc)
 *  - ENABLE_VOICE (optional, "true" to enable voice features)
 *  - OPENAI_API_KEY (optional for transcription)
 */

import fs from "fs";
import path from "path";
import process from "process";
import fetch from "node-fetch";
import { pipeline } from "stream/promises";
import prism from "prism-media";
import ytdl from "ytdl-core";

import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  Collection,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
} from "@discordjs/voice";

// ---------- Config ----------
const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN || "";
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "1362214241091981452";
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || "1368359914145058956";
const ENABLE_VOICE = (process.env.ENABLE_VOICE || "false").toLowerCase() === "true";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const PORT = process.env.PORT || 3000;

// Create logs folder if missing
if (!fs.existsSync("./vc_logs")) fs.mkdirSync("./vc_logs");

// ---------- Client Setup ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

client.commands = new Collection();
client.queue = new Map(); // music queues
client.hostfriendlies = new Map(); // active hostfriendly sessions

// ---------- Keepalive Server ----------
import express from "express";
const app = express();
app.get("/", (req, res) => res.send("Agnello FC Bot is alive"));
app.listen(PORT, () => console.log(`Keepalive server listening on ${PORT}`));

// ---------- Utilities ----------
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function safeLogToChannel(guild, title, desc) {
  try {
    const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel && logChannel.isTextBased()) {
      const embed = new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xff0000).setTimestamp();
      logChannel.send({ embeds: [embed] }).catch((e) => console.error("Failed to send log:", e));
    }
  } catch (e) {
    console.error("safeLogToChannel error:", e);
  }
  // Also console
  console.log(`[LOG] ${title} - ${desc}`);
}

function containsSwear(text, swearList) {
  if (!text) return false;
  const lowered = text.toLowerCase();
  return swearList.some((w) => {
    if (!w) return false;
    return lowered.includes(w.toLowerCase());
  });
}

// Basic embedded swear list (you can replace by requiring ./swears.js)
const swears = [
  "fuck",
  "shit",
  "bitch",
  "ass",
  "damn",
  "bastard",
  "cunt",
  "dick",
  "pussy",
  "nigger",
  "faggot",
  // expand / replace with a more comprehensive file as needed
];

// ---------- Command Helpers ----------
async function sendDMSafe(member, content) {
  try {
    await member.send(content);
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- Moderation Commands (prefix-style) ----------
const PREFIX = "!";

client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot || !message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  // Permission check helpers
  const hasAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
  const hasBanPerm = message.member.permissions.has(PermissionsBitField.Flags.BanMembers);
  const hasKickPerm = message.member.permissions.has(PermissionsBitField.Flags.KickMembers);
  const hasModPerm = message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers);

  try {
    // --- ban ---
    if (cmd === "ban") {
      if (!hasBanPerm) return message.reply("❌ You don't have permission to ban.");
      const member = message.mentions.members.first();
      if (!member) return message.reply("⚠️ Mention a user to ban.");
      const reason = args.join(" ") || "No reason provided";
      await member.ban({ reason });
      safeLogToChannel(message.guild, "Ban", `${message.author.tag} banned ${member.user.tag} | ${reason}`);
      return message.channel.send(`✅ Banned ${member.user.tag}`);
    }

    // --- unban ---
    if (cmd === "unban") {
      if (!hasBanPerm) return message.reply("❌ You don't have permission to unban.");
      const id = args[0];
      if (!id) return message.reply("⚠️ Provide a user ID to unban.");
      await message.guild.members.unban(id);
      safeLogToChannel(message.guild, "Unban", `${message.author.tag} unbanned ${id}`);
      return message.channel.send(`✅ Unbanned <@${id}>`);
    }

    // --- kick ---
    if (cmd === "kick") {
      if (!hasKickPerm) return message.reply("❌ You don't have permission to kick.");
      const member = message.mentions.members.first();
      if (!member) return message.reply("⚠️ Mention a user to kick.");
      const reason = args.join(" ") || "No reason provided";
      await member.kick(reason);
      safeLogToChannel(message.guild, "Kick", `${message.author.tag} kicked ${member.user.tag} | ${reason}`);
      return message.channel.send(`✅ Kicked ${member.user.tag}`);
    }

    // --- timeout ---
    if (cmd === "timeout") {
      if (!hasModPerm) return message.reply("❌ You don't have permission to timeout.");
      const member = message.mentions.members.first();
      const duration = parseInt(args[1]) || parseInt(args[0]) || 60; // seconds
      if (!member) return message.reply("⚠️ Mention a user to timeout.");
      await member.timeout(duration * 1000, `Timeout by ${message.author.tag}`);
      safeLogToChannel(message.guild, "Timeout", `${message.author.tag} timed out ${member.user.tag} for ${duration}s`);
      return message.channel.send(`⏱ Timed out ${member.user.tag} for ${duration}s`);
    }

    // --- vmute (manual voice mute) ---
    if (cmd === "vmute") {
      if (!hasModPerm) return message.reply("❌ You don't have permission to use vmute.");
      const member = message.mentions.members.first();
      if (!member) return message.reply("⚠️ Mention a user to vmute.");
      if (!member.voice.channel) return message.reply("⚠️ That user is not in voice.");
      await member.voice.setMute(true, `Muted by ${message.author.tag}`);
      safeLogToChannel(message.guild, "Voice Mute", `${message.author.tag} muted ${member.user.tag} manually`);
      return message.channel.send(`🔇 ${member.user.tag} muted in VC`);
    }

    // --- dmrole (prefix): !dmrole <roleId> <message...> ---
    if (cmd === "dmrole") {
      if (!hasAdmin) return message.reply("❌ Only admins can use dmrole.");
      const roleId = args.shift();
      const content = args.join(" ");
      if (!roleId || !content) return message.reply("Usage: `!dmrole <roleId> <message>`");
      const role = message.guild.roles.cache.get(roleId);
      if (!role) return message.reply("⚠️ Role not found.");
      const failed = [];
      for (const member of role.members.values()) {
        const ok = await sendDMSafe(member, content);
        if (!ok) failed.push(member.user.tag);
      }
      const result = failed.length ? `Failed DM: ${failed.join(", ")}` : "All DMs sent.";
      safeLogToChannel(message.guild, "DM Role", `DM to role ${role.name} by ${message.author.tag} | Failed: ${failed.length}`);
      return message.channel.send(result);
    }

    // --- play / skip / stop / queue (music) ---
    if (cmd === "play" || cmd === "skip" || cmd === "stop" || cmd === "queue" || cmd === "nowplaying") {
      // Music only works when ENABLE_VOICE=true and environment supports UDP.
      if (!ENABLE_VOICE) return message.reply("⚠️ Voice/music features disabled in this host. Set ENABLE_VOICE=true on a UDP-enabled host to enable.");
      // handle music commands further below (we'll route)
    }

    // --- hostfriendly (simple starter) ---
    if (cmd === "hostfriendly") {
      // Permission for hosting: Admins or role "Friendlies Department"
      const canHost =
        message.member.permissions.has(PermissionsBitField.Flags.Administrator) ||
        message.member.roles.cache.some((r) => r.name === "Friendlies Department");
      if (!canHost) return message.reply("❌ You cannot host a friendly.");
      // allow optional starting position arg
      const startPos = args[0] ? args[0].toUpperCase() : null;
      return startHostFriendly(message, message.author, startPos);
    }

    // --- activitycheck ---
    if (cmd === "activitycheck") {
      // Usage: !activitycheck <goal>
      const goal = parseInt(args[0]) || 40;
      return startActivityCheck(message.channel, message.author, goal);
    }

    // --- joinvc (command for bot to join user's VC) ---
    if (cmd === "joinvc") {
      if (!ENABLE_VOICE) return message.reply("⚠️ Voice disabled in this host.");
      const voiceChannel = message.member.voice.channel;
      if (!voiceChannel) return message.reply("⚠️ Join a VC first or set VOICE_CHANNEL_ID env.");
      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
        });
        // handle networking errors gracefully
        connection.on("error", (err) => {
          console.error("Voice connection error:", err);
        });
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
        message.channel.send("✅ Joined VC. Monitoring enabled.");
        safeLogToChannel(message.guild, "JoinVC", `${client.user.tag} joined ${voiceChannel.name}`);
      } catch (err) {
        console.error("Failed to join VC:", err);
        return message.reply("❌ Failed to join VC (this host may block UDP).");
      }
    }

    // --- leavevc ---
    if (cmd === "leavevc") {
      if (!ENABLE_VOICE) return message.reply("⚠️ Voice disabled.");
      const conn = getVoiceConnection(message.guild.id);
      if (conn) {
        conn.destroy();
        return message.channel.send("✅ Left voice channel.");
      } else {
        return message.channel.send("⚠️ Not connected to a VC.");
      }
    }
  } catch (err) {
    console.error("Command processing error:", err);
  }
});

// ---------- Music Implementation (requires ENABLE_VOICE=true) ----------
async function playSong(guildId) {
  const serverQueue = client.queue.get(guildId);
  if (!serverQueue) {
    client.queue.delete(guildId);
    return;
  }
  if (!serverQueue.songs.length) {
    // no more songs
    serverQueue.player.stop();
    serverQueue.connection.destroy();
    client.queue.delete(guildId);
    return;
  }
  const song = serverQueue.songs.shift();
  try {
    const stream = ytdl(song.url, { filter: "audioonly", highWaterMark: 1 << 25 });
    const resource = createAudioResource(stream);
    serverQueue.player.play(resource);
    serverQueue.connection.subscribe(serverQueue.player);
    serverQueue.textChannel.send(`🎶 Now playing: ${song.url}`).catch(() => {});
  } catch (e) {
    console.error("playSong error:", e);
    serverQueue.textChannel.send("❌ Failed to play that track.");
  }

  serverQueue.player.once(AudioPlayerStatus.Idle, () => {
    // next song
    setImmediate(() => playSong(guildId));
  });
}

// Hook into voice state updates to auto-start recording when needed only if ENABLE_VOICE true.
// NOTE: On hosts like Render, this is disabled by default.
if (ENABLE_VOICE) {
  client.on("voiceStateUpdate", async (oldState, newState) => {
    // Only respond to joins or speaking changes (we'll attempt to subscribe)
    try {
      // If user joined a voice channel
      if (!oldState.channelId && newState.channelId) {
        safeLogToChannel(newState.guild, "VC Join", `${newState.member.user.tag} joined ${newState.channel.name}`);
      }

      // If user left vc
      if (oldState.channelId && !newState.channelId) {
        safeLogToChannel(newState.guild, "VC Leave", `${newState.member.user.tag} left VC`);
      }

      // If user moved channels, we might want to monitor new channel events.

      // The heavy auto-moderation logic requires the bot to be in the same VC and have a voice connection.
      // We only proceed if the bot is already connected to that guild's voice channel.
      const connection = getVoiceConnection(newState.guild.id);
      if (!connection) return; // bot not in VC; do nothing

      // Try subscribing to the user stream (this may throw if permissions/environment disallow)
      const receiver = connection.receiver;
      if (!receiver) return;

      // Subscribe to the user's opus packets -> convert to raw PCM
      const opusStream = receiver.subscribe(newState.id, { end: { behavior: "silence", duration: 5000 } });

      const pcmChunks = [];
      opusStream.on("data", (chunk) => {
        pcmChunks.push(chunk);
      });

      opusStream.on("end", async () => {
        try {
          if (!pcmChunks.length) return;
          const buffer = Buffer.concat(pcmChunks);
          const filePath = `./vc_logs/${newState.id}_${Date.now()}.pcm`;
          fs.writeFileSync(filePath, buffer);
          safeLogToChannel(newState.guild, "VC Clip Saved", `Saved clip for ${newState.member.user.tag}: ${filePath}`);

          // Optional: transcribe if OPENAI_API_KEY present
          let transcription = null;
          if (OPENAI_API_KEY) {
            try {
              transcription = await transcribeWithOpenAI(filePath);
            } catch (e) {
              console.error("Transcription failed:", e);
            }
          }

          // if transcription contains swear words OR we want to check raw buffer for keywords (impractical),
          // we use the transcription
          if (transcription && containsSwear(transcription, swears)) {
            // Mute member
            try {
              await newState.member.voice.setMute(true, "Auto-mute: swear detected");
              safeLogToChannel(
                newState.guild,
                "Auto VC Mute",
                `${newState.member.user.tag} was auto-muted. Transcription: ${transcription}`
              );
              // send clip and transcription to log channel
              const logCh = newState.guild.channels.cache.get(LOG_CHANNEL_ID);
              if (logCh && logCh.isTextBased()) {
                await logCh.send({
                  content: `**Voice Moderation:** <@${newState.id}> muted. Transcription:\n\`${transcription}\``,
                  files: [filePath],
                });
              }
            } catch (err) {
              console.error("Failed to auto-mute member:", err);
            }
          } else {
            // If transcription missing but we want to do automatic muting on ANY audio detected,
            // you could uncomment the following to mute all talking users (be careful):
            // await newState.member.voice.setMute(true, "Auto-mute: talking detected");
          }
        } catch (e) {
          console.error("Error handling pcm data:", e);
        }
      });

      opusStream.on("error", (err) => {
        console.error("opusStream error:", err);
      });
    } catch (err) {
      console.error("voiceStateUpdate handler error:", err);
    }
  });
} else {
  // When voice is disabled, ensure we don't attempt to join or subscribe anywhere.
  client.on("voiceStateUpdate", (o, n) => {
    // no-op when voice disabled to avoid Render crash
  });
}

// ---------- Helper: Transcribe with OpenAI (optional) ----------
async function transcribeWithOpenAI(filePath) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  // Using OpenAI's generic transcription endpoint (this code may require adjustments if API changed)
  const url = "https://api.openai.com/v1/audio/transcriptions";
  const form = new (await import("form-data")).default();
  form.append("model", "whisper-1");
  form.append("file", fs.createReadStream(filePath));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: form,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Transcription API error: ${res.status} ${txt}`);
  }
  const json = await res.json();
  return json.text || null;
}

// ---------- Hostfriendly: live reaction-role friendly (one embed, updates) ----------
async function startHostFriendly(message, hostUser, hostPosition = null) {
  const positions = ["GK", "CB", "CB2", "CM", "LW", "RW", "ST"];
  const emojis = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣"];
  const claimed = Array(positions.length).fill(null); // store user ids
  const userClaim = {}; // userId -> index

  // Pre-assign host position if valid
  if (hostPosition) {
    const idx = positions.indexOf(hostPosition.toUpperCase());
    if (idx !== -1) {
      claimed[idx] = hostUser.id;
      userClaim[hostUser.id] = idx;
    }
  }

  const buildDesc = () => {
    let out = "";
    positions.forEach((p, i) => {
      out += `> **${emojis[i]} ${p}:** _${claimed[i] ? `<@${claimed[i]}>` : "empty"}_\n`;
    });
    out += "\n||@everyone||"; // subtle everyone ping inline (double-pipe so it's small)
    return out;
  };

  const embed = new EmbedBuilder().setTitle("__**AGNELLO FC 7v7 FRIENDLY**__").setDescription(buildDesc()).setColor(0x0099ff).setFooter({ text: "React to claim a position" });

  const sent = await message.channel.send({ content: "@everyone", embeds: [embed] });
  for (const e of emojis) await sent.react(e);

  const filter = (reaction, user) => emojis.includes(reaction.emoji.name) && !user.bot;
  const collector = sent.createReactionCollector({ filter, time: 10 * 60 * 1000, dispose: true });

  collector.on("collect", async (reaction, user) => {
    try {
      const idx = emojis.indexOf(reaction.emoji.name);
      // if user already has a claim, remove their previous claim
      if (userClaim[user.id] !== undefined && userClaim[user.id] !== idx) {
        const previousIndex = userClaim[user.id];
        claimed[previousIndex] = null;
        userClaim[user.id] = undefined;
      }
      // if already claimed by someone else
      if (claimed[idx] && claimed[idx] !== user.id) {
        // remove reaction (they tried to take already-claimed spot)
        await reaction.users.remove(user.id);
        await message.channel.send(`${user}, that position is already claimed.`);
        return;
      }
      // assign
      claimed[idx] = user.id;
      userClaim[user.id] = idx;
      safeLogToChannel(message.guild, "Hostfriendly Claim", `${user.tag} claimed ${positions[idx]}`, message.guild);
      // update embed
      await sent.edit({ embeds: [embed.setDescription(buildDesc())] });
      await message.channel.send(`✅ ${positions[idx]} confirmed for <@${user.id}>`);
      // check if all filled
      if (claimed.every((c) => c)) {
        const final = positions.map((p, i) => `${p}: <@${claimed[i]}>`).join("\n");
        await message.channel.send("**FINAL LINEUP:**\n" + final);
        collector.stop("filled");
      }
    } catch (e) {
      console.error("hostfriendly collect:", e);
    }
  });

  collector.on("remove", async (reaction, user) => {
    try {
      const idx = emojis.indexOf(reaction.emoji.name);
      if (claimed[idx] === user.id) {
        claimed[idx] = null;
        delete userClaim[user.id];
        await sent.edit({ embeds: [embed.setDescription(buildDesc())] });
        safeLogToChannel(message.guild, "Hostfriendly Unclaim", `${user.tag} unclaimed ${positions[idx]}`, message.guild);
      }
    } catch (e) {
      console.error("hostfriendly remove:", e);
    }
  });

  collector.on("end", (collected, reason) => {
    safeLogToChannel(message.guild, "Hostfriendly Ended", `Ended by ${reason}`, message.guild);
  });

  // Save session in memory in case you want to reference later
  client.hostfriendlies.set(sent.id, { message: sent, positions, claimed });
}

// ---------- Activity Check ----------
async function startActivityCheck(channel, author, goal = 40) {
  const embed = new EmbedBuilder()
    .setTitle("__**AGNELLO FC Activity Check**__")
    .setDescription(`**React with:** ✅\n**Goal:** ${goal}\n**Duration:** 1 Day\n@everyone`)
    .setColor(0x00ff00)
    .setFooter({ text: `Started by ${author.tag}` })
    .setTimestamp();

  const sent = await channel.send({ content: "@everyone", embeds: [embed] });
  await sent.react("✅");

  const filter = (reaction, user) => reaction.emoji.name === "✅" && !user.bot;
  const collector = sent.createReactionCollector({ filter, time: 24 * 60 * 60 * 1000 });

  collector.on("collect", (r) => {
    const count = r.count - 1; // subtract bot
    if (count >= goal) {
      channel.send(`🎉 Activity Check goal reached (${count}/${goal})`);
      safeLogToChannel(channel.guild, "Activity Check", `Goal reached: ${count}/${goal}`, channel.guild);
      collector.stop("goal reached");
    }
  });

  collector.on("end", (_, reason) => {
    if (reason !== "goal reached") safeLogToChannel(channel.guild, "Activity Check Ended", `Ended: ${reason}`, channel.guild);
  });
}

// ---------- Auto-React to @everyone / @here ----------
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  try {
    // message.mentions.has(message.guild.roles.everyone) is not directly supported; check content
    if (message.mentions.everyone || message.content.includes("@here")) {
      await message.react("✅").catch(() => {});
    }
  } catch (e) {
    // ignore
  }
});

// ---------- Simple text swear filter (deletes and warns) ----------
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  const lc = message.content.toLowerCase();
  for (const w of swears) {
    if (w && lc.includes(w)) {
      try {
        await message.delete().catch(() => {});
      } catch {}
      message.channel.send(`${message.author}, watch your language.`).catch(() => {});
      safeLogToChannel(message.guild, "Swear (text)", `${message.author.tag} said: ${w}`, message.guild);
      break;
    }
  }
});

// ---------- Safe Voice Join Wrapper ----------
async function safeJoinVoiceChannel(options) {
  if (!ENABLE_VOICE) throw new Error("Voice disabled");
  try {
    const conn = joinVoiceChannel(options);
    conn.on("error", (err) => console.error("Voice connection error:", err));
    // Wait ready if possible
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 15000);
    } catch (e) {
      // Could not enter ready state; return connection anyway
      console.error("Voice connection not ready:", e);
    }
    return conn;
  } catch (e) {
    console.error("safeJoinVoiceChannel failed:", e);
    throw e;
  }
}

// ---------- Graceful failure handlers ----------
process.on("unhandledRejection", (reason, p) => {
  console.error("Unhandled Rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught Exception:", err);
});

// ---------- Ready ----------
client.once("ready", () => {
  console.log(`Logged in as ${client.user.tag}`);
  console.log(`ENABLE_VOICE = ${ENABLE_VOICE}`);
  if (!ENABLE_VOICE) console.log("Voice disabled — to enable set ENABLE_VOICE=true on a UDP-enabled host");
  console.log("Bot ready.");
});

// ---------- Login ----------
if (!TOKEN) {
  console.error("ERROR: No bot token set in environment variable TOKEN");
  process.exit(1);
}
client.login(TOKEN);
