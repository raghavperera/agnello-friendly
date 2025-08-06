
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import express from 'express';
import { createAudioPlayer, createAudioResource, AudioPlayerStatus, StreamType, getVoiceConnection } from '@discordjs/voice';
import play from 'play-dl';
import 'dotenv/config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

const expressApp = express();
expressApp.get('/', (req, res) => res.send('Agnello FC bot is online!'));
expressApp.listen(3000, () => console.log('Express server running'));

let cachedDMs = new Set();
let currentVoiceConnection;

// Auto join VC
async function joinVC(guild) {
  const channel = guild.channels.cache.get('1368359914145058956');
  if (!channel || channel.type !== 2) return;
  currentVoiceConnection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfMute: true
  });
  entersState(currentVoiceConnection, VoiceConnectionStatus.Ready, 30_000);
}

// Reconnect on disconnect
client.on('voiceStateUpdate', (_, newState) => {
  if (!newState.channelId && currentVoiceConnection) {
    joinVC(newState.guild).catch(console.error);
  }
});

// ✅ on @everyone
client.on('messageCreate', async msg => {
  if (msg.mentions.everyone) {
    try {
      await msg.react('✅');
    } catch {}
  }
});

// Music commands
const queue = new Map();

async function execute(message, serverQueue) {
  const args = message.content.split(' ');
  const voiceChannel = message.member.voice.channel;
  if (!voiceChannel) return message.reply('Join a VC first.');
  const permissions = voiceChannel.permissionsFor(message.client.user);
  if (!permissions.has('Connect') || !permissions.has('Speak')) return;

  const songInfo = await play.search(args.slice(1).join(' '), { limit: 1 });
  if (!songInfo.length) return message.reply('No results.');
  const song = {
    title: songInfo[0].title,
    url: songInfo[0].url
  };

  if (!serverQueue) {
    const queueContruct = {
      textChannel: message.channel,
      voiceChannel,
      connection: null,
      songs: [],
      volume: 5,
      playing: true,
      loop: false
    };
    queue.set(message.guild.id, queueContruct);
    queueContruct.songs.push(song);

    try {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
      });
      queueContruct.connection = connection;
      playSong(message.guild, queueContruct.songs[0]);
    } catch (err) {
      queue.delete(message.guild.id);
      console.error(err);
      return message.reply(err.message);
    }
  } else {
    serverQueue.songs.push(song);
    return message.reply(`${song.title} added to queue.`);
  }
}

function playSong(guild, song) {
  const serverQueue = queue.get(guild.id);
  if (!song) {
    serverQueue.connection.destroy();
    queue.delete(guild.id);
    return;
  }

  play.stream(song.url).then(stream => {
    const resource = createAudioResource(stream.stream, {
      inputType: stream.type
    });
    const player = createAudioPlayer();
    player.play(resource);
    serverQueue.connection.subscribe(player);

    player.on(AudioPlayerStatus.Idle, () => {
      if (!serverQueue.loop) serverQueue.songs.shift();
      playSong(guild, serverQueue.songs[0]);
    });

    serverQueue.textChannel.send(`Now playing: **${song.title}**`);
  });
}

client.on('messageCreate', async message => {
  if (!message.content.startsWith('!') || message.author.bot) return;

  const serverQueue = queue.get(message.guild.id);

  if (message.content.startsWith('!play')) execute(message, serverQueue);
  else if (message.content.startsWith('!skip')) {
    if (!serverQueue) return message.reply('No song to skip.');
    serverQueue.songs.shift();
    playSong(message.guild, serverQueue.songs[0]);
  } else if (message.content.startsWith('!stop')) {
    if (!serverQueue) return;
    serverQueue.songs = [];
    serverQueue.connection.destroy();
    queue.delete(message.guild.id);
  } else if (message.content.startsWith('!loop')) {
    if (!serverQueue) return;
    serverQueue.loop = !serverQueue.loop;
    message.reply(`Looping is now ${serverQueue.loop ? 'enabled' : 'disabled'}.`);
  } else if (message.content.startsWith('!queue')) {
    if (!serverQueue) return message.reply('No songs in queue.');
    message.reply(serverQueue.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n'));
  }
});

// Additional features (e.g. hostfriendly, dmrole, activitycheck) will be appended next
