// index.js - Agnello FC all-in-one bot with Voice Moderation (ES module)
// NOTE: This file builds on the previous template (music, hostfriendly, dmrole, moderation).
// Voice moderation: records short audio chunks, transcribes with OpenAI, checks against swear list,
// increments strikes, warns and mutes on thresholds.

// Environment & imports
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import express from 'express';

import OpenAI from 'openai';
import prism from 'prism-media';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';

import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  Colors
} from 'discord.js';

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  EndBehaviorType,
  getVoiceConnection
} from '@discordjs/voice';

// -------------------- BASIC CONFIG --------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!BOT_TOKEN) {
  console.error('BOT_TOKEN missing in env.');
  process.exit(1);
}
if (!OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY not found. Voice moderation will not work without it.');
}

const PREFIX = process.env.PREFIX ?? '!';
const OWNER_ID = process.env.OWNER_ID ?? null;
const KEEPALIVE_PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const DEFAULT_VC_ID = '1368359914145058956';
const TEMP_DIR = './temp';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// -------------------- OpenAI client --------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// -------------------- Discord client --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

// -------------------- voice moderation persistent state --------------------
// voicemod.json structure:
// {
//   "<guildId>": {
//     enabled: true/false,
//     channelId: "voiceChannelId",
//     modChannelId: "textChannelToLogTo",
//     strikeThreshold: 3,
//     muteDurationSec: 300,
//     swearList: ["badword1","badword2"],
//     strikes: { "<userId>": 1, ... }
//   },
//   ...
// }

const STATE_FILE = './voicemod.json';
let voiceModState = {};
try {
  if (fs.existsSync(STATE_FILE)) {
    voiceModState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } else {
    voiceModState = {};
  }
} catch (err) {
  console.error('Failed to load voicemod state:', err);
  voiceModState = {};
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(voiceModState, null, 2));
  } catch (err) {
    console.error('Failed to save voicemod state:', err);
  }
}

function ensureGuildConfig(guildId) {
  if (!voiceModState[guildId]) {
    voiceModState[guildId] = {
      enabled: false,
      channelId: null,
      modChannelId: null,
      strikeThreshold: 3,
      muteDurationSec: 300,
      // initial basic swear list - extend as you want
      swearList: [
        'fuck','shit','bitch','asshole','bastard','nigger','cunt','faggot'
      ],
      strikes: {}
    };
    saveState();
  }
  return voiceModState[guildId];
}

// -------------------- helper functions --------------------
function parseMention(mention) {
  if (!mention) return null;
  return mention.replace(/[<@!>&#]/g, '').trim();
}

function isAdminOrManage(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has(PermissionsBitField.Flags.ManageGuild);
}

async function serverMuteMember(guild, userId, durationSec, reason = 'Voice moderation mute') {
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || !member.voice) return false;
    if (!member.voice.serverMute) {
      if (!member.moderatable && !member.manageable) {
        // try guildMember.voice.setMute
        await member.voice.setMute(true, reason).catch(() => {});
      } else {
        await member.voice.setMute(true, reason).catch(() => {});
      }
    }
    // schedule unmute
    setTimeout(async () => {
      try {
        const m = await guild.members.fetch(userId).catch(() => null);
        if (m && m.voice) {
          await m.voice.setMute(false).catch(() => {});
        }
      } catch (e) {}
    }, durationSec * 1000);
    return true;
  } catch (err) {
    console.error('serverMuteMember error', err);
    return false;
  }
}

// basic profanity check
function checkProfanity(text, swearList) {
  if (!text) return { found: false, matches: [] };
  const lower = text.toLowerCase();
  const matches = [];
  for (const w of swearList) {
    // word boundary check
    const re = new RegExp(`\\b${escapeRegExp(w.toLowerCase())}\\b`, 'i');
    if (re.test(lower)) matches.push(w);
  }
  return { found: matches.length > 0, matches };
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// -------------------- audio capture & transcription --------------------
/*
 Strategy:
 - When voice moderation enabled, bot should be joined to the target VC.
 - Use connection.receiver to subscribe to each user when they speak.
 - Pipe opus stream -> prism opus.Decoder -> ffmpeg (stdin) to produce an mp3 file.
 - Send mp3 file to OpenAI transcription, check transcript for swear words.
 - NOTE: Recording arbitrary users in a server has privacy implications. Only enable with consent.
*/

async function ensureConnectedToVoice(guild, channelId) {
  const chan = guild.channels.cache.get(channelId);
  if (!chan || chan.type !== 2) throw new Error('Invalid voice channel id');
  const conn = joinVoiceChannel({
    channelId: chan.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false // we want to hear to moderate; but we can deafen if you prefer
  });
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5_000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5_000)
      ]);
      // reconnected
    } catch {
      try { conn.destroy(); } catch {}
    }
  });
  return conn;
}

function createTempFilePath(prefix = 'clip', ext = '.mp3') {
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 1e6);
  return path.join(TEMP_DIR, `${prefix}_${ts}_${rnd}${ext}`);
}

async function transcribeFileWithOpenAI(filePath) {
  if (!OPENAI_API_KEY) throw new Error('OpenAI API key not configured.');
  // openai client from SDK v4: audio.transcriptions.create
  const fileStream = fs.createReadStream(filePath);
  try {
    const resp = await openai.audio.transcriptions.create({
      file: fileStream,
      model: 'gpt-4o-mini-transcribe' // or another available transcribe model; change if needed
    });
    // resp.text or resp?.text depends on SDK; common result: { text: "..." }
    if (resp && (resp.text || resp[ 'text' ])) {
      return resp.text ?? resp['text'];
    }
    // some SDKs return { data: { text: "..." } } - handle robustly:
    if (resp && resp.data && resp.data.text) return resp.data.text;
    // fallback: convert resp to string
    return String(resp);
  } catch (err) {
    console.error('OpenAI transcription error', err);
    throw err;
  } finally {
    try { fileStream.close?.(); } catch {}
  }
}

// record a short clip for the provided user in a connection
// returns path to mp3 file (caller should unlink after use)
function recordShortClip(connection, userId, maxDurationMs = 5000) {
  return new Promise((resolve, reject) => {
    try {
      const receiver = connection.receiver;
      const opusStream = receiver.subscribe(userId, {
        end: {
          behavior: EndBehaviorType.AfterSilence,
          duration: 1200
        }
      });

      // opus -> decode -> ffmpeg convert to mp3
      const decoded = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });

      const outPath = createTempFilePath('clip', '.mp3');

      // spawn ffmpeg to convert PCM s16le to mp3
      // we will pipe decoded PCM into ffmpeg stdin
      const ffmpegArgs = [
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        '-i', 'pipe:0',
        '-acodec', 'libmp3lame',
        '-b:a', '96k',
        '-y',
        outPath
      ];
      const ffmpeg = spawn(ffmpegPath.path || ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });

      ffmpeg.on('error', (err) => {
        console.error('ffmpeg spawn error', err);
      });

      // hook up pipeline
      opusStream.pipe(decoded).pipe(ffmpeg.stdin);

      let finished = false;

      // ensure we don't record forever
      const maxTimeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        // try to close streams
        try { opusStream.destroy(); } catch {}
        try { decoded.destroy(); } catch {}
        try { ffmpeg.stdin.end(); } catch {}
        // wait for ffmpeg to flush then resolve after a short delay
        setTimeout(() => resolve(outPath), 700);
      }, maxDurationMs);

      // if ffmpeg exits earlier, resolve
      ffmpeg.on('close', (code, sig) => {
        if (finished) return;
        finished = true;
        clearTimeout(maxTimeout);
        resolve(outPath);
      });

      // also capture stderr for debugging
      let stderr = '';
      ffmpeg.stderr.on('data', (d) => { stderr += d.toString(); });

      // if opus stream ends quickly, ensure ffmpeg closes soon
      opusStream.on('end', () => {
        if (finished) return;
        finished = true;
        clearTimeout(maxTimeout);
        try { ffmpeg.stdin.end(); } catch {}
        setTimeout(() => resolve(outPath), 700);
      });

      // if any error from streams
      opusStream.on('error', (e) => {
        if (finished) return;
        finished = true;
        clearTimeout(maxTimeout);
        try { ffmpeg.stdin.end(); } catch {}
        reject(e);
      });
    } catch (err) {
      reject(err);
    }
  });
}

// -------------------- voice moderation core flow --------------------
/*
  monitorSpeakers(connection, guild, config)
  - watch for when members start speaking in the voice channel
  - when a user speaks, record a short clip, transcribe, check for profanity, act accordingly
*/

function startVoiceModerationForGuild(guild, config) {
  // ensure connection exists / join
  ensureConnectedToVoice(guild, config.channelId).then((conn) => {
    console.log(`Voice moderation started for guild ${guild.id} in channel ${config.channelId}`);

    // listen to state changes: when speaking starts, we can subscribe
    conn.receiver.speaking.on('start', (userId) => {
      // userId is a Snowflake string
      if (!userId) return;
      if (userId === client.user.id) return; // ignore self

      // small throttle: don't process same user multiple times concurrently
      if (conn.__vm_processing && conn.__vm_processing[userId]) return;
      conn.__vm_processing = conn.__vm_processing || {};
      conn.__vm_processing[userId] = true;

      // record and process
      (async () => {
        try {
          const clipPath = await recordShortClip(conn, userId, 5000).catch(e => { throw e; });
          if (!clipPath || !fs.existsSync(clipPath)) {
            delete conn.__vm_processing[userId];
            return;
          }

          // transcribe with OpenAI
          let transcript = '';
          try {
            transcript = await transcribeFileWithOpenAI(clipPath);
          } catch (err) {
            console.error('transcribe failed', err);
            transcript = '';
          }

          // cleanup clip
          try { fs.unlinkSync(clipPath); } catch {}

          // evaluate profanity
          const { found, matches } = checkProfanity(transcript, config.swearList || []);
          if (found) {
            const modChannel = config.modChannelId ? guild.channels.cache.get(config.modChannelId) : null;
            const humanReadableMatches = matches.join(', ');
            // increment strike for user
            config.strikes = config.strikes || {};
            config.strikes[userId] = (config.strikes[userId] || 0) + 1;
            saveState();

            // compose message
            const userTag = `<@${userId}>`;
            const strikeCount = config.strikes[userId];
            const warnMsg = `⚠️ Voice moderation: detected prohibited language (${humanReadableMatches}) from ${userTag}. Transcript: "${transcript || '(no transcript)'}". Strikes: ${strikeCount}/${config.strikeThreshold}`;

            // send to mod channel if set else current text channel (fallback)
            if (modChannel && modChannel.isTextBased && modChannel.viewable) {
              modChannel.send({ content: warnMsg }).catch(() => {});
            } else {
              // fallback to default system channel or fetch a visible text channel
              const fallback = guild.systemChannel ?? [...guild.channels.cache.values()].find(c => c.isTextBased && c.permissionsFor(guild.members.me).has('SendMessages'));
              if (fallback) fallback.send({ content: warnMsg }).catch(() => {});
            }

            // DM the user a warning
            try {
              const u = await client.users.fetch(userId);
              await u.send(`You used prohibited language in voice in ${guild.name}. Please refrain. This is strike ${strikeCount}/${config.strikeThreshold}.`).catch(() => {});
            } catch (e) {}

            // if reached threshold, server-mute
            if (strikeCount >= (config.strikeThreshold || 3)) {
              const muted = await serverMuteMember(guild, userId, config.muteDurationSec || 300, 'Exceeded profanity strikes');
              const actionMsg = muted ? `🔇 ${userTag} has been muted for ${config.muteDurationSec || 300} seconds.` : `⚠️ Could not mute ${userTag} (permissions).`;
              if (modChannel && modChannel.isTextBased) modChannel.send(actionMsg).catch(() => {});
            }
          }
        } catch (err) {
          console.error('Error processing speech for user', userId, err);
        } finally {
          delete conn.__vm_processing[userId];
        }
      })();
    });
  }).catch((err) => {
    console.error('Failed to join voice channel for voice moderation', err);
  });
}

// stop voice moderation: destroy connection if exists
function stopVoiceModerationForGuild(guildId) {
  const gconf = voiceModState[guildId];
  if (!gconf || !gconf.channelId) return;
  try {
    const conn = getVoiceConnection(guildId);
    if (conn) {
      conn.destroy();
      console.log('Destroyed voice connection for guild', guildId);
    }
  } catch (e) {
    console.error('Error destroying voice connection', e);
  }
}

// Ensure moderation is running for guilds that have it enabled when bot starts/reconnects
client.on('ready', () => {
  for (const [guildId, cfg] of Object.entries(voiceModState)) {
    if (cfg.enabled && cfg.channelId) {
      const guild = client.guilds.cache.get(guildId);
      if (guild) {
        startVoiceModerationForGuild(guild, cfg);
      }
    }
  }
});

// -------------------- COMMAND HANDLING (adds voicemod commands) --------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = message.content.trim();
  if (!content.startsWith(PREFIX)) return;
  const args = content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();
  const guildId = message.guild.id;
  const cfg = ensureGuildConfig(guildId);

  // --- existing commands from your bot (music, hostfriendly, dmrole, purge, kick, ban, unban, joinvc) ---
  // For brevity, those earlier commands remain the same as in your prior index.js.
  // (Assume they are present above or combine with the earlier template.)

  // ---- Voice mod commands group: !voicemod ----
  if (command === 'voicemod') {
    if (!isAdminOrManage(message.member)) return message.reply('❌ You must be an Administrator or Manage Server to configure voice moderation.');

    const sub = (args[0] || '').toLowerCase();

    if (sub === 'enable') {
      cfg.enabled = true;
      // optional: first arg after enable may be voice channel id
      const channelArg = args[1] ?? cfg.channelId ?? DEFAULT_VC_ID;
      cfg.channelId = channelArg;
      cfg.modChannelId = cfg.modChannelId ?? message.channel.id;
      saveState();
      await message.reply(`✅ Voice moderation enabled for channel <#${cfg.channelId}>. Joining and monitoring...`);
      // join and start
      startVoiceModerationForGuild(message.guild, cfg);
      return;
    }

    if (sub === 'disable') {
      cfg.enabled = false;
      saveState();
      stopVoiceModerationForGuild(guildId);
      await message.reply('✅ Voice moderation disabled.');
      return;
    }

    if (sub === 'channel') {
      const chArg = args[1];
      if (!chArg) return message.reply('❌ Usage: !voicemod channel <voiceChannelId>');
      cfg.channelId = chArg;
      saveState();
      await message.reply(`✅ Voice moderation channel set to <#${chArg}>.`);
      return;
    }

    if (sub === 'modchannel') {
      const ch = args[1];
      if (!ch) return message.reply('❌ Usage: !voicemod modchannel <textChannelId>');
      cfg.modChannelId = ch;
      saveState();
      await message.reply(`✅ Moderation log channel set to <#${ch}>.`);
      return;
    }

    if (sub === 'addswear') {
      const w = (args[1] || '').toLowerCase();
      if (!w) return message.reply('❌ Usage: !voicemod addswear <word>');
      if (!cfg.swearList.includes(w)) cfg.swearList.push(w);
      saveState();
      return message.reply(`✅ Added "${w}" to swear list.`);
    }

    if (sub === 'removeswear') {
      const w = (args[1] || '').toLowerCase();
      if (!w) return message.reply('❌ Usage: !voicemod removeswear <word>');
      cfg.swearList = cfg.swearList.filter(s => s.toLowerCase() !== w);
      saveState();
      return message.reply(`✅ Removed "${w}" from swear list.`);
    }

    if (sub === 'listswears') {
      const list = cfg.swearList && cfg.swearList.length ? cfg.swearList.join(', ') : '(empty)';
      return message.reply(`Swear list (${cfg.swearList.length}): ${list}`);
    }

    if (sub === 'setthreshold') {
      const n = parseInt(args[1], 10);
      if (!n || n < 1) return message.reply('❌ Usage: !voicemod setthreshold <number>');
      cfg.strikeThreshold = n;
      saveState();
      return message.reply(`✅ Strike threshold set to ${n}.`);
    }

    if (sub === 'setmuteduration') {
      const n = parseInt(args[1], 10);
      if (!n || n < 1) return message.reply('❌ Usage: !voicemod setmuteduration <seconds>');
      cfg.muteDurationSec = n;
      saveState();
      return message.reply(`✅ Mute duration set to ${n} seconds.`);
    }

    if (sub === 'strikes') {
      const target = args[1];
      if (!target) return message.reply('❌ Usage: !voicemod strikes <userId|@user>');
      const id = parseMention(target) ?? target;
      const count = (cfg.strikes && cfg.strikes[id]) || 0;
      return message.reply(`Strikes for <@${id}>: ${count}/${cfg.strikeThreshold}`);
    }

    if (sub === 'resetstrikes') {
      const target = args[1];
      if (!target) return message.reply('❌ Usage: !voicemod resetstrikes <userId|@user>');
      const id = parseMention(target) ?? target;
      if (cfg.strikes && cfg.strikes[id]) {
        delete cfg.strikes[id];
        saveState();
      }
      return message.reply(`✅ Reset strikes for <@${id}>.`);
    }

    // fallback help
    const help = [
      '`!voicemod enable [voiceChannelId]` — enable monitoring (defaults to last set or default)',
      '`!voicemod disable` — disable monitoring',
      '`!voicemod channel <voiceChannelId>` — set voice channel',
      '`!voicemod modchannel <textChannelId>` — set where moderation messages are posted',
      '`!voicemod addswear <word>` / `removeswear <word>` / `listswears` — manage swear list',
      '`!voicemod setthreshold <n>` — strikes before mute',
      '`!voicemod setmuteduration <seconds>` — mute length',
      '`!voicemod strikes <user>` / `resetstrikes <user>` — view/reset strikes'
    ].join('\n');
    return message.reply(`VoiceMod commands:\n${help}`);
  }

  // -- other commands (music, hostfriendly, dmrole, purge, kick, ban, unban, joinvc) should exist below or above
});

// -------------------- process events & graceful exit --------------------
process.on('unhandledRejection', (err) => { console.error('UnhandledRejection', err); });
process.on('uncaughtException', (err) => { console.error('UncaughtException', err); });

// -------------------- express keepalive --------------------
const app = express();
app.get('/', (req, res) => res.send('Agnello-bot alive.'));
app.listen(KEEPALIVE_PORT, () => console.log('Keepalive on', KEEPALIVE_PORT));

// -------------------- login --------------------
client.login(BOT_TOKEN);
