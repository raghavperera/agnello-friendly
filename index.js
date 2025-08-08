import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  Events
} from 'discord.js';
import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice';
import express from 'express';
import 'dotenv/config';
import ytdl from 'ytdl-core';

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

const PORT = process.env.PORT || 3000;
const app = express();
app.get('/', (_, res) => res.send('Bot is alive.'));
app.listen(PORT, () => console.log(`Express running on ${PORT}`));

const VC_CHANNEL_ID = '1368359914145058956';
const DEPARTURE_CHANNEL_ID = '1361113558347415728';
const INVITE_LINK = 'https://discord.gg/QqTWBUkPCw';
const cache = new Set();

// JOIN VC AND STAY CONNECTED
client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  const channel = guild.channels.cache.get(VC_CHANNEL_ID);
  if (channel?.isVoiceBased()) {
    joinVC(channel);
  }
});

function joinVC(channel) {
  joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfMute: true
  });
}

// RECONNECT IF DISCONNECTED
client.on('voiceStateUpdate', (oldState, newState) => {
  if (
    oldState.channelId === VC_CHANNEL_ID &&
    !newState.channelId
  ) {
    const channel = oldState.guild.channels.cache.get(VC_CHANNEL_ID);
    if (channel?.isVoiceBased()) joinVC(channel);
  }
});

// !joinvc command
client.on('messageCreate', async msg => {
  if (msg.content === '!joinvc') {
    const channel = msg.guild.channels.cache.get(VC_CHANNEL_ID);
    if (channel?.isVoiceBased()) {
      joinVC(channel);
      msg.reply('Joined and staying in VC.');
    }
  }
});

// !dmrole command
client.on('messageCreate', async msg => {
  if (!msg.content.startsWith('!dmrole')) return;
  const role = msg.mentions.roles.first();
  const content = msg.content.split(' ').slice(2).join(' ');
  if (!role || !content) return msg.reply('Usage: !dmrole @role your message');

  msg.reply(`Sending to ${role.members.size} members...`);

  const failed = [];
  for (const [id, member] of role.members) {
    if (cache.has(id)) continue;
    try {
      await member.send(content);
      cache.add(id);
    } catch {
      failed.push(`<@${id}>`);
    }
  }

  if (failed.length) {
    msg.author.send(`❌ Failed to DM:\n${failed.join('\n')}`);
  }
});

// /dmrole slash command
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'dmrole') {
    const role = interaction.options.getRole('role');
    const message = interaction.options.getString('message');
    await interaction.reply({ content: 'Sending messages...', ephemeral: true });

    const failed = [];
    for (const [id, member] of role.members) {
      if (cache.has(id)) continue;
      try {
        await member.send(message);
        cache.add(id);
      } catch {
        failed.push(`<@${id}>`);
      }
    }

    if (failed.length) {
      interaction.user.send(`❌ Failed to DM:\n${failed.join('\n')}`);
    }
  }
});

// !hostfriendly command
client.on('messageCreate', async msg => {
  if (!msg.content.startsWith('!hostfriendly')) return;
  if (
    !msg.member.roles.cache.some(r => ['Admin', 'Friendlies Department'].includes(r.name))
  ) return msg.reply('You do not have permission.');

  await msg.channel.send('@everyone React if you’re available for a 7v7 friendly!');
  setTimeout(async () => {
    await msg.channel.send('Still looking for players...');
  }, 60 * 1000);
  setTimeout(async () => {
    await msg.channel.send('Friendly cancelled due to lack of reactions.');
  }, 10 * 60 * 1000);
});

// !activitycheck command
client.on('messageCreate', async msg => {
  if (!msg.content.startsWith('!activitycheck')) return;

  const parts = msg.content.split(' ');
  const goal = parseInt(parts[1]) || 40;
  const duration = parts[2] || '1 Day';

  const activityMsg = await msg.channel.send(
    `# 🔥 AGNELLO FC ACTIVITY CHECK 🔥\nReact with 🐐 to confirm!\n**Goal:** ${goal}\n**Duration:** ${duration}\n@everyone`
  );
  await activityMsg.react('🐐');
});

// MUSIC COMMANDS
const queue = new Map();

client.on('messageCreate', async msg => {
  if (!msg.guild || msg.author.bot) return;
  const args = msg.content.split(' ');
  const serverQueue = queue.get(msg.guild.id);

  if (args[0] === '!play') {
    const voiceChannel = msg.member.voice.channel;
    if (!voiceChannel) return msg.reply('Join a VC first!');
    const permissions = voiceChannel.permissionsFor(msg.client.user);
    if (!permissions.has(PermissionsBitField.Flags.Connect)) return;
    const songInfo = await ytdl.getInfo(args[1]);
    const song = { title: songInfo.videoDetails.title, url: songInfo.videoDetails.video_url };

    if (!serverQueue) {
      const queueContruct = { textChannel: msg.channel, voiceChannel, connection: null, songs: [], playing: true };
      queue.set(msg.guild.id, queueContruct);
      queueContruct.songs.push(song);

      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: msg.guild.id,
          adapterCreator: msg.guild.voiceAdapterCreator
        });
        queueContruct.connection = connection;
        play(msg.guild, queueContruct.songs[0]);
      } catch (err) {
        console.error(err);
        queue.delete(msg.guild.id);
      }
    } else {
      serverQueue.songs.push(song);
      msg.channel.send(`🎵 Added: **${song.title}**`);
    }
  }

  if (args[0] === '!skip') {
    if (!serverQueue) return msg.reply('Nothing to skip.');
    serverQueue.connection.dispatcher.end();
  }

  if (args[0] === '!stop') {
    if (!serverQueue) return msg.reply('Nothing is playing.');
    serverQueue.songs = [];
    serverQueue.connection.destroy();
    queue.delete(msg.guild.id);
    msg.channel.send('⏹️ Stopped.');
  }

  if (args[0] === '!queue') {
    if (!serverQueue || !serverQueue.songs.length) return msg.reply('Queue is empty.');
    msg.channel.send(serverQueue.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n'));
  }
});

function play(guild, song) {
  const serverQueue = queue.get(guild.id);
  if (!song) {
    serverQueue.voiceChannel.leave();
    queue.delete(guild.id);
    return;
  }

  const stream = ytdl(song.url, { filter: 'audioonly' });
  const dispatcher = serverQueue.connection.play(stream);
  dispatcher.on('finish', () => {
    serverQueue.songs.shift();
    play(guild, serverQueue.songs[0]);
  });

  serverQueue.textChannel.send(`🎶 Now playing: **${song.title}**`);
}

// DM USER WHO LEAVES
client.on('guildMemberRemove', async member => {
  const channel = member.guild.channels.cache.get(DEPARTURE_CHANNEL_ID);
  if (channel?.isTextBased()) {
    channel.send(`😢 **${member.user.tag}** has left the server.`);
  }

  try {
    await member.send(`We noticed you left... We’d love to have you back at Agnello FC!\nRejoin here: ${INVITE_LINK}`);
  } catch (e) {
    console.log(`Couldn't DM ${member.user.tag}`);
  }
});

client.login(process.env.TOKEN);