// index.js - Agnello FC - single-file, production-ready baseline
// Features: login debug, prefix commands, friendly hoster, activity check,
// !dmrole, announcement, kick/ban (admin-only), music (play/skip/stop/queue),
// joinvc, bad-word filter (text), welcome/goodbye DM, message-delete logging,
// express keep-alive. No VC transcription in this baseline to ensure stable startup.

import 'dotenv/config';
import express from 'express';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

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
  NoSubscriberBehavior
} from '@discordjs/voice';

import play from '@iamtraction/play-dl';

// ---- CONFIG ----
const PREFIX = '!';
const LOG_CHANNEL_ID = '1362214241091981452'; // where the bot posts logs
const FRIENDLY_ROLE_ID = '1383970211933454378';
const WELCOME_CHANNEL_ID = '1361113546829729914';
const POSITIONS = { '1️⃣': 'GK', '2️⃣': 'CB', '3️⃣': 'CB2', '4️⃣': 'CM', '5️⃣': 'LW', '6️⃣': 'RW', '7️⃣': 'ST' };
const BAD_WORDS = ['fuck', 'bitch', 'nigger', 'dick', 'nigga', 'pussy'];

// ---- SANITY CHECKS BEFORE START ----
console.log('Starting index.js...');
console.log('Node:', process.version);
if (!process.env.BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN environment variable not set. Add it in Render (Environment).');
  process.exit(1);
} else {
  // don't print the token — just confirm length
  console.log('BOT_TOKEN found (length):', process.env.BOT_TOKEN.length);
}

// ---- CLIENT SETUP ----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,       // for welcome/leave + role checks
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// music queues: guildId -> { connection, player, songs[], textChannelId, voiceChannelId }
const queues = new Map();

// ---- helper: send to log channel (safe) ----
async function logToChannel(text) {
  try {
    const ch = await client.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (ch && ch.isTextBased()) await ch.send(String(text).slice(0, 1900));
  } catch (err) {
    console.error('logToChannel error:', err);
  }
}

// ---- Friendly hoster ----
async function handleFriendly(channel, member) {
  try {
    const requiredRole = channel.guild.roles.cache.get(FRIENDLY_ROLE_ID);
    if (!requiredRole) return channel.send('Configuration error: required role missing.');
    const has = member.roles.cache.some(r => r.id === FRIENDLY_ROLE_ID || (requiredRole && r.position >= requiredRole.position));
    if (!has) return channel.send('You do not have permission to host a friendly.');

    await channel.send('@everyone :AGNELLO: Agnello Friendly, react for your position :AGNELLO:');
    const msg = await channel.send(
      `React with the number corresponding to your position:
1️⃣ → GK
2️⃣ → CB
3️⃣ → CB2
4️⃣ → CM
5️⃣ → LW
6️⃣ → RW
7️⃣ → ST`
    );

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
          Object.values(claimed).forEach(uid => {
            client.users.send(uid, `<@${uid}>, here is the friendly link: ${linkMsg.content}`).catch(()=>{});
          });
          linkCollector.stop();
        });
      }
    });

  } catch (err) {
    console.error('handleFriendly error', err);
    channel.send('An error occurred while creating the friendly.');
  }
}

// ---- Music helpers ----
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
  // if plain search term, use play.search
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

// ---- Single Message Listener (commands + text moderation) ----
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild) return;

  // quick text profanity filter
  const cleaned = message.content.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const bad of BAD_WORDS) {
    if (cleaned.includes(bad)) {
      try { await message.delete(); } catch {}
      message.channel.send(`You can't say that word, ${message.author}!`).catch(()=>{});
      logToChannel(`${message.author.tag} tried to say a bad word: ${message.content}`);
      return;
    }
  }

  // commands only
  if (!message.content.startsWith(PREFIX)) return;
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();

  // !hostfriendly
  if (cmd === 'hostfriendly') {
    return handleFriendly(message.channel, message.member);
  }

  // !activity <goal>
  if (cmd === 'activity') {
    const goal = parseInt(args[0]) || 0;
    const m = await message.channel.send(`:AGNELLO: @everyone, AGNELLO FC ACTIVITY CHECK, GOAL (${goal}), REACT WITH A ✅`);
    try { await m.react('✅'); } catch {}
    const collector = m.createReactionCollector({ filter: (r, u) => r.emoji.name === '✅' && !u.bot, time: 24 * 60 * 60 * 1000 });
    collector.on('collect', (_, user) => logToChannel(`${user.tag} responded to activity check.`));
    return;
  }

  // !dmrole @role message
  if (cmd === 'dmrole') {
    if (!args[0] || !args.slice(1).length) return message.reply('Usage: !dmrole @role <message>');
    const roleId = args[0].replace(/\D/g, '');
    const msgText = args.slice(1).join(' ');
    const role = message.guild.roles.cache.get(roleId);
    if (!role) return message.reply('Role not found.');
    let sent = 0, failed = 0;
    await Promise.all([...role.members.values()].map(async (m) => {
      if (m.user.bot) return;
      try { await m.send(msgText); sent++; } catch { failed++; }
    }));
    message.channel.send(`DMs sent: ${sent}. Failed: ${failed}`);
    logToChannel(`${message.author.tag} used !dmrole on ${role.name}`);
    return;
  }

  // !announcement
  if (cmd === 'announcement') {
    const link = 'https://discord.com/channels/1357085245983162708/1361111742427697152';
    await message.channel.send(`There is a announcement in Agnello FC, please check it out. ${link}`);
    logToChannel('Announcement made via !announcement');
    return;
  }

  // !kick / !ban (admin only)
  if ((cmd === 'kick' || cmd === 'ban')) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('You do not have permission.');
    const target = message.mentions.members.first();
    if (!target) return message.reply('Mention a user.');
    try {
      if (cmd === 'kick') await target.kick();
      else await target.ban();
      message.channel.send(`${cmd === 'kick' ? 'Kicked' : 'Banned'} ${target.user.tag}.`);
      logToChannel(`${message.author.tag} executed ${cmd} on ${target.user.tag}`);
    } catch (e) {
      console.error('kick/ban error:', e);
      message.reply('Failed to perform action.');
    }
    return;
  }

  // !joinvc
  if (cmd === 'joinvc') {
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('You must be in a voice channel for me to join.');
    try {
      joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
      message.channel.send('Joined your VC.');
      logToChannel(`${message.author.tag} requested bot to join VC ${vc.name}`);
    } catch (e) {
      console.error('joinvc error', e);
      message.reply('Failed to join VC.');
    }
    return;
  }

  // Music: !play <query>
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
    if (!q) return message.reply('Nothing is playing.');
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

  // !ticket
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
      console.error('ticket error:', e);
      message.reply('Failed to create ticket.');
    }
    return;
  }
});

// ---- Deleted message logging ----
client.on(Events.MessageDelete, (msg) => {
  if (!msg || !msg.author) return;
  logToChannel(`Message deleted by ${msg.author.tag}: ${msg.content}`);
});

// ---- Welcome & Goodbye ----
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

// ---- Ready & presence ----
client.on(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setStatus('online').catch(()=>{});
  try { client.user.setActivity('Agnello FC', { type: 'WATCHING' }); } catch {}
  logToChannel('Bot online and ready.');
});

// ---- Express keepalive ----
const app = express();
app.get('/', (_req, res) => res.send('Bot is running.'));
app.listen(process.env.PORT || 3000, () => console.log('HTTP server listening'));

// ---- Login ----
client.login(process.env.BOT_TOKEN)
  .then(() => console.log('client.login() resolved — check logs for ClientReady event.'))
  .catch(err => {
    console.error('Failed to login to Discord:', err);
    logToChannel(`Failed to login: ${String(err).slice(0,1900)}`).catch(()=>{});
    process.exit(1);
  });

// ---- Unhandled rejections ----
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection:', err);
  logToChannel(`Unhandled rejection: ${String(err).slice(0,1900)}`).catch(()=>{});
});
