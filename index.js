import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder
} from 'discord.js';
import {
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior
} from '@discordjs/voice';
import express from 'express';
import ytdl from 'ytdl-core';
import ytsr from 'ytsr';
// import { getTracks } from 'spotify-url-info'; // install & configure your Spotify helper
import 'dotenv/config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Keep-alive server
const app = express();
const port = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('Bot is alive!'));
app.listen(port, () => console.log(`Server on port ${port}`));

// --- Music queue per guild ---
const guildQueues = new Map();

/**
 * Structure for each guildQueue:
 * {
 *   voiceConnection,
 *   audioPlayer,
 *   songs: Array<{ title, url }>,
 *   loop: boolean
 * }
 */

async function connectToVC(channel) {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfMute: false
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
  return connection;
}

async function fetchSpotifyTracks(playlistUrl) {
  // TODO: use spotify-url-info or Spotify Web API to get array of { title, artist }
  // then for each, search YouTube and return { title, url }
  // Placeholder: return []
  return [];
}

async function ensureQueue(guildId, voiceChannel) {
  if (!guildQueues.has(guildId)) {
    // initialize
    const connection = await connectToVC(voiceChannel);
    const player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
    });
    connection.subscribe(player);

    guildQueues.set(guildId, {
      voiceConnection: connection,
      audioPlayer: player,
      songs: [],
      loop: false
    });

    // When a song finishes
    player.on(AudioPlayerStatus.Idle, () => {
      const queue = guildQueues.get(guildId);
      if (!queue) return;
      if (queue.loop && queue.songs.length > 0) {
        // replay current
        playSong(guildId, queue.songs[0]);
      } else {
        // remove first and play next
        queue.songs.shift();
        if (queue.songs.length > 0) {
          playSong(guildId, queue.songs[0]);
        }
      }
    });
  }
  return guildQueues.get(guildId);
}

async function playSong(guildId, song) {
  const queue = guildQueues.get(guildId);
  if (!queue) return;
  const stream = ytdl(song.url, { filter: 'audioonly', highWaterMark: 1 << 25 });
  const resource = createAudioResource(stream);
  queue.audioPlayer.play(resource);
}

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const [cmd, ...args] = message.content.trim().split(' ');
  const lower = cmd.toLowerCase();

  // === Music Commands ===
  if (lower === '!play') {
    const query = args.join(' ');
    if (!query) return message.reply('❌ Usage: `!play <song name or Spotify playlist URL>`');

    // ensure in voice channel
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('❌ You need to join a voice channel first.');

    await message.reply('🔍 Fetching song(s)...');
    let tracks = [];

    if (query.includes('open.spotify.com/playlist')) {
      tracks = await fetchSpotifyTracks(query);
    } else if (ytdl.validateURL(query)) {
      const info = await ytdl.getInfo(query);
      tracks = [{ title: info.videoDetails.title, url: query }];
    } else {
      // YouTube search
      const results = await ytsr(query, { limit: 1 });
      if (results.items.length === 0) return message.reply('❌ No results found.');
      const first = results.items[0];
      tracks = [{ title: first.title, url: first.url }];
    }

    const queue = await ensureQueue(message.guild.id, vc);
    queue.songs.push(...tracks);

    if (queue.songs.length === tracks.length) {
      // first additions → start playing
      playSong(message.guild.id, queue.songs[0]);
      message.channel.send(`▶️ Now playing: **${tracks[0].title}**`);
    } else {
      message.channel.send(`➕ Added ${tracks.length} track(s) to the queue.`);
    }
    return;
  }

  if (lower === '!skip') {
    const queue = guildQueues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) return message.reply('❌ Nothing is playing.');
    queue.audioPlayer.stop(); // triggers next
    message.reply('⏭️ Skipped.');
    return;
  }

  if (lower === '!stop') {
    const queue = guildQueues.get(message.guild.id);
    if (!queue) return message.reply('❌ Nothing to stop.');
    queue.songs = [];
    queue.audioPlayer.stop();
    queue.voiceConnection.destroy();
    guildQueues.delete(message.guild.id);
    message.reply('⏹️ Stopped and cleared the queue.');
    return;
  }

  if (lower === '!loop') {
    const queue = guildQueues.get(message.guild.id);
    if (!queue) return message.reply('❌ Nothing is playing.');
    queue.loop = !queue.loop;
    message.reply(`🔁 Loop is now **${queue.loop ? 'enabled' : 'disabled'}**.`);
    return;
  }

  if (lower === '!queue') {
    const queue = guildQueues.get(message.guild.id);
    if (!queue || queue.songs.length === 0) return message.reply('❌ Queue is empty.');
    const embed = new EmbedBuilder()
      .setTitle('🎶 Current Queue')
      .setDescription(
        queue.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n')
      );
    message.channel.send({ embeds: [embed] });
    return;
  }

  // === Existing Commands (hostfriendly, joinvc, dmrole, dmchannel) ===
  // … your entire previous command-handling code goes here, unchanged …
  // just paste everything you already have under this block
});

client.login(process.env.TOKEN);

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);