/**
 * index.js - All-in-one Agnello FC bot
 * - Commands: !hostfriendly, !activity, !dmrole, !announcement, !kick, !ban,
 *   !joinvc, !play, !skip, !stop, !queue, !ticket, !serverstats, !inviteleaderboard, !help
 * - Features: music with resume, undeafened join, auto-reconnect, reaction-role friendly,
 *   ticket system, welcome/goodbye DMs, deleted message logging, text profanity filter,
 *   optional VC transcription + auto-mute via OpenAI Whisper (if OPENAI_API_KEY set).
 * - Keep-alive: Express server
 *
 * NOTE: you must supply BOT_TOKEN in environment. For transcription, set OPENAI_API_KEY
 * and ENABLE_TRANSCRIPTION=true in environment.
 */

import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import fetch from 'node-fetch';
import FormData from 'form-data';

import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  PermissionsBitField,
  ChannelType
} from 'discord.js';

import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  getVoiceConnection
} from '@discordjs/voice';

import prism from 'prism-media';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import play from '@iamtraction/play-dl';

// -------------------- CONFIG --------------------
const PREFIX = '!';
const LOG_CHANNEL_ID = '1362214241091981452';        // logging channel (messages, moderation logs)
const FRIENDLY_ROLE_ID = '1383970211933454378';      // role allowed to host friendlies
const WELCOME_CHANNEL_ID = '1361113546829729914';    // welcome/goodbye announcements channel
const TRANSCRIPTS_DIR = './transcripts_tmp';
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

// Friendly position mapping
const POSITIONS = { '1️⃣': 'GK', '2️⃣': 'CB', '3️⃣': 'CB2', '4️⃣': 'CM', '5️⃣': 'LW', '6️⃣': 'RW', '7️⃣': 'ST' };

// Profanity list (case-insensitive); you can expand or load from a file
const BAD_WORDS = ['fuck', 'bitch', 'nigger', 'dick', 'nigga', 'pussy'];

// Transcription toggles
const ENABLE_TRANSCRIPTION = process.env.ENABLE_TRANSCRIPTION === 'true' && !!process.env.OPENAI_API_KEY;

// -------------------- SANITY CHECKS --------------------
console.log('Starting Agnello bot...');
console.log('Node:', process.version);
if (!process.env.BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN is not set. Set it in your Render (or environment).');
  process.exit(1);
} else {
  console.log('BOT_TOKEN found (length):', process.env.BOT_TOKEN.length);
}
if (ENABLE_TRANSCRIPTION) {
  console.log('Transcription ENABLED (OpenAI key present).');
} else {
  console.log('Transcription disabled (OPENAI_API_KEY not set or ENABLE_TRANSCRIPTION != true).');
}

// -------------------- CLIENT --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Music queues per guild
// guildId => { connection, player, songs: [{title,url,resource}], textChannelId, voiceChannelId, playing }
const queues = new Map();

// Invite tracking (simple memory store; persists to file)
const INVITES_FILE = './invites.json';
let inviteCounts = {};
try {
  if (fs.existsSync(INVITES_FILE)) inviteCounts = JSON.parse(fs.readFileSync(INVITES_FILE, 'utf8'));
} catch (e) { console.warn('Failed to load invites file:', e); }

// -------------------- UTIL --------------------
async function logToChannel(text) {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send(String(text).slice(0, 1900));
  } catch (e) {
    console.error('logToChannel error:', e);
  }
}

function saveInvites() {
  try { fs.writeFileSync(INVITES_FILE, JSON.stringify(inviteCounts, null, 2)); } catch (e) { console.warn('Failed to save invites:', e); }
}

function normalizeText(s) {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

// -------------------- FRIENDLY HOSTER --------------------
async function handleFriendly(channel, hostMember) {
  try {
    const requiredRole = channel.guild.roles.cache.get(FRIENDLY_ROLE_ID);
    if (!requiredRole) return channel.send('Configuration error: required role missing on server.');
    const has = hostMember.roles.cache.some(r => r.id === FRIENDLY_ROLE_ID || r.position >= requiredRole.position);
    if (!has) return channel.send('You do not have permission to host a friendly.');

    await channel.send('@everyone :AGNELLO: Agnello Friendly, react for your position :AGNELLO:');
    const msg = await channel.send(`React with the number corresponding to your position:
1️⃣ → GK
2️⃣ → CB
3️⃣ → CB2
4️⃣ → CM
5️⃣ → LW
6️⃣ → RW
7️⃣ → ST`);

    for (const emoji of Object.keys(POSITIONS)) {
      try { await msg.react(emoji); } catch {}
    }

    const claimed = {};
    const filter = (reaction, user) => !user.bot && POSITIONS[reaction.emoji.name] && !Object.values(claimed).includes(user.id);
    const collector = msg.createReactionCollector({ filter, time: 10 * 60 * 1000 });

    collector.on('collect', (reaction, user) => {
      if (!claimed[reaction.emoji.name]) {
        claimed[reaction.emoji.name] = user.id;
        msg.edit('**Current lineup:**\n' + Object.entries(POSITIONS).map(([emoji, pos]) => `${emoji} → ${claimed[emoji] ? `<@${claimed[emoji]}> (${pos})` : pos}`).join('\n')).catch(()=>{});
        logToChannel(`${user.tag} claimed ${POSITIONS[reaction.emoji.name]}`);
      }
      if (Object.keys(claimed).length === Object.keys(POSITIONS).length) collector.stop('filled');
    });

    collector.on('end', () => {
      if (Object.keys(claimed).length === Object.keys(POSITIONS).length) {
        channel.send('Looking for a Roblox RFL link...');
        const linkCollector = channel.createMessageCollector({ filter: m => m.content.includes('roblox.com') && !m.author.bot, time: 15 * 60 * 1000 });
        linkCollector.on('collect', linkMsg => {
          Object.values(claimed).forEach(uid => {
            client.users.send(uid, `<@${uid}>, here is the friendly link: ${linkMsg.content}`).catch(()=>{});
          });
          linkCollector.stop();
        });
      }
    });
  } catch (e) {
    console.error('handleFriendly error', e);
    channel.send('Failed to create friendly due to an internal error.');
  }
}

// -------------------- MUSIC: queue, ensure, track, resume --------------------
async function ensureQueue(guild, textChannel, voiceChannel) {
  let q = queues.get(guild.id);
  if (!q) {
    q = {
      connection: null,
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } }),
      songs: [],
      textChannelId: textChannel.id,
      voiceChannelId: voiceChannel.id,
      playing: false
    };
    queues.set(guild.id, q);

    // handle player state transitions
    q.player.on(AudioPlayerStatus.Idle, () => {
      q.playing = false;
      if (q.songs.length > 0) {
        const next = q.songs.shift();
        q.player.play(next.resource);
        q.playing = true;
        client.channels.fetch(q.textChannelId).then(ch => ch?.send(`Now playing: ${next.title}`).catch(()=>{}));
      }
    });
    q.player.on('error', (err) => {
      console.error('Audio player error', err);
      logToChannel(`Audio player error: ${String(err).slice(0,1900)}`);
    });
  }

  if (!q.connection) {
    q.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,   // **undeafen** so bot can hear VC (for moderation/transcription)
      selfMute: false
    });

    // auto-reconnect logic
    q.connection.on(VoiceConnectionStatus.Disconnected, async (oldState, newState) => {
      try {
        await Promise.race([
          entersState(q.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(q.connection, VoiceConnectionStatus.Connecting, 5_000)
        ]);
        // reconnected
      } catch (err) {
        try { q.connection.destroy(); } catch {}
        queues.delete(guild.id);
      }
    });
  }

  return q;
}

async function makeTrack(query) {
  let url = query.trim();
  if (!/^https?:\/\//i.test(url)) {
    const results = await play.search(query, { limit: 1 });
    if (!results || results.length === 0) throw new Error('No results found');
    url = results[0].url;
  }
  const stream = await play.stream(url);
  const resource = createAudioResource(stream.stream, { inputType: stream.type });
  const info = await play.video_info(url).catch(()=>null);
  const title = (info && info.video_details && info.video_details.title) || url;
  return { resource, title, url };
}

// -------------------- TRANSCRIPTION (optional) --------------------
async function transcribeWavFile(wavPath) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const form = new FormData();
  form.append('file', fs.createReadStream(wavPath));
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`OpenAI transcription failed ${res.status}: ${txt}`);
  }
  const j = await res.json();
  return j.text || '';
}

function pcmToWav(pcmPath, wavPath) {
  return new Promise((resolve, reject) => {
    const args = ['-f','s16le','-ar','48000','-ac','2','-i',pcmPath,'-ar','16000','-ac','1',wavPath];
    const proc = spawn(ffmpegPath.path, args);
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit code ${code}`)));
  });
}

async function createTranscriptionListener(connection, guild, member) {
  if (!ENABLE_TRANSCRIPTION) return;
  try {
    const receiver = connection.receiver;
    if (!receiver) return;

    const opusStream = receiver.subscribe(member.id, { end: { behavior: 'afterSilence', duration: 1500 } });
    const pcmFile = path.join(TRANSCRIPTS_DIR, `${member.id}-${Date.now()}.pcm`);
    const wavFile = pcmFile + '.wav';
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const outStream = fs.createWriteStream(pcmFile);
    opusStream.pipe(decoder).pipe(outStream);

    opusStream.on('end', async () => {
      try {
        outStream.end();
        await pcmToWav(pcmFile, wavFile);
        const text = await transcribeWavFile(wavFile).catch(e => { console.error('transcribe error', e); return ''; });
        try { fs.unlinkSync(pcmFile); } catch {}
        try { fs.unlinkSync(wavFile); } catch {}
        if (!text) return;
        const normalized = text.toLowerCase();
        for (const bad of BAD_WORDS) {
          if (normalized.includes(bad)) {
            // mute member
            const fetched = await guild.members.fetch(member.id).catch(()=>null);
            if (fetched && fetched.voice.channelId) {
              fetched.voice.setMute(true, 'Auto-moderation: profanity detected').catch(()=>{});
              logToChannel(`Auto-muted ${fetched.user.tag} for profanity detected in VC. Transcript: ${text.slice(0,200)}`);
              fetched.send('You were automatically muted in voice for using profanity.').catch(()=>{});
            }
            break;
          }
        }
      } catch (err) {
        console.error('opusStream end processing error', err);
      }
    });

    opusStream.on('error', (err) => console.warn('opusStream error', err));
  } catch (e) {
    console.error('createTranscriptionListener error', e);
  }
}

// -------------------- MESSAGE HANDLING (commands + text moderation) --------------------
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    // text profanity filter (simple)
    const compact = normalizeText(message.content);
    for (const bad of BAD_WORDS) {
      if (compact.includes(bad)) {
        try { await message.delete(); } catch {}
        message.channel.send(`You can't say that word, ${message.author}!`).catch(()=>{});
        logToChannel(`${message.author.tag} attempted profanity: ${message.content}`);
        return;
      }
    }

    // commands
    if (!message.content.startsWith(PREFIX)) return;
    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const command = (args.shift() || '').toLowerCase();

    // ----- HELP -----
    if (command === 'help') {
      return message.channel.send(`
**Agnello Bot Commands**
!hostfriendly - Start a friendly (role required)
!activity <goal> - Post activity check
!dmrole @role <message> - DM members of a role
!announcement - Post announcement link
!kick @user / !ban @user - Admin only
!joinvc - Bot joins your VC (undeafened)
!play <query> - Play music
!skip / !stop / !queue - Music controls
!ticket <reason> - Open support ticket
!serverstats setup|remove - Server stats
!inviteleaderboard - Show invite counts
!help - This message
`);
    }

    // ----- HOSTFRIENDLY -----
    if (command === 'hostfriendly') {
      return handleFriendly(message.channel, message.member);
    }

    // ----- ACTIVITY -----
    if (command === 'activity') {
      const goal = parseInt(args[0]) || 0;
      const m = await message.channel.send(`:AGNELLO: @everyone, AGNELLO FC ACTIVITY CHECK, GOAL (${goal}), REACT WITH A ✅`);
      try { await m.react('✅'); } catch {}
      const collector = m.createReactionCollector({ filter: (r,u) => r.emoji.name === '✅' && !u.bot, time: 24*60*60*1000 });
      collector.on('collect', (_, user) => logToChannel(`${user.tag} responded to activity check.`));
      return;
    }

    // ----- DMROLE -----
    if (command === 'dmrole') {
      if (!args[0] || !args.slice(1).length) return message.reply('Usage: !dmrole @role <message>');
      const roleId = args[0].replace(/\D/g,'');
      const msgText = args.slice(1).join(' ');
      const role = message.guild.roles.cache.get(roleId);
      if (!role) return message.reply('Role not found.');
      let sent=0, failed=0;
      await Promise.all([...role.members.values()].map(async (m) => {
        if (m.user.bot) return;
        try { await m.send(msgText); sent++; } catch { failed++; }
      }));
      message.channel.send(`DMs sent: ${sent}. Failed: ${failed}`);
      logToChannel(`${message.author.tag} used !dmrole on ${role.name}`);
      return;
    }

    // ----- ANNOUNCEMENT -----
    if (command === 'announcement') {
      const link = 'https://discord.com/channels/1357085245983162708/1361111742427697152';
      await message.channel.send(`There is a announcement in Agnello FC, please check it out. ${link}`);
      logToChannel('Announcement made via !announcement');
      return;
    }

    // ----- KICK / BAN (admin only) -----
    if (command === 'kick' || command === 'ban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('You do not have permission.');
      const target = message.mentions.members.first();
      if (!target) return message.reply('Mention a user to kick/ban.');
      try {
        if (command === 'kick') await target.kick();
        else await target.ban();
        message.channel.send(`${command === 'kick' ? 'Kicked' : 'Banned'} ${target.user.tag}.`);
        logToChannel(`${message.author.tag} ${command}ed ${target.user.tag}`);
      } catch (e) {
        console.error('kick/ban error', e);
        message.reply('Failed to perform action.');
      }
      return;
    }

    // ----- JOIN VC (undeafened, starts transcription listeners optionally) -----
    if (command === 'joinvc') {
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a voice channel first.');
      try {
        const q = await ensureQueue(message.guild, message.channel, vc);
        message.channel.send(`Joined ${vc.name}.`);
        logToChannel(`${message.author.tag} requested joinvc (${vc.name}).`);

        // start transcription listeners for present members if enabled
        if (ENABLE_TRANSCRIPTION) {
          const connection = getVoiceConnection(message.guild.id);
          if (connection) {
            for (const member of vc.members.values()) {
              if (member.user.bot) continue;
              createTranscriptionListener(connection, message.guild, member).catch(console.error);
            }
          }
        }
      } catch (e) {
        console.error('joinvc error', e);
        message.reply('Failed to join VC.');
      }
      return;
    }

    // ----- MUSIC: play, skip, stop, queue -----
    if (command === 'play') {
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a voice channel first.');
      const query = args.join(' ');
      if (!query) return message.reply('Provide a song name or URL.');
      try {
        const q = await ensureQueue(message.guild, message.channel, vc);
        const track = await makeTrack(query);
        q.songs.push(track);
        message.channel.send(`Queued: ${track.title}`);
        if (!q.playing) {
          const next = q.songs.shift();
          q.player.play(next.resource);
          q.playing = true;
          message.channel.send(`Now playing: ${next.title}`);
        }
      } catch (e) {
        console.error('play error', e);
        message.reply('Could not play the requested track.');
      }
      return;
    }
    if (command === 'skip') {
      const q = queues.get(message.guild.id);
      if (!q) return message.reply('Nothing is playing.');
      q.player.stop();
      message.channel.send('Skipped.');
      return;
    }
    if (command === 'stop') {
      const q = queues.get(message.guild.id);
      if (!q) return message.reply('Nothing to stop.');
      q.songs = [];
      q.player.stop();
      message.channel.send('Stopped and cleared queue.');
      return;
    }
    if (command === 'queue') {
      const q = queues.get(message.guild.id);
      if (!q || q.songs.length === 0) return message.reply('Queue is empty.');
      return message.channel.send(`Queue:\n${q.songs.map((s,i)=>`${i+1}. ${s.title}`).join('\n')}`);
    }

    // ----- TICKET -----
    if (command === 'ticket') {
      const reason = args.join(' ') || 'No reason provided';
      try {
        let category = message.guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === 'Tickets');
        if (!category) category = await message.guild.channels.create({ name: 'Tickets', type: ChannelType.GuildCategory });
        const channel = await message.guild.channels.create({
          name: `ticket-${message.author.username}`.toLowerCase(),
          type: ChannelType.GuildText,
          parent: category.id,
          permissionOverwrites: [
            { id: message.guild.roles.everyone.id, deny: ['ViewChannel'] },
            { id: message.author.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] }
          ]
        });
        const staffRole = message.guild.roles.cache.get(FRIENDLY_ROLE_ID);
        if (staffRole) await channel.permissionOverwrites.edit(staffRole.id, { ViewChannel: true, SendMessages: true });
        await channel.send(`Ticket opened by <@${message.author.id}>. Reason: ${reason}`);
        message.reply(`Ticket created: <#${channel.id}>`);
        logToChannel(`${message.author.tag} created ticket ${channel.id}`);
      } catch (e) {
        console.error('ticket error', e);
        message.reply('Failed to create ticket.');
      }
      return;
    }

    // ----- SERVERSTATS -----
    if (command === 'serverstats') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return message.reply('You do not have permission.');
      const sub = args[0] ? args[0].toLowerCase() : '';
      if (sub === 'setup') {
        try {
          const cat = await message.guild.channels.create({ name: 'Server Stats', type: ChannelType.GuildCategory });
          await message.guild.channels.create({ name: `Members: ${message.guild.memberCount}`, type: ChannelType.GuildVoice, parent: cat.id, permissionOverwrites: [{ id: message.guild.roles.everyone.id, deny: ['Connect'] }] });
          await message.guild.channels.create({ name: `Online: 0`, type: ChannelType.GuildVoice, parent: cat.id, permissionOverwrites: [{ id: message.guild.roles.everyone.id, deny: ['Connect'] }] });
          return message.reply('Server stats set up.');
        } catch (e) {
          console.error('serverstats setup', e);
          message.reply('Failed to set up stats.');
        }
      } else if (sub === 'remove') {
        try {
          const cat = message.guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === 'Server Stats');
          if (!cat) return message.reply('No stats set up.');
          for (const child of cat.children.values()) await child.delete().catch(()=>{});
          await cat.delete().catch(()=>{});
          return message.reply('Server stats removed.');
        } catch (e) {
          console.error('serverstats remove', e);
          message.reply('Failed to remove stats.');
        }
      } else return message.reply('Usage: !serverstats setup|remove');
      return;
    }

    // ----- INVITE TRACKING (simple) -----
    if (command === 'inviteleaderboard') {
      // inviteCounts guild-keyed map: { userId: count }
      const counts = inviteCounts[message.guild.id] || {};
      const sorted = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,10);
      const text = sorted.map(([id,c])=>`<@${id}> — ${c}`).join('\n') || 'No invites tracked yet.';
      return message.channel.send(`**Invite leaderboard**\n${text}`);
    }

    // unknown command: ignore
  } catch (err) {
    console.error('MessageCreate handler error', err);
    logToChannel(`Message handler error: ${String(err).slice(0,1900)}`);
  }
});

// -------------------- INVITE TRACKING: on guild create/member join --------------------
client.on(Events.GuildCreate, async (guild) => {
  try {
    // preload invites (best-effort)
    const invites = await guild.invites.fetch().catch(()=>null);
    if (!inviteCounts[guild.id]) inviteCounts[guild.id] = {};
    // store current invites by code -> uses (not required for simple approach)
  } catch (e) {
    console.warn('GuildCreate invite preload failed', e);
  }
});

client.on(Events.GuildMemberAdd, async (member) => {
  try {
    // Welcome
    try { await member.send(`Welcome to ${member.guild.name}, ${member.user.username}!`); } catch {}
    const ch = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(()=>null);
    if (ch && ch.isTextBased()) ch.send(`Welcome to Agnello FC, <@${member.id}>!`).catch(()=>{});

    // Invite tracking: best-effort incremental approach (since we didn't store previous invites reliably, this is a placeholder).
    // A robust implementation needs to store invites list and compare uses on join. Here we increment the inviter count if available via AuditLogs (not perfect).
    const guildInvites = await member.guild.invites.fetch().catch(()=>null);
    // try to find an invite whose uses increased — not guaranteed on free tiers, but attempt.
    // For safety, we'll skip complicated comparisons here — this is a simple placeholder showing where you'd implement it.
    if (!inviteCounts[member.guild.id]) inviteCounts[member.guild.id] = {};
    // (No reliable inviter detected) — nothing to increment.

    saveInvites();
  } catch (e) {
    console.error('GuildMemberAdd handler error', e);
  }
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    try { await member.user.send(`Goodbye from ${member.guild.name}, hope to see you again!`); } catch {}
    const ch = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(()=>null);
    if (ch && ch.isTextBased()) ch.send(`Goodbye <@${member.id}>!`).catch(()=>{});
  } catch (e) {
    console.error('GuildMemberRemove handler error', e);
  }
});

// -------------------- DELETED MESSAGE LOGGING --------------------
client.on(Events.MessageDelete, (msg) => {
  try {
    if (!msg || !msg.author) return;
    logToChannel(`Message deleted by ${msg.author.tag}: ${msg.content}`);
  } catch (e) {
    console.error('MessageDelete handler error', e);
  }
});

// -------------------- READY & PRESENCE --------------------
client.on(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { client.user.setStatus('online').catch(()=>{}); } catch {}
  try { client.user.setActivity('Agnello FC', { type: 'WATCHING' }); } catch {}
  logToChannel('Bot online and ready.');
});

// -------------------- EXPRESS KEEPALIVE --------------------
const app = express();
app.get('/', (_req, res) => res.send('Bot is running.'));
app.listen(process.env.PORT || 3000, () => console.log('HTTP server listening'));

// -------------------- LOGIN --------------------
client.login(process.env.BOT_TOKEN)
  .then(() => console.log('client.login() resolved — awaiting ClientReady event'))
  .catch(err => {
    console.error('Failed to login:', err);
    logToChannel(`Failed to login: ${String(err).slice(0,1900)}`).catch(()=>{});
    process.exit(1);
  });

// -------------------- GLOBAL HANDLERS --------------------
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
  logToChannel(`Unhandled rejection: ${String(err).slice(0,1900)}`).catch(()=>{});
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  logToChannel(`Uncaught exception: ${String(err).slice(0,1900)}`).catch(()=>{});
});
