/**
 * index.js - Agnello FC all-in-one bot (single-file)
 *
 * - Uses @iamtraction/play-dl@^1.9.8 (verified)
 * - Uses OpenAI audio transcriptions endpoint for VC -> text
 * - Auto-mutes members in VC when profanity is transcribed
 *
 * Before deploying:
 * - Set BOT_TOKEN and OPENAI_API_KEY in Render environment
 * - Enable Message Content Intent and Guild Members Intent in Discord Dev Portal
 * - Invite bot with Mute Members, Connect, Speak, Manage Channels, Send Messages, etc.
 */

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
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  EndBehaviorType
} from '@discordjs/voice';

import prism from 'prism-media';
import ffmpegPath from '@ffmpeg-installer/ffmpeg';
import express from 'express';
import 'dotenv/config';
import play from '@iamtraction/play-dl';

////////////////////////////////////////////////////////////////////////////////
// CONFIG - update these IDs if needed
////////////////////////////////////////////////////////////////////////////////

const LOG_CHANNEL_ID = '1362214241091981452';
const FRIENDLY_ROLE_ID = '1383970211933454378';
const WELCOME_CHANNEL_ID = '1361113546829729914';
const PREFIX = '!';
const POSITIONS = {
  '1️⃣': 'GK',
  '2️⃣': 'CB',
  '3️⃣': 'CB2',
  '4️⃣': 'CM',
  '5️⃣': 'LW',
  '6️⃣': 'RW',
  '7️⃣': 'ST'
};
const BAD_WORDS = ['fuck', 'bitch', 'nigger', 'dick', 'nigga', 'pussy'];
const TRANSCRIPTS_DIR = './transcripts_tmp';
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

////////////////////////////////////////////////////////////////////////////////
// ENV checks
////////////////////////////////////////////////////////////////////////////////

if (!process.env.BOT_TOKEN) {
  console.error('Missing BOT_TOKEN in environment. Set BOT_TOKEN before starting.');
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY not set — VC transcription will be disabled until you set it.');
}

////////////////////////////////////////////////////////////////////////////////
// CLIENT
////////////////////////////////////////////////////////////////////////////////

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

const queues = new Map(); // guildId -> { connection, player, songs, textChannelId, voiceChannelId }

////////////////////////////////////////////////////////////////////////////////
// UTIL: logging to the configured log channel
////////////////////////////////////////////////////////////////////////////////

async function logToChannel(text) {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send(typeof text === 'string' ? text : JSON.stringify(text).slice(0, 2000));
  } catch (e) {
    console.error('logToChannel error:', e);
  }
}

////////////////////////////////////////////////////////////////////////////////
// FRIENDLY: reaction-role style friendly hoster
////////////////////////////////////////////////////////////////////////////////

async function handleFriendly(channel, member) {
  try {
    const reqRole = channel.guild.roles.cache.get(FRIENDLY_ROLE_ID);
    if (!reqRole) return channel.send('Configuration error: required role missing.');
    const has = member.roles.cache.some(r => r.id === FRIENDLY_ROLE_ID || r.position >= reqRole.position);
    if (!has) return channel.send('You do not have permission to host a friendly.');

    await channel.send('@everyone :AGNELLO: Agnello Friendly, react to position :AGNELLO:');
    const msg = await channel.send(`React with the number corresponding to your position:
1️⃣ → GK
2️⃣ → CB
3️⃣ → CB2
4️⃣ → CM
5️⃣ → LW
6️⃣ → RW
7️⃣ → ST`);

    for (const emoji of Object.keys(POSITIONS)) {
      try { await msg.react(emoji); } catch (e) { /* ignore */ }
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
          for (const uid of Object.values(claimed)) {
            client.users.send(uid, `<@${uid}>, here is the friendly link: ${linkMsg.content}`).catch(()=>{});
          }
          linkCollector.stop();
        });
      }
    });
  } catch (e) {
    console.error('handleFriendly error', e);
    channel.send('An error occurred while creating the friendly.');
  }
}

////////////////////////////////////////////////////////////////////////////////
// MUSIC: helpers (ensureQueue, makeTrack)
////////////////////////////////////////////////////////////////////////////////

async function ensureQueue(guild, textChannel, voiceChannel) {
  let q = queues.get(guild.id);
  if (!q) {
    q = {
      connection: null,
      player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
      songs: [],
      textChannelId: textChannel.id,
      voiceChannelId: voiceChannel.id
    };
    queues.set(guild.id, q);
  }
  if (!q.connection) {
    q.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator
    });
    try { q.connection.subscribe(q.player); } catch (err) { console.warn('subscribe err', err); }
    q.player.on(AudioPlayerStatus.Idle, () => {
      if (q.songs.length > 0) {
        const next = q.songs.shift();
        q.player.play(next.resource);
        client.channels.fetch(q.textChannelId).then(ch => ch?.send(`Now playing: ${next.title}`).catch(()=>{}));
      }
    });
  }
  return q;
}

async function makeTrack(query) {
  let url = query.trim();
  if (!/^https?:\/\//i.test(url)) {
    const results = await play.search(query, { limit: 1 });
    if (!results || results.length === 0) throw new Error('No results found.');
    url = results[0].url;
  }
  const stream = await play.stream(url);
  const resource = createAudioResource(stream.stream, { inputType: stream.type });
  const info = await play.video_info(url).catch(()=>null);
  const title = (info && info.video_details && info.video_details.title) || url;
  return { resource, title, url };
}

////////////////////////////////////////////////////////////////////////////////
// TRANSCRIPTION: helper functions to convert PCM->wav and call OpenAI
////////////////////////////////////////////////////////////////////////////////

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
    const t = await res.text();
    throw new Error(`OpenAI transcription failed ${res.status}: ${t}`);
  }
  const j = await res.json();
  return j.text || '';
}

function pcmToWav(pcmPath, wavPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f','s16le','-ar','48000','-ac','2','-i',pcmPath,
      '-ar','16000','-ac','1',wavPath
    ];
    const ff = spawn(ffmpegPath.path, args);
    ff.on('error', reject);
    ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit code ${code}`)));
  });
}

async function createTranscriptionListener(connection, guild, member) {
  try {
    const receiver = connection.receiver;
    if (!receiver) return;

    const opusStream = receiver.subscribe(member.id, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 1500 }
    });

    const pcmFile = path.join(TRANSCRIPTS_DIR, `${member.id}-${Date.now()}.pcm`);
    const wavFile = pcmFile + '.wav';
    const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    const outStream = fs.createWriteStream(pcmFile);
    opusStream.pipe(decoder).pipe(outStream);

    opusStream.on('end', async () => {
      try {
        outStream.end();
        await pcmToWav(pcmFile, wavFile);
        const text = await transcribeWavFile(wavFile).catch(e => { console.error('transcribe err', e); return ''; });
        try { fs.unlinkSync(pcmFile); } catch {}
        try { fs.unlinkSync(wavFile); } catch {}

        if (!text) return;
        const normalized = text.toLowerCase();
        for (const bad of BAD_WORDS) {
          if (normalized.includes(bad)) {
            try {
              const fetched = await guild.members.fetch(member.id).catch(()=>null);
              if (fetched && fetched.voice.channelId) {
                await fetched.voice.setMute(true, 'Auto-mod: profanity detected');
                logToChannel(`Auto-muted ${fetched.user.tag} in VC for profanity (${bad}). Transcript: ${text.slice(0,200)}`);
                fetched.send('You were auto-muted in voice for using profanity.').catch(()=>{});
              }
            } catch (muteErr) {
              console.error('mute error', muteErr);
              logToChannel(`Failed to mute ${member.id}: ${String(muteErr).slice(0,200)}`);
            }
            break;
          }
        }
      } catch (err) {
        console.error('opusStream end proc error', err);
      }
    });

    opusStream.on('error', (err) => {
      console.warn('opusStream error', err);
    });
  } catch (e) {
    console.error('createTranscriptionListener error', e);
  }
}

////////////////////////////////////////////////////////////////////////////////
// SINGLE unified message handler: commands + text moderation
////////////////////////////////////////////////////////////////////////////////

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  // Quick text profanity filter
  const compact = message.content.toLowerCase().replace(/[^a-z0-9]/g,'');
  for (const bad of BAD_WORDS) {
    if (compact.includes(bad)) {
      try { await message.delete(); } catch {}
      message.channel.send(`You can't say that word, ${message.author}!`).catch(()=>{});
      logToChannel(`${message.author.tag} tried to say a bad word: ${message.content}`);
      return;
    }
  }

  // commands: prefix-based
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();

  // hostfriendly
  if (cmd === 'hostfriendly') return handleFriendly(message.channel, message.member);

  // activity
  if (cmd === 'activity') {
    const goal = parseInt(args[0]) || 0;
    const m = await message.channel.send(`:AGNELLO: @everyone, AGNELLO FC ACTIVITY CHECK, GOAL (${goal}), REACT WITH A ✅`);
    try { await m.react('✅'); } catch {}
    const collector = m.createReactionCollector({ filter: (r,u) => r.emoji.name === '✅' && !u.bot, time: 24*60*60*1000 });
    collector.on('collect', (_, user) => logToChannel(`${user.tag} responded to activity check.`));
    return;
  }

  // dmrole
  if (cmd === 'dmrole') {
    if (!args[0] || !args.slice(1).length) return message.reply('Usage: !dmrole @role your message');
    const roleId = args[0].replace(/\D/g,'');
    const msgText = args.slice(1).join(' ');
    const role = message.guild.roles.cache.get(roleId);
    if (!role) return message.reply('Role not found.');
    let s=0, f=0;
    await Promise.all([...role.members.values()].map(async (m) => {
      if (m.user.bot) return;
      try { await m.send(msgText); s++; } catch { f++; }
    }));
    message.channel.send(`DMs sent: ${s}. Failed: ${f}`);
    logToChannel(`${message.author.tag} used !dmrole on ${role.name}`);
    return;
  }

  // kick/ban (admin)
  if (cmd === 'kick' || cmd === 'ban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('You do not have permission.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Mention a user.');
    try {
      if (cmd === 'kick') await target.kick(); else await target.ban();
      message.channel.send(`${cmd === 'kick' ? 'Kicked' : 'Banned'} ${target.user.tag}.`);
      logToChannel(`${message.author.tag} ${cmd}ed ${target.user.tag}`);
    } catch (e) {
      console.error('kick/ban error', e);
      message.channel.send('Failed to perform action.');
    }
    return;
  }

  // joinvc -> join and start short transcription listeners
  if (cmd === 'joinvc') {
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('Join a voice channel first.');
    try {
      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: vc.guild.id,
        adapterCreator: vc.guild.voiceAdapterCreator
      });
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000).catch(()=>{});
      message.channel.send(`Joined ${vc.name}`);
      logToChannel(`${message.author.tag} used !joinvc to join ${vc.name}`);
      for (const [id, member] of vc.members) {
        if (member.user.bot) continue;
        createTranscriptionListener(connection, message.guild, member).catch(console.error);
      }
    } catch (e) {
      console.error('joinvc error', e);
      message.reply('Failed to join VC.');
    }
    return;
  }

  // play/skip/stop/queue
  if (cmd === 'play') {
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('Join a voice channel first.');
    const query = args.join(' ');
    if (!query) return message.reply('Provide a song name or URL.');
    try {
      const q = await ensureQueue(message.guild, message.channel, vc);
      const track = await makeTrack(query);
      q.songs.push(track);
      message.channel.send(`Queued: ${track.title}`);
      if (q.player.state.status !== AudioPlayerStatus.Playing) {
        const next = q.songs.shift();
        q.player.play(next.resource);
        message.channel.send(`Now playing: ${next.title}`);
      }
    } catch (e) {
      console.error('play error', e);
      message.reply('Could not play the requested track.');
    }
    return;
  }
  if (cmd === 'skip') {
    const q = queues.get(message.guild.id);
    if (!q) return message.reply('Nothing playing.');
    q.player.stop();
    return;
  }
  if (cmd === 'stop') {
    const q = queues.get(message.guild.id);
    if (!q) return message.reply('Nothing to stop.');
    q.songs = [];
    q.player.stop();
    return;
  }
  if (cmd === 'queue') {
    const q = queues.get(message.guild.id);
    if (!q || q.songs.length === 0) return message.reply('Queue is empty.');
    message.channel.send(`Queue:\n${q.songs.map((s,i)=>`${i+1}. ${s.title}`).join('\n')}`);
    return;
  }

  // ticket
  if (cmd === 'ticket') {
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
          { id: message.author.id, allow: ['ViewChannel','SendMessages','ReadMessageHistory'] }
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

  // serverstats setup/remove
  if (cmd === 'serverstats') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return message.reply('You do not have permission.');
    const sub = args[0] ? args[0].toLowerCase() : '';
    if (sub === 'setup') {
      try {
        const cat = await message.guild.channels.create({ name: 'Server Stats', type: ChannelType.GuildCategory });
        await message.guild.channels.create({ name: `Members: ${message.guild.memberCount}`, type: ChannelType.GuildVoice, parent: cat.id, permissionOverwrites: [{ id: message.guild.roles.everyone.id, deny: ['Connect'] }] });
        await message.guild.channels.create({ name: `Online: 0`, type: ChannelType.GuildVoice, parent: cat.id, permissionOverwrites: [{ id: message.guild.roles.everyone.id, deny: ['Connect'] }] });
        return message.reply('Server stats set up.');
      } catch (e) { console.error(e); message.reply('Failed to set up stats.'); }
    } else if (sub === 'remove') {
      try {
        const cat = message.guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === 'Server Stats');
        if (!cat) return message.reply('No stats set up.');
        for (const child of cat.children.values()) await child.delete().catch(()=>{});
        await cat.delete().catch(()=>{});
        return message.reply('Server stats removed.');
      } catch (e) { console.error(e); message.reply('Failed to remove stats.'); }
    } else return message.reply('Usage: !serverstats setup|remove');
  }

  // end commands
});

////////////////////////////////////////////////////////////////////////////////
// member join/leave (welcome/goodbye)
////////////////////////////////////////////////////////////////////////////////

client.on(Events.GuildMemberAdd, async (member) => {
  try { await member.send(`Welcome to ${member.guild.name}, ${member.user.username}!`); } catch {}
  try {
    const ch = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(()=>null);
    if (ch && ch.isTextBased()) ch.send(`Welcome to Agnello FC, <@${member.id}>!`).catch(()=>{});
  } catch {}
});

client.on(Events.GuildMemberRemove, async (member) => {
  try { await member.user.send(`Goodbye from ${member.guild.name}, hope to see you again!`); } catch {}
  try {
    const ch = await member.guild.channels.fetch(WELCOME_CHANNEL_ID).catch(()=>null);
    if (ch && ch.isTextBased()) ch.send(`Goodbye <@${member.id}>!`).catch(()=>{});
  } catch {}
});

////////////////////////////////////////////////////////////////////////////////
// message delete logging
////////////////////////////////////////////////////////////////////////////////

client.on(Events.MessageDelete, (msg) => {
  if (!msg || !msg.author) return;
  logToChannel(`Message deleted by ${msg.author.tag}: ${msg.content}`);
});

////////////////////////////////////////////////////////////////////////////////
// ready + express keepalive
////////////////////////////////////////////////////////////////////////////////

client.on(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  logToChannel('Bot online.');
});

const app = express();
app.get('/', (_req, res) => res.send('Bot is running.'));
app.listen(process.env.PORT || 3000, () => console.log('HTTP server listening'));

////////////////////////////////////////////////////////////////////////////////
// login
////////////////////////////////////////////////////////////////////////////////

client.login(process.env.BOT_TOKEN).catch(err => {
  console.error('Failed to login:', err);
  process.exit(1);
});
