/**
 * index.js - Agnello FC all-in-one bot
 *
 * Features:
 * - Prefix commands (!hostfriendly, !activity, !dmrole, !joinvc, !play, !skip, !stop, !queue, !kick, !ban, !ticket, !serverstats)
 * - Friendly reaction-role hoster (1-7 positions), role-restricted
 * - Activity check with ✅ reactions
 * - DM role command
 * - Music playback via @iamtraction/play-dl and @discordjs/voice
 * - Welcome & goodbye messages + DMs
 * - Ticket system (creates private channels)
 * - Basic invite tracking placeholders
 * - Bad-word detection in text and (via OpenAI transcription) in VC; auto-mute on detection
 * - Express keep-alive for Render
 *
 * Requirements:
 * - Environment variables: BOT_TOKEN, OPENAI_API_KEY (for transcription)
 * - Privileged intents enabled (Message Content, Guild Members)
 * - Bot invited with necessary permissions (Mute Members, Connect, Speak, Manage Channels, Send Messages, etc.)
 * - package.json includes required deps (@iamtraction/play-dl, @discordjs/voice, prism-media, @ffmpeg-installer/ffmpeg, openai/node fetch/form-data)
 *
 * Deploy notes: push this + package.json to GitHub, set env vars in Render, deploy.
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
  getVoiceConnection,
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

//
// CONFIG - change IDs if needed
//
const LOG_CHANNEL_ID = '1362214241091981452';
const FRIENDLY_ROLE_ID = '1383970211933454378';
const WELCOME_CHANNEL_ID = '1361113546829729914'; // channel to announce welcome/goodbye (optional)
const PREFIX = '!';
const POSITIONS = { '1️⃣': 'GK', '2️⃣': 'CB', '3️⃣': 'CB2', '4️⃣': 'CM', '5️⃣': 'LW', '6️⃣': 'RW', '7️⃣': 'ST' };
const BAD_WORDS = ['fuck', 'bitch', 'nigger', 'dick', 'nigga', 'pussy'];
const TRANSCRIPTS_DIR = './transcripts_tmp';
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

//
// ENV checks
//
if (!process.env.BOT_TOKEN) {
  console.error('Missing BOT_TOKEN env var. Set BOT_TOKEN in Render or .env.');
  process.exit(1);
}
// OPENAI_API_KEY optional for text-only features; needed for VC transcription
if (!process.env.OPENAI_API_KEY) {
  console.warn('OPENAI_API_KEY not set — VC transcription will be disabled until you set it.');
}

//
// Create client
//
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
const queues = new Map(); // guildId -> { connection, player, songs: [{resource, title, url}], textChannelId, voiceChannelId }

// Simple logging helper
async function logToChannel(text) {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send(typeof text === 'string' ? text : JSON.stringify(text).slice(0, 2000));
  } catch (e) {
    console.error('logToChannel error:', e);
  }
}

//
// FRIENDLY - reaction role friendly hoster
//
async function handleFriendly(channel, member) {
  try {
    const requiredRole = channel.guild.roles.cache.get(FRIENDLY_ROLE_ID);
    if (!requiredRole) return channel.send('Configuration error: required role missing on server.');
    const has = member.roles.cache.some(r => r.id === FRIENDLY_ROLE_ID || r.position >= requiredRole.position);
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
      try { await msg.react(emoji); } catch {}
    }

    const claimed = {};
    const filter = (reaction, user) => !user.bot && POSITIONS[reaction.emoji.name] && !Object.values(claimed).includes(user.id);
    const collector = msg.createReactionCollector({ filter, time: 10 * 60 * 1000 });

    collector.on('collect', (reaction, user) => {
      if (!claimed[reaction.emoji.name]) {
        claimed[reaction.emoji.name] = user.id;
        msg.edit(
          '**Current lineup:**\n' +
          Object.entries(POSITIONS).map(([emoji, pos]) => `${emoji} → ${claimed[emoji] ? `<@${claimed[emoji]}> (${pos})` : pos}`).join('\n')
        ).catch(()=>{});
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
  } catch (err) {
    console.error('handleFriendly error', err);
    channel.send('An error occurred while creating the friendly.');
  }
}

//
// MUSIC helpers
//
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
    try { q.connection.subscribe(q.player); } catch (e) { console.warn('subscribe error', e); }
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

//
// TRANSCRIPTION + AUTO-MUTE (OpenAI Whisper via REST multipart)
//
async function transcribeWavFile(wavPath) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const form = new FormData();
  form.append('file', fs.createReadStream(wavPath));
  form.append('model', 'whisper-1');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
    },
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
      // input settings: signed 16-bit little endian, 48k stereo
      '-f','s16le','-ar','48000','-ac','2','-i',pcmPath,
      // output settings: 16k mono wav (OpenAI accepts many formats; 16k mono is safe)
      '-ar','16000','-ac','1',wavPath
    ];
    const proc = spawn(ffmpegPath.path, args);
    proc.on('error', reject);
    proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit code ${code}`)));
  });
}

// Start a transcription listener for a member's opus stream
async function createTranscriptionListener(connection, guild, member) {
  try {
    const receiver = connection.receiver;
    if (!receiver) return;

    // Subscribe to opus for this user; end after 1.5s silence
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
        const text = await transcribeWavFile(wavFile).catch(e => {
          console.error('transcribeWavFile error', e);
          return '';
        });
        // cleanup
        try { fs.unlinkSync(pcmFile); } catch {}
        try { fs.unlinkSync(wavFile); } catch {}

        if (!text) return;
        const normalized = text.toLowerCase();
        for (const bad of BAD_WORDS) {
          if (normalized.includes(bad)) {
            // mute member in VC
            try {
              const fetchedMember = await guild.members.fetch(member.id).catch(()=>null);
              if (fetchedMember && fetchedMember.voice.channelId) {
                await fetchedMember.voice.setMute(true, 'Auto-moderation: profanity detected via transcription');
                logToChannel(`Auto-muted ${fetchedMember.user.tag} for profanity detected in VC: "${bad}" (transcript: ${text.slice(0,200)})`);
                // optional DM
                fetchedMember.send('You were automatically muted in voice for using profanity. Please follow the server rules.').catch(()=>{});
              }
            } catch (e) {
              console.error('Failed to mute member', e);
              logToChannel(`Failed to auto-mute user ${member.id}: ${String(e).slice(0,200)}`);
            }
            break;
          }
        }
      } catch (err) {
        console.error('opusStream end processing error', err);
      }
    });

    opusStream.on('error', (err) => {
      console.warn('opusStream error', err);
    });
  } catch (e) {
    console.error('createTranscriptionListener error', e);
  }
}

//
// SINGLE MESSAGE LISTENER: commands + moderation
//
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  // Quick text profanity filter
  const compact = message.content.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const bad of BAD_WORDS) {
    if (compact.includes(bad)) {
      try { await message.delete(); } catch {}
      message.channel.send(`You can't say that word, ${message.author}!`).catch(()=>{});
      logToChannel(`${message.author.tag} tried to say a bad word: ${message.content}`);
      return;
    }
  }

  // Commands
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
    let sent=0, failed=0;
    await Promise.all([...role.members.values()].map(async (m) => {
      if (m.user.bot) return;
      try { await m.send(msgText); sent++; } catch { failed++; }
    }));
    message.channel.send(`DMs sent: ${sent}. Failed: ${failed}`);
    logToChannel(`${message.author.tag} used !dmrole on ${role.name}`);
    return;
  }

  // kick/ban (admin only)
  if (cmd === 'kick' || cmd === 'ban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('You do not have permission.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Mention a user.');
    try {
      if (cmd === 'kick') await target.kick();
      else await target.ban();
      message.channel.send(`${cmd === 'kick' ? 'Kicked' : 'Banned'} ${target.user.tag}.`);
      logToChannel(`${message.author.tag} ${cmd}ed ${target.user.tag}`);
    } catch (e) {
      console.error('kick/ban error', e);
      message.channel.send('Failed to perform action.');
    }
    return;
  }

  // joinvc - bot joins and begins short transcription listeners for active speakers
  if (cmd === 'joinvc') {
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('Join a voice channel first.');
    try {
      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: vc.guild.id,
        adapterCreator: vc.guild.voiceAdapterCreator
      });
      // wait until ready
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000).catch(()=>{});
      message.channel.send(`Joined ${vc.name}`);
      logToChannel(`${message.author.tag} used !joinvc to join ${vc.name}`);
      // start listeners for each non-bot member currently in channel
      for (const [memberId, member] of vc.members) {
        if (member.user.bot) continue;
        // start transcription listener for member
        createTranscriptionListener(connection, message.guild, member).catch(console.error);
      }
    } catch (e) {
      console.error('joinvc error', e);
      message.reply('Failed to join VC.');
    }
    return;
  }

  // play
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
          { id: message.author.id, allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'] }
        ]
      });
      const staffRole = message.guild.roles.cache.get(FRIENDLY_ROLE_ID);
      if (staffRole) await channel.permissionOverwrites.edit(staffRole.id, { ViewChannel: true, SendMessages: true });
      await channel.send(`Ticket opened by <@${message.author.id}>. Reason: ${reason}`);
      message.reply(`Ticket created: <#${channel.id}>`);
      logToChannel(`${message.author.tag} created ticket ${channel.id}`);
    } catch (e) {
      console.error('ticket creation error', e);
      message.reply('Failed to create ticket.');
    }
    return;
  }

  // serverstats simple setup/remove
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

  // unknown command: ignore
});

//
// Welcome / Goodbye
//
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

//
// Deleted message logging
//
client.on(Events.MessageDelete, (msg) => {
  if (!msg || !msg.author) return;
  logToChannel(`Message deleted by ${msg.author.tag}: ${msg.content}`);
});

//
// Ready
//
client.on(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  logToChannel('Bot online.');
});

//
// Express keep-alive
//
const app = express();
app.get('/', (_req, res) => res.send('Bot is running.'));
app.listen(process.env.PORT || 3000, () => console.log('HTTP server listening'));

//
// Login
//
client.login(process.env.BOT_TOKEN).catch(err => {
  console.error('Failed to login:', err);
  process.exit(1);
});
