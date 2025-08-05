
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ActivityType,
} from 'discord.js';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import express from 'express';
import ytdl from 'ytdl-core';
import ytsr from 'ytsr';
import 'dotenv/config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// Keep-alive HTTP
express()
  .listen(process.env.PORT || 3000, () => console.log('Server is up'));

// Voice channel to auto-join
const VC_ID = '1368359914145058956';
let reconnecting = false;

// Connect (or reconnect) to VC
async function connectVC(guild) {
  const channel = await guild.channels.fetch(VC_ID);
  if (!channel?.isVoiceBased()) return;
  const conn = joinVoiceChannel({
    channelId: VC_ID,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfMute: true,
  });
  await entersState(conn, VoiceConnectionStatus.Ready, 30_000);
  return conn;
}

// When bot is ready
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setActivity('Spotify', { type: ActivityType.Listening });
  const guild = client.guilds.cache.get(process.env.GUILD_ID);
  if (guild) await connectVC(guild);
});

// Reconnect logic if bot is kicked
client.on('voiceStateUpdate', (oldS, newS) => {
  if (
    oldS.channelId === VC_ID &&
    !newS.channelId &&
    oldS.member.user.id === client.user.id &&
    !reconnecting
  ) {
    reconnecting = true;
    setTimeout(async () => {
      const guild = oldS.guild;
      await connectVC(guild);
      reconnecting = false;
    }, 5000);
  }
});

// ✅ reaction to @everyone/@here
client.on('messageCreate', async (message) => {
  if (
    !message.author.bot &&
    (message.content.includes('@everyone') || message.content.includes('@here'))
  ) {
    message.react('✅').catch(() => {});
  }
});

// --- DM Cache to prevent dupes ---
const dmCache = new Set();

// --- Music Queues ---
const queues = new Map();

async function ensureMusic(guildId, voiceChannel) {
  if (!queues.has(guildId)) {
    const conn = await connectVC(voiceChannel.guild);
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });
    conn.subscribe(player);
    queues.set(guildId, { conn, player, songs: [], loop: false });
    player.on(AudioPlayerStatus.Idle, () => {
      const q = queues.get(guildId);
      if (!q) return;
      if (q.loop && q.songs.length) {
        playTrack(guildId, q.songs[0]);
      } else {
        q.songs.shift();
        if (q.songs.length) playTrack(guildId, q.songs[0]);
      }
    });
  }
  return queues.get(guildId);
}

async function playTrack(guildId, song) {
  const q = queues.get(guildId);
  if (!q) return;
  const stream = ytdl(song.url, {
    filter: 'audioonly',
    highWaterMark: 1 << 25,
  });
  const resource = createAudioResource(stream);
  q.player.play(resource);
}

// Main message handler
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const [cmd, ...args] = message.content.trim().split(/ +/);
  const arg = args.join(' ');

  if (cmd === '!play') {
    if (!arg) return message.reply('❌ Usage: `!play <song name or URL>`');
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('❌ You need to join a voice channel first.');
    await message.reply('🔍 Searching...');
    let tracks = [];
    if (ytdl.validateURL(arg)) {
      const info = await ytdl.getInfo(arg);
      tracks = [{ title: info.videoDetails.title, url: arg }];
    } else {
      const res = await ytsr(arg, { limit: 1 });
      if (!res.items.length) return message.reply('❌ No results found.');
      tracks = [{ title: res.items[0].title, url: res.items[0].url }];
    }
    const q = await ensureMusic(message.guild.id, vc);
    q.songs.push(...tracks);
    if (q.songs.length === tracks.length) {
      playTrack(message.guild.id, q.songs[0]);
      message.channel.send(`▶️ Now playing: **${tracks[0].title}**`);
    } else {
      message.channel.send(`➕ Added ${tracks.length} track(s) to the queue.`);
    }
    return;
  }

  if (cmd === '!skip') {
    const q = queues.get(message.guild.id);
    if (!q || !q.songs.length) return message.reply('❌ Nothing is playing.');
    q.player.stop();
    message.reply('⏭️ Skipped.');
    return;
  }

  if (cmd === '!stop') {
    const q = queues.get(message.guild.id);
    if (!q) return message.reply('❌ Nothing to stop.');
    q.songs = [];
    q.player.stop();
    q.conn.destroy();
    queues.delete(message.guild.id);
    message.reply('⏹️ Stopped and cleared the queue.');
    return;
  }

  if (cmd === '!loop') {
    const q = queues.get(message.guild.id);
    if (!q) return message.reply('❌ Nothing is playing.');
    q.loop = !q.loop;
    message.reply(`🔁 Loop is now **${q.loop ? 'enabled' : 'disabled'}**.`);
    return;
  }

  if (cmd === '!queue') {
    const q = queues.get(message.guild.id);
    if (!q || !q.songs.length) return message.reply('❌ Queue is empty.');
    const embed = new EmbedBuilder()
      .setTitle('🎶 Current Queue')
      .setDescription(q.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n'));
    message.channel.send({ embeds: [embed] });
    return;
  }

  // Add !dmrole, !dmchannel, and final !hostfriendly next
});
