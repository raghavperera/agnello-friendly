// index.js (ES modules) - AGNELLO BOT (full)
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { spawn } from 'child_process';

import OpenAI from 'openai';
import prism from 'prism-media';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

import play from '@iamtraction/play-dl';

import {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  EmbedBuilder,
  PermissionsBitField,
  ActivityType,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle
} from 'discord.js';

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  VoiceConnectionStatus,
  AudioPlayerStatus,
  getVoiceConnection,
  EndBehaviorType,
  generateDependencyReport
} from '@discordjs/voice';

// ------------------- CONFIG -------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PREFIX = (process.env.PREFIX || '!').trim();
const OWNER_ID = process.env.OWNER_ID ?? null;
const KEEPALIVE_PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const DEFAULT_VC_ID = '1368359914145058956';
const TEMP_DIR = './temp';
const VOICEMOD_FILE = './voicemod.json';

if (!BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN missing in .env');
  process.exit(1);
}
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// ------------------- CLIENT -------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});
client.commands = new Collection();

// ------------------- OPENAI -------------------
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ------------------- STATE -------------------
function loadJson(file, fallback = {}) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('loadJson error', e); }
  return fallback;
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error('saveJson error', e); }
}
let voiceModState = loadJson(VOICEMOD_FILE, {});

// Ensure minimal voice mod config for a guild
function ensureGuildVoiceMod(guildId) {
  if (!voiceModState[guildId]) {
    voiceModState[guildId] = {
      enabled: false,
      channelId: null,
      modChannelId: null,
      strikeThreshold: 3,
      muteDurationSec: 300,
      swearList: [
        'fuck','shit','bitch','asshole','bastard','nigger','cunt','faggot'
      ],
      strikes: {}
    };
    saveJson(VOICEMOD_FILE, voiceModState);
  }
  return voiceModState[guildId];
}

// ------------------- HELPERS -------------------
function parseMention(mention) {
  if (!mention) return null;
  return mention.replace(/[<@!>]/g, '').trim();
}
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ------------------- TRANSCRIPTION: concurrency + retries -------------------
const MAX_CONCURRENT_TRANSCRIPTS = 2;
let activeTranscripts = 0;
const transcriptQueue = [];
function enqueueTranscription(task) {
  return new Promise((resolve, reject) => {
    transcriptQueue.push({ task, resolve, reject });
    processTranscriptQueue();
  });
}
function processTranscriptQueue() {
  if (activeTranscripts >= MAX_CONCURRENT_TRANSCRIPTS) return;
  const entry = transcriptQueue.shift();
  if (!entry) return;
  activeTranscripts++;
  entry.task()
    .then(r => { activeTranscripts--; entry.resolve(r); process.nextTick(processTranscriptQueue); })
    .catch(err => { activeTranscripts--; entry.reject(err); process.nextTick(processTranscriptQueue); });
}

async function transcribeFileWithOpenAI(filePath) {
  if (!openai) throw new Error('OpenAI not configured');
  const attemptTranscribe = async () => {
    const start = Date.now();
    const fileStream = fs.createReadStream(filePath);
    try {
      // Recommended: whisper-1 (change if you use another model)
      const resp = await openai.audio.transcriptions.create({ file: fileStream, model: 'whisper-1' });
      const dur = Date.now() - start;
      console.log(`[transcribe] success ${path.basename(filePath)} (${dur}ms)`);
      if (resp && (resp.text || resp.data?.text)) return resp.text ?? resp.data.text;
      if (typeof resp === 'string') return resp;
      return JSON.stringify(resp);
    } catch (err) {
      console.error('[transcribe] error', err?.message ?? err);
      throw err;
    } finally {
      try { fileStream.close?.(); } catch {}
    }
  };

  return enqueueTranscription(async () => {
    const MAX_RETRIES = 3;
    let attempt = 0;
    while (attempt < MAX_RETRIES) {
      attempt++;
      try { return await attemptTranscribe(); }
      catch (err) {
        const status = err?.status ?? err?.response?.status;
        if (status && status >= 400 && status < 500 && status !== 429) throw err;
        const backoffMs = 500 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
        console.warn(`[transcribe] attempt ${attempt} failed, backing off ${backoffMs}ms. err=${err?.message}`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
    throw new Error('Transcription failed after retries.');
  });
}

// ------------------- AUDIO RECORDING -------------------
function createTempFilePath(prefix = 'clip', ext = '.mp3') {
  const ts = Date.now();
  const rnd = Math.floor(Math.random() * 1e6);
  return path.join(TEMP_DIR, `${prefix}_${ts}_${rnd}${ext}`);
}
function checkProfanity(text, swearList) {
  if (!text) return { found: false, matches: [] };
  const lower = text.toLowerCase();
  const matches = [];
  for (const w of swearList) {
    const re = new RegExp(`\\b${escapeRegExp(w.toLowerCase())}\\b`, 'i');
    if (re.test(lower)) matches.push(w);
  }
  return { found: matches.length > 0, matches };
}
async function recordShortClip(connection, userId, maxDurationMs = 4000) {
  return new Promise((resolve, reject) => {
    try {
      const receiver = connection.receiver;
      const opusStream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 } });
      const decoded = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
      const outPath = createTempFilePath('clip', '.mp3');
      const ffmpegArgs = [
        '-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0',
        '-acodec', 'libmp3lame', '-b:a', '96k', '-y', outPath
      ];
      const ffmpeg = spawn(ffmpegInstaller.path || ffmpegInstaller, ffmpegArgs, { stdio: ['pipe', 'ignore', 'pipe'] });
      opusStream.pipe(decoded).pipe(ffmpeg.stdin);

      let finished = false;
      const maxTimeout = setTimeout(() => {
        if (finished) return;
        finished = true;
        try { opusStream.destroy(); } catch {}
        try { decoded.destroy(); } catch {}
        try { ffmpeg.stdin.end(); } catch {}
        setTimeout(() => resolve(outPath), 700);
      }, maxDurationMs);

      ffmpeg.on('close', () => {
        if (finished) return;
        finished = true;
        clearTimeout(maxTimeout);
        resolve(outPath);
      });

      opusStream.on('end', () => {
        if (finished) return;
        finished = true;
        clearTimeout(maxTimeout);
        try { ffmpeg.stdin.end(); } catch {}
        setTimeout(() => resolve(outPath), 700);
      });

      opusStream.on('error', (e) => {
        if (finished) return;
        finished = true;
        clearTimeout(maxTimeout);
        try { ffmpeg.stdin.end(); } catch {}
        reject(e);
      });

      ffmpeg.stderr.on('data', () => {}); // silent
    } catch (err) {
      reject(err);
    }
  });
}

// ------------------- VOICE MUTE -------------------
async function serverMuteMember(guild, userId, durationSec, reason = 'Voice moderation mute') {
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member || !member.voice) return false;
    await member.voice.setMute(true, reason).catch(() => {});
    setTimeout(async () => {
      try { const m = await guild.members.fetch(userId).catch(() => null); if (m && m.voice) await m.voice.setMute(false).catch(() => {}); } catch {}
    }, durationSec * 1000);
    return true;
  } catch (err) {
    console.error('serverMuteMember err', err);
    return false;
  }
}

// ------------------- VOICE MODERATION CORE -------------------
async function ensureConnectedToVoice(guild, channelId) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel || channel.type !== 2) throw new Error('Invalid voice channel');
  const conn = joinVoiceChannel({ channelId: channel.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false });
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5000)
      ]);
    } catch {
      try { conn.destroy(); } catch {}
    }
  });
  return conn;
}

function startVoiceModerationForGuild(guild, cfg) {
  ensureConnectedToVoice(guild, cfg.channelId).then(conn => {
    console.log(`Voice moderation started for guild ${guild.id} in ${cfg.channelId}`);
    conn.receiver.speaking.on('start', (userId) => {
      if (!userId || userId === client.user.id) return;
      conn.__processing = conn.__processing || {};
      if (conn.__processing[userId]) return;
      conn.__processing[userId] = true;

      (async () => {
        try {
          const clipPath = await recordShortClip(conn, userId, 4000).catch(e => { throw e; });
          if (!clipPath || !fs.existsSync(clipPath)) { delete conn.__processing[userId]; return; }
          let transcript = '';
          try {
            transcript = await transcribeFileWithOpenAI(clipPath);
          } catch (e) {
            console.error('transcribe failed', e);
            transcript = '';
          } finally {
            try { fs.unlinkSync(clipPath); } catch {}
          }
          const { found, matches } = checkProfanity(transcript, cfg.swearList || []);
          if (found) {
            cfg.strikes = cfg.strikes || {};
            cfg.strikes[userId] = (cfg.strikes[userId] || 0) + 1;
            saveJson(VOICEMOD_FILE, voiceModState);

            const strikeCount = cfg.strikes[userId];
            const modChannel = cfg.modChannelId ? guild.channels.cache.get(cfg.modChannelId) : null;
            const warnMsg = `⚠️ VoiceMod detected (${matches.join(', ')}) from <@${userId}>. Transcript: "${transcript || '(no transcript)'}". Strikes: ${strikeCount}/${cfg.strikeThreshold}`;

            if (modChannel && modChannel.isTextBased()) modChannel.send({ content: warnMsg }).catch(() => {});
            else {
              const fallback = guild.systemChannel ?? [...guild.channels.cache.values()].find(c => c.isTextBased && c.permissionsFor(guild.members.me).has('SendMessages'));
              if (fallback) fallback.send({ content: warnMsg }).catch(() => {});
            }

            try { const u = await client.users.fetch(userId); await u.send(`You used prohibited language in voice in ${guild.name}. Strike ${strikeCount}/${cfg.strikeThreshold}`).catch(() => {}); } catch {}

            if (strikeCount >= (cfg.strikeThreshold || 3)) {
              const muted = await serverMuteMember(guild, userId, cfg.muteDurationSec || 300, 'Exceeded profanity strikes');
              const actionMsg = muted ? `🔇 <@${userId}> muted for ${cfg.muteDurationSec || 300} seconds.` : `⚠️ Could not mute <@${userId}> (permissions)`;
              const ch = cfg.modChannelId ? guild.channels.cache.get(cfg.modChannelId) : null;
              if (ch && ch.isTextBased()) ch.send(actionMsg).catch(() => {});
            }
          }
        } catch (err) {
          console.error('voice processing error', err);
        } finally {
          delete conn.__processing[userId];
        }
      })();
    });
  }).catch(err => { console.error('startVoiceModerationForGuild error', err); });
}

function stopVoiceModerationForGuild(guildId) {
  try {
    const conn = getVoiceConnection(guildId);
    if (conn) conn.destroy();
  } catch (e) { console.error(e); }
}

// ------------------- MUSIC QUEUE -------------------
const queueMap = new Map();
function getGuildQueue(guildId) {
  if (!queueMap.has(guildId)) {
    const player = createAudioPlayer();
    queueMap.set(guildId, { connection: null, player, songs: [], playing: false, loop: false });
  }
  return queueMap.get(guildId);
}
async function connectToChannelAndSubscribe(guild, channelId) {
  const chan = guild.channels.cache.get(channelId);
  if (!chan || chan.type !== 2) throw new Error('Invalid voice channel');
  const conn = joinVoiceChannel({ channelId: chan.id, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false });
  conn.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(conn, VoiceConnectionStatus.Signalling, 5000),
        entersState(conn, VoiceConnectionStatus.Connecting, 5000)
      ]);
    } catch {
      try { conn.destroy(); } catch {}
    }
  });
  return conn;
}
async function playSong(guildId) {
  const q = getGuildQueue(guildId);
  if (!q.songs.length) { q.playing = false; return; }
  const next = q.songs[0];
  try {
    const stream = await play.stream(next.url, { quality: 2, discordPlayerCompatibility: true });
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    q.player.play(resource);
    q.playing = true;
    q.player.once(AudioPlayerStatus.Idle, () => {
      if (q.loop) q.songs.push(q.songs.shift()); else q.songs.shift();
      setTimeout(() => { if (q.songs.length) playSong(guildId).catch(console.error); else q.playing = false; }, 500);
    });
  } catch (err) {
    console.error('playSong error', err);
    q.songs.shift();
    setTimeout(() => { if (q.songs.length) playSong(guildId).catch(console.error); }, 500);
  }
}

// ------------------- HOSTFRIENDLY (reaction role) -------------------
const POSITIONS = ['GK','CB','CB2','CM','LW','RW','ST'];
const EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
const HOSTFRIENDLY_CACHE = {};

async function startHostFriendly({ channel, hostMember, hostPreclaim }) {
  const initialDesc = POSITIONS.map((p,i) => `${EMOJIS[i]} → **${p}**\n> open`).join('\n');
  const embed = new EmbedBuilder().setTitle('AGNELLO FC 7v7 FRIENDLY').setDescription(initialDesc).setColor(0x00FF00).setFooter({ text: 'React to claim a position. Only 1 position per user.' });
  const sent = await channel.send({ content: '@here', embeds: [embed] });

  for (const e of EMOJIS) {
    try { await sent.react(e); } catch (e) { console.warn('react failed', e); }
  }

  const claimMap = new Map();
  const userClaimMap = new Map();

  if (hostPreclaim) {
    const idx = POSITIONS.indexOf(hostPreclaim.toUpperCase());
    if (idx >= 0) { claimMap.set(EMOJIS[idx], hostMember.id); userClaimMap.set(hostMember.id, EMOJIS[idx]); }
  }

  async function updateEmbed() {
    const desc = POSITIONS.map((p,i) => {
      const owner = claimMap.get(EMOJIS[i]) ? `<@${claimMap.get(EMOJIS[i])}>` : 'open';
      return `${EMOJIS[i]} → **${p}**\n> ${owner}`;
    }).join('\n');
    const newEmbed = EmbedBuilder.from(embed).setDescription(desc);
    try { await sent.edit({ embeds: [newEmbed] }); } catch (e) { console.error('friendly edit failed', e); }
  }
  await updateEmbed();

  const filter = (reaction, user) => !user.bot && EMOJIS.includes(reaction.emoji.name);
  const collector = sent.createReactionCollector({ filter, time: 10*60*1000 });

  collector.on('collect', async (reaction, user) => {
    try {
      const em = reaction.emoji.name;
      const currentOwner = claimMap.get(em);
      if (currentOwner && currentOwner !== user.id) {
        try { await reaction.users.remove(user.id); } catch {}
        try { await user.send('That position is already taken.') } catch {}
        return;
      }
      if (userClaimMap.has(user.id)) {
        const prevEm = userClaimMap.get(user.id);
        if (prevEm !== em) {
          const prevReaction = sent.reactions.cache.get(prevEm);
          if (prevReaction) try { await prevReaction.users.remove(user.id); } catch {}
        }
      }
      claimMap.set(em, user.id);
      userClaimMap.set(user.id, em);
      await updateEmbed();
      const posIndex = EMOJIS.indexOf(em);
      if (posIndex >= 0) channel.send(`✅ ${POSITIONS[posIndex]} confirmed for <@${user.id}>`);
      const allFilled = POSITIONS.every((p,i) => claimMap.get(EMOJIS[i]));
      if (allFilled) {
        const final = POSITIONS.map((p,i) => `${p}: <@${claimMap.get(EMOJIS[i])}>`).join('\n');
        channel.send(`✅ All positions filled! Final lineup:\n${final}`);
        collector.stop('filled');
      }
    } catch (err) { console.error('friendly collect err', err); }
  });

  collector.on('remove', async (reaction, user) => {
    try {
      const em = reaction.emoji.name;
      const owner = claimMap.get(em);
      if (owner === user.id) { claimMap.delete(em); userClaimMap.delete(user.id); await updateEmbed(); }
    } catch (err) { console.error('friendly remove err', err); }
  });

  collector.on('end', (collected, reason) => {
    if (reason !== 'filled') {
      const filledCount = [...claimMap.values()].filter(Boolean).length;
      if (filledCount < 7) channel.send('⚠️ Friendly cancelled — not enough players after 10 minutes.');
    }
    try { delete HOSTFRIENDLY_CACHE[sent.id]; } catch {}
  });

  HOSTFRIENDLY_CACHE[sent.id] = { sent, claimMap, userClaimMap, hostId: hostMember.id, channelId: channel.id };

  const hostId = hostMember.id;
  const linkWatcher = (m) => {
    if (m.author.id !== hostId) return;
    if (m.channel.id !== channel.id) return;
    if (!m.content.includes('http')) return;
    const players = [...claimMap.values()].filter(Boolean);
    for (const uid of players) {
      try { client.users.fetch(uid).then(u => u.send(`Here’s the friendly link: ${m.content}`).catch(() => {})).catch(() => {}); } catch {}
    }
    client.off('messageCreate', linkWatcher);
  };
  client.on('messageCreate', linkWatcher);
  return sent;
}

// ------------------- PREFIX COMMANDS (messageCreate) -------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = message.content.trim();
  if (!content.startsWith(PREFIX)) return;
  const args = content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  // === moderation: purge/kick/ban/unban ===
  if (cmd === 'purge') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return message.reply('No permission.');
    const amount = parseInt(args[0],10);
    if (!amount || amount < 1 || amount > 100) return message.reply('Provide number 1-100.');
    try {
      const deleted = await message.channel.bulkDelete(amount, true);
      const c = await message.channel.send(`✅ Deleted ${deleted.size} messages.`);
      setTimeout(() => c.delete().catch(()=>{}), 5000);
    } catch (e) { console.error('purge', e); message.reply('Could not bulk delete (maybe messages older than 14 days).'); }
    return;
  }

  if (cmd === 'kick') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('No permission.');
    const target = args[0]; if (!target) return message.reply('Mention or ID required.');
    const id = parseMention(target) ?? target;
    const reason = args.slice(1).join(' ') || 'No reason';
    try {
      const member = await message.guild.members.fetch(id).catch(() => null);
      if (!member) return message.reply('Member not found.');
      if (!member.kickable) return message.reply('Cannot kick (role hierarchy).');
      await member.kick(reason);
      message.channel.send(`✅ Kicked ${member.user.tag} • ${reason}`);
    } catch (e) { console.error('kick', e); message.reply('Failed to kick.'); }
    return;
  }

  if (cmd === 'ban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('No permission.');
    const target = args[0]; if (!target) return message.reply('Mention or ID required.');
    const id = parseMention(target) ?? target;
    const reason = args.slice(1).join(' ') || 'No reason';
    try {
      await message.guild.bans.create(id, { reason });
      message.channel.send(`✅ Banned <@${id}> • ${reason}`);
    } catch (e) { console.error('ban', e); message.reply('Failed to ban (maybe invalid ID).'); }
    return;
  }

  if (cmd === 'unban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('No permission.');
    const id = args[0]; if (!id) return message.reply('Provide user ID to unban.');
    try {
      const bans = await message.guild.bans.fetch();
      if (!bans.has(id)) return message.reply('User not banned.');
      await message.guild.members.unban(id);
      message.channel.send(`✅ Unbanned <@${id}>`);
    } catch (e) { console.error('unban', e); message.reply('Failed to unban.'); }
    return;
  }

  // === dmrole ===
  if (cmd === 'dmrole') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageRoles) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('No permission.');
    const roleArg = args.shift(); if (!roleArg) return message.reply('Usage: !dmrole <role> <message>');
    const roleId = parseMention(roleArg) ?? roleArg.replace(/[<>@&]/g, '');
    const role = message.guild.roles.cache.get(roleId); if (!role) return message.reply('Role not found.');
    const dmMessage = args.join(' '); if (!dmMessage) return message.reply('Provide a message.');
    const members = role.members.map(m => m);
    const failed = [];
    for (const m of members) {
      if (m.user.bot) continue;
      try { await m.send(dmMessage); } catch { failed.push(`${m.user.tag} (${m.id})`); }
      await new Promise(r => setTimeout(r, 300));
    }
    try { await message.author.send(`DM Role summary: sent ${members.length - failed.length}, failed ${failed.length}`); message.channel.send('✅ Done — summary sent to your DMs.'); }
    catch { message.channel.send('✅ Done — could not DM you the summary.'); }
    return;
  }

  // === activity ===
  if (cmd === 'activity') {
    const goal = parseInt(args[0],10) || 40;
    const dur = parseFloat(args[1]) || 24;
    const emoji = args[2] || '✅';
    const embed = new EmbedBuilder().setTitle('*AGNELLO FC Activity Check*').setDescription(`**React with:** ${emoji}\n**Goal:** ${goal}\n**Duration:** ${dur} hour(s)\n@everyone`).setColor(0x5865F2);
    const m = await message.channel.send({ content: '@everyone', embeds: [embed] });
    try { await m.react(emoji); } catch {}
    return;
  }

  // === joinvc ===
  if (cmd === 'joinvc') {
    const target = args[0] ?? DEFAULT_VC_ID;
    try {
      const conn = await connectToChannelAndSubscribe(message.guild, target);
      const q = getGuildQueue(message.guild.id); q.connection = conn; q.connection.subscribe(q.player);
      message.reply(`✅ Joined <#${target}>`);
      try { if (message.guild.members.me && message.guild.members.me.voice) await message.guild.members.me.voice.setMute(true); } catch {}
    } catch (e) { console.error('joinvc', e); message.reply('Failed to join voice.'); }
    return;
  }

  // === music ===
  if (cmd === 'play') {
    const query = args.join(' '); if (!query) return message.reply('Provide URL or search term.');
    const memberVoice = message.member.voice.channel; if (!memberVoice) return message.reply('You must be in a voice channel.');
    try {
      const q = getGuildQueue(message.guild.id);
      if (!q.connection) { q.connection = await connectToChannelAndSubscribe(message.guild, memberVoice.id); q.connection.subscribe(q.player); }
      if (play.yt_validate(query)) {
        const info = await play.video_info(query);
        q.songs.push({ title: info.video_details.title, url: info.video_details.url, requestedBy: message.author.id });
      } else {
        const results = await play.search(query, { limit: 1 });
        if (!results.length) return message.reply('No results found.');
        const track = results[0];
        q.songs.push({ title: track.name, url: track.url, requestedBy: message.author.id });
      }
      message.channel.send(`✅ Queued: **${q.songs[q.songs.length-1].title}**`);
      if (!q.playing) await playSong(message.guild.id);
    } catch (e) { console.error('play', e); message.reply('Error trying to play.'); }
    return;
  }

  if (cmd === 'skip') {
    const q = getGuildQueue(message.guild.id); if (!q.playing) return message.reply('Nothing playing.');
    q.player.stop(); message.reply('⏭ Skipped.'); return;
  }

  if (cmd === 'stop') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && message.author.id !== OWNER_ID) return message.reply('No permission.');
    const q = getGuildQueue(message.guild.id); q.player.stop(); if (q.connection) try { q.connection.destroy(); } catch {} q.connection = null; q.songs = []; q.playing = false; message.reply('⏹ Stopped and cleared queue.'); return;
  }

  if (cmd === 'queue') {
    const q = getGuildQueue(message.guild.id); if (!q.songs.length) return message.reply('Queue empty.');
    const list = q.songs.map((s,i) => `${i===0?'▶':`${i}.`} ${s.title} (requested by <@${s.requestedBy}>)`).slice(0,15).join('\n');
    const embed = new EmbedBuilder().setTitle('Music Queue').setDescription(list).setFooter({ text: `Total queued: ${q.songs.length}` });
    message.channel.send({ embeds: [embed] }); return;
  }

  // === hostfriendly prefix ===
  if (cmd === 'hostfriendly') {
    const friendliesRole = message.guild.roles.cache.find(r => r.name.toLowerCase().includes('friendlies'));
    const allowed = message.member.permissions.has(PermissionsBitField.Flags.Administrator) || (friendliesRole && message.member.roles.cache.has(friendliesRole.id));
    if (!allowed) return message.reply('You must be Admin or in Friendlies Department to host a friendly.');
    const hostPos = args[0] ? args[0].toUpperCase() : null;
    await startHostFriendly({ channel: message.channel, hostMember: message.member, hostPreclaim: hostPos });
    return;
  }

  // === voicemod prefix group ===
  if (cmd === 'voicemod') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator) && !message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return message.reply('No permission.');
    const sub = (args[0] || '').toLowerCase();
    const cfg = ensureGuildVoiceMod(message.guild.id);
    if (sub === 'enable') {
      const channelArg = args[1] ?? cfg.channelId ?? DEFAULT_VC_ID;
      cfg.enabled = true; cfg.channelId = channelArg; cfg.modChannelId = cfg.modChannelId ?? message.channel.id; saveJson(VOICEMOD_FILE, voiceModState);
      message.reply(`✅ Voice moderation enabled for <#${cfg.channelId}>`);
      startVoiceModerationForGuild(message.guild, cfg);
      return;
    }
    if (sub === 'disable') { cfg.enabled = false; saveJson(VOICEMOD_FILE, voiceModState); stopVoiceModerationForGuild(message.guild.id); message.reply('✅ Voice moderation disabled.'); return; }
    if (sub === 'channel') { const ch = args[1]; if (!ch) return message.reply('Usage: !voicemod channel <voiceChannelId>'); cfg.channelId = ch; saveJson(VOICEMOD_FILE, voiceModState); message.reply(`✅ Channel set to <#${ch}>`); return; }
    if (sub === 'modchannel') { const ch = args[1]; if (!ch) return message.reply('Usage: !voicemod modchannel <textChannelId>'); cfg.modChannelId = ch; saveJson(VOICEMOD_FILE, voiceModState); message.reply(`✅ Mod log channel set to <#${ch}>`); return; }
    if (sub === 'addswear') { const w = args[1]; if (!w) return message.reply('Usage: !voicemod addswear <word>'); if (!cfg.swearList.includes(w.toLowerCase())) cfg.swearList.push(w.toLowerCase()); saveJson(VOICEMOD_FILE, voiceModState); message.reply(`✅ Added ${w}`); return; }
    if (sub === 'removeswear') { const w = args[1]; if (!w) return message.reply('Usage: !voicemod removeswear <word>'); cfg.swearList = cfg.swearList.filter(s => s.toLowerCase() !== w.toLowerCase()); saveJson(VOICEMOD_FILE, voiceModState); message.reply(`✅ Removed ${w}`); return; }
    if (sub === 'listswears') { message.reply(`Swear list: ${cfg.swearList.join(', ')}`); return; }
    if (sub === 'setthreshold') { const n = parseInt(args[1],10); if (!n) return message.reply('Usage: !voicemod setthreshold <n>'); cfg.strikeThreshold = n; saveJson(VOICEMOD_FILE, voiceModState); message.reply(`✅ Set threshold to ${n}`); return; }
    if (sub === 'setmuteduration') { const n = parseInt(args[1],10); if (!n) return message.reply('Usage: !voicemod setmuteduration <seconds>'); cfg.muteDurationSec = n; saveJson(VOICEMOD_FILE, voiceModState); message.reply(`✅ Set mute duration to ${n}s`); return; }
    if (sub === 'strikes') { const t = args[1]; if (!t) return message.reply('Usage: !voicemod strikes <user>'); const id = parseMention(t) ?? t; const count = cfg.strikes[id] || 0; message.reply(`Strikes for <@${id}>: ${count}/${cfg.strikeThreshold}`); return; }
    if (sub === 'resetstrikes') { const t = args[1]; if (!t) return message.reply('Usage: !voicemod resetstrikes <user>'); const id = parseMention(t) ?? t; if (cfg.strikes[id]) delete cfg.strikes[id]; saveJson(VOICEMOD_FILE, voiceModState); message.reply(`✅ Reset strikes for <@${id}>`); return; }
    message.reply('voicemod subcommands: enable|disable|channel|modchannel|addswear|removeswear|listswears|setthreshold|setmuteduration|strikes|resetstrikes');
    return;
  }

});

// ------------------- SLASH COMMANDS REGISTER -------------------
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  const commands = [
    new SlashCommandBuilder().setName('hostfriendly').setDescription('Start a 7v7 friendly').addStringOption(o => o.setName('position').setDescription('Pre-claim position GK/CB/CB2/CM/LW/RW/ST')).addChannelOption(o => o.setName('channel').setDescription('Channel to post in')),
    new SlashCommandBuilder().setName('play').setDescription('Play a track').addStringOption(o => o.setName('query').setDescription('URL or search').setRequired(true)),
    new SlashCommandBuilder().setName('skip').setDescription('Skip track'),
    new SlashCommandBuilder().setName('stop').setDescription('Stop and clear queue'),
    new SlashCommandBuilder().setName('queue').setDescription('Show queue'),
    new SlashCommandBuilder().setName('joinvc').setDescription('Join a voice channel').addChannelOption(o => o.setName('channel').setDescription('Voice channel')),
    new SlashCommandBuilder().setName('purge').setDescription('Bulk delete messages').addIntegerOption(o => o.setName('amount').setDescription('1-100').setRequired(true)).setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    new SlashCommandBuilder().setName('kick').setDescription('Kick member').addUserOption(o => o.setName('user').setRequired(true)).addStringOption(o => o.setName('reason')),
    new SlashCommandBuilder().setName('ban').setDescription('Ban user by id or user option').addStringOption(o => o.setName('id')).addUserOption(o => o.setName('user')).addStringOption(o => o.setName('reason')),
    new SlashCommandBuilder().setName('unban').setDescription('Unban by ID').addStringOption(o => o.setName('id').setRequired(true)),
    new SlashCommandBuilder().setName('dmrole').setDescription('DM everyone in role').addRoleOption(o => o.setName('role').setRequired(true)).addStringOption(o => o.setName('message').setRequired(true)),
    new SlashCommandBuilder().setName('help').setDescription('Show command list')
  ].map(c => c.toJSON());

  try {
    console.log('Registering slash commands...');
    const guildIds = client.guilds.cache.map(g => g.id);
    for (const gid of guildIds) {
      await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: commands });
      console.log('Registered in', gid);
    }
  } catch (err) {
    console.error('Slash register error', err);
  }
}

// ------------------- INTERACTION HANDLING -------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const cmd = interaction.commandName;

  if (cmd === 'hostfriendly') {
    const position = interaction.options.getString('position');
    const channelOpt = interaction.options.getChannel('channel') ?? interaction.channel;
    const member = interaction.member;
    const guild = interaction.guild;
    const friendliesRole = guild.roles.cache.find(r => r.name.toLowerCase().includes('friendlies'));
    const allowed = member.permissions.has(PermissionsBitField.Flags.Administrator) || (friendliesRole && member.roles.cache.has(friendliesRole.id));
    if (!allowed) return interaction.reply({ content: 'You must be Admin or Friendlies Dept to host.', ephemeral: true });
    await interaction.reply({ content: 'Starting friendly...', ephemeral: true });
    try {
      await startHostFriendly({ channel: channelOpt, hostMember: interaction.member, hostPreclaim: position });
      return interaction.followUp({ content: 'Friendly posted.', ephemeral: true });
    } catch (e) {
      console.error('slash hostfriendly', e);
      return interaction.followUp({ content: 'Failed to start friendly.', ephemeral: true });
    }
  }

  if (cmd === 'play') {
    const query = interaction.options.getString('query', true);
    const memberVoice = interaction.member.voice.channel;
    if (!memberVoice) return interaction.reply({ content: 'You must be in a voice channel.', ephemeral: true });
    await interaction.deferReply();
    try {
      const q = getGuildQueue(interaction.guild.id);
      if (!q.connection) {
        q.connection = await connectToChannelAndSubscribe(interaction.guild, memberVoice.id);
        q.connection.subscribe(q.player);
      }
      if (play.yt_validate(query)) {
        const info = await play.video_info(query);
        q.songs.push({ title: info.video_details.title, url: info.video_details.url, requestedBy: interaction.user.id });
      } else {
        const results = await play.search(query, { limit: 1 });
        if (!results.length) return interaction.followUp({ content: 'No results found.' });
        const track = results[0];
        q.songs.push({ title: track.name, url: track.url, requestedBy: interaction.user.id });
      }
      interaction.followUp({ content: `✅ Queued: **${q.songs[q.songs.length-1].title}**` });
      if (!q.playing) await playSong(interaction.guild.id);
    } catch (e) { console.error('slash play', e); interaction.followUp({ content: 'Error trying to play.' }); }
    return;
  }

  if (cmd === 'skip') {
    const q = getGuildQueue(interaction.guild.id); if (!q.playing) return interaction.reply({ content: 'Nothing playing.', ephemeral: true }); q.player.stop(); return interaction.reply({ content: '⏭ Skipped.' });
  }

  if (cmd === 'stop') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageGuild) && interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'No permission.', ephemeral: true });
    const q = getGuildQueue(interaction.guild.id); q.player.stop(); if (q.connection) try { q.connection.destroy(); } catch {} q.connection = null; q.songs = []; q.playing = false; return interaction.reply({ content: '⏹ Stopped and cleared queue.' });
  }

  if (cmd === 'queue') {
    const q = getGuildQueue(interaction.guild.id); if (!q.songs.length) return interaction.reply({ content: 'Queue empty.', ephemeral: true });
    const list = q.songs.map((s,i) => `${i===0?'▶':`${i}.`} ${s.title} (requested by <@${s.requestedBy}>)`).slice(0,15).join('\n');
    const embed = new EmbedBuilder().setTitle('Music Queue').setDescription(list).setFooter({ text: `Total queued: ${q.songs.length}` });
    return interaction.reply({ embeds: [embed] });
  }

  if (cmd === 'joinvc') {
    const channelOpt = interaction.options.getChannel('channel') ?? interaction.member.voice.channel ?? interaction.guild.channels.cache.get(DEFAULT_VC_ID);
    if (!channelOpt) return interaction.reply({ content: 'No voice channel provided or found.', ephemeral: true });
    try {
      const conn = await connectToChannelAndSubscribe(interaction.guild, channelOpt.id);
      const q = getGuildQueue(interaction.guild.id); q.connection = conn; q.connection.subscribe(q.player);
      await interaction.reply({ content: `✅ Joined <#${channelOpt.id}>` });
    } catch (e) { console.error('joinvc slash', e); interaction.reply({ content: 'Failed to join voice channel.', ephemeral: true }); }
    return;
  }

  if (cmd === 'purge') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return interaction.reply({ content: 'No permission.', ephemeral: true });
    const amount = interaction.options.getInteger('amount');
    try {
      const deleted = await interaction.channel.bulkDelete(amount, true);
      return interaction.reply({ content: `✅ Deleted ${deleted.size} messages.`, ephemeral: true });
    } catch (e) { console.error('purge slash', e); return interaction.reply({ content: 'Failed to bulk delete.', ephemeral: true }); }
  }

  if (cmd === 'kick') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return interaction.reply({ content: 'No permission.', ephemeral: true });
    const user = interaction.options.getUser('user'); const reason = interaction.options.getString('reason') ?? 'No reason';
    try {
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return interaction.reply({ content: 'Member not found.', ephemeral: true });
      if (!member.kickable) return interaction.reply({ content: 'Cannot kick (role).', ephemeral: true });
      await member.kick(reason); return interaction.reply({ content: `✅ Kicked ${user.tag} • ${reason}` });
    } catch (e) { console.error('slash kick', e); return interaction.reply({ content: 'Failed to kick.', ephemeral: true }); }
  }

  if (cmd === 'ban') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return interaction.reply({ content: 'No permission.', ephemeral: true });
    const id = interaction.options.getString('id') ?? interaction.options.getUser('user')?.id; const reason = interaction.options.getString('reason') ?? 'No reason';
    if (!id) return interaction.reply({ content: 'Provide user ID or user.', ephemeral: true });
    try { await interaction.guild.bans.create(id, { reason }); return interaction.reply({ content: `✅ Banned <@${id}> • ${reason}` }); } catch (e) { console.error('slash ban', e); return interaction.reply({ content: 'Failed to ban.', ephemeral: true }); }
  }

  if (cmd === 'unban') {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return interaction.reply({ content: 'No permission.', ephemeral: true });
    const id = interaction.options.getString('id');
    try { const bans = await interaction.guild.bans.fetch(); if (!bans.has(id)) return interaction.reply({ content: 'User not banned.', ephemeral: true }); await interaction.guild.members.unban(id); return interaction.reply({ content: `✅ Unbanned <@${id}>` }); } catch (e) { console.error('slash unban', e); return interaction.reply({ content: 'Failed to unban.', ephemeral: true }); }
  }

  if (cmd === 'dmrole') {
    if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles) && !interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return interaction.reply({ content: 'No permission.', ephemeral: true });
    const role = interaction.options.getRole('role'); const messageText = interaction.options.getString('message');
    await interaction.deferReply({ ephemeral: true });
    const members = role.members.map(m => m);
    const failed = [];
    for (const m of members) {
      if (m.user.bot) continue;
      try { await m.send(messageText); } catch { failed.push(`${m.user.tag} (${m.id})`); }
      await new Promise(r => setTimeout(r, 300));
    }
    try { await interaction.user.send(`DM Role summary for ${role.name}: sent ${members.length - failed.length}, failed ${failed.length}`); await interaction.followUp({ content: '✅ Done — summary sent to your DMs.', ephemeral: true }); } catch { await interaction.followUp({ content: '✅ Done — could not DM you the summary.', ephemeral: true }); }
    return;
  }

  if (cmd === 'help') {
    const embed = new EmbedBuilder()
      .setTitle('Agnello Bot — Command List')
      .setDescription('Prefix: `!`  •  Use slash commands for many features')
      .addFields(
        { name: 'Music', value: '`/play` `/skip` `/stop` `/queue` `/joinvc`', inline: true },
        { name: 'Friendlies', value: '`/hostfriendly` or `!hostfriendly`', inline: true },
        { name: 'Moderation', value: '`/purge` `!kick` `!ban` `/unban`', inline: false },
        { name: 'VoiceMod', value: '`!voicemod enable|disable|addswear|listswears|setthreshold|setmuteduration`', inline: false },
        { name: 'Role DM', value: '`/dmrole` or `!dmrole`', inline: false }
      )
      .setFooter({ text: 'Make sure bot has the necessary permissions for each command.' });
    return interaction.reply({ embeds: [embed], ephemeral: false });
  }

});
async function transcribeWithRetry(filePath, maxRetries = 3) {
  let attempt = 0;
  const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  while (attempt < maxRetries) {
    try {
      const transcript = await transcribeFile(filePath);
      return transcript;
    } catch (error) {
      attempt++;
      if (attempt < maxRetries) {
        const backoffTime = Math.pow(2, attempt) * 1000; // Exponential backoff
        console.log(`Attempt ${attempt} failed. Retrying in ${backoffTime}ms...`);
        await delay(backoffTime);
      } else {
        console.error('Max retries reached. Transcription failed.');
        throw error;
      }
    }
  }
}

// ------------------- READY -------------------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { console.log('Voice dependency report:\n', generateDependencyReport()); } catch (e) { console.warn('generateDependencyReport failed', e); }

  // start voicemod for enabled guilds
  for (const [gid, cfg] of Object.entries(voiceModState)) {
    if (cfg.enabled && cfg.channelId) {
      const guild = client.guilds.cache.get(gid);
      if (guild) startVoiceModerationForGuild(guild, cfg);
    }
  }

  // register slash commands per guild
  await registerSlashCommands().catch(err => console.error('slash register failed', err));

  client.user.setActivity('Agnello FC', { type: ActivityType.Playing });
});

// ------------------- error handling -------------------
process.on('unhandledRejection', err => { console.error('Unhandled Rejection', err); });
process.on('uncaughtException', err => { console.error('Uncaught Exception', err); });

// ------------------- KEEPALIVE -------------------
const app = express();
app.get('/', (req, res) => res.send('Agnello bot running'));
app.listen(KEEPALIVE_PORT, () => console.log('Keepalive on', KEEPALIVE_PORT));

// ------------------- LOGIN -------------------
client.login(BOT_TOKEN);
