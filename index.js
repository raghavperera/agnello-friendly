// index.js

import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ActivityType,
  Events,
  Collection
} from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import express from 'express';
import 'dotenv/config';
import play from 'play-dl';

const TOKEN = process.env.TOKEN;
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Constants
const AGNELLO_VC_ID = '1368359914145058956';
const AGNELLO_CHANNEL_ID = '1325529675912450239';
const AGNELLO_INVITE = 'https://discord.gg/cbpWRu6xn5';
const REQUIRED_ROLES = ['Admin', 'Friendlies Department'];
const POSITION_EMOJIS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
const POSITIONS = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
const DM_CACHE = new Set();

// Express server for uptime (Render)
const app = express();
app.get('/', (_, res) => res.send('Bot is alive!'));
app.listen(3000, () => console.log('Express server is up.'));

// VC auto-connect + reconnect
async function connectToVC() {
  const guild = await client.guilds.fetch(process.env.GUILD_ID);
  const channel = guild.channels.cache.get(AGNELLO_VC_ID);
  if (!channel || channel.type !== 2) return;

  const connection = joinVoiceChannel({
    channelId: AGNELLO_VC_ID,
    guildId: guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfMute: true
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    setTimeout(() => connectToVC(), 5000);
  });
}

// Ready
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await connectToVC();
  client.user.setActivity('Agnello FC 🔵⚪', { type: ActivityType.Watching });
});

// ✅ reaction on @everyone/@here
client.on('messageCreate', async message => {
  if (message.mentions.everyone || message.content.includes('@everyone') || message.content.includes('@here')) {
    try {
      await message.react('✅');
    } catch (err) {
      console.error('Reaction error:', err);
    }
  }
});

// !dmrole command (prefix)
client.on('messageCreate', async message => {
  if (!message.content.startsWith('!dmrole')) return;

  const [cmd, ...args] = message.content.split(' ');
  const roleMention = message.mentions.roles.first();
  if (!roleMention) return message.reply('Mention a role.');

  const msgToSend = args.slice(1).join(' ');
  if (!msgToSend) return message.reply('Include a message.');

  const members = roleMention.members;
  const failed = [];

  await message.reply(`Dming ${members.size} users...`);
  for (const [_, member] of members) {
    if (DM_CACHE.has(member.id)) continue;
    try {
      await member.send(msgToSend);
      DM_CACHE.add(member.id);
    } catch {
      failed.push(`<@${member.id}>`);
    }
  }

  if (failed.length) {
    message.author.send(`Failed to DM:\n${failed.join('\n')}`);
  }
});

// !activitycheck <goal>
client.on('messageCreate', async message => {
  if (!message.content.startsWith('!activitycheck')) return;
  const args = message.content.split(' ');
  const goal = args[1] || '40';

  const embed = new EmbedBuilder()
    .setTitle(`#  <:RFL:1360413714175492246> - <:Palmont:1357102365697642697> | Agnello FC Activity Check`)
    .setDescription(`**React with:** <:Palmont:1357102365697642697>\n\n**Goal:** ${goal}\n**Duration:** 1 Day`)
    .setColor('DarkBlue');

  const sent = await message.channel.send({ content: '@everyone', embeds: [embed] });
  await sent.react('<:Palmont:1357102365697642697>');
});

// !hostfriendly
client.on('messageCreate', async message => {
  if (!message.content.startsWith('!hostfriendly')) return;
  if (!message.member.roles.cache.some(role => REQUIRED_ROLES.includes(role.name))) {
    return message.reply('You need to be Admin or Friendlies Department.');
  }

  let claimed = {};
  let claimedUsers = new Set();
  const embed = new EmbedBuilder()
    .setTitle(`**AGNELLO FC 7v7 FRIENDLY**`)
    .setDescription(POSITIONS.map((pos, i) => `React ${POSITION_EMOJIS[i]} → ${pos}`).join('\n') + '\n@everyone')
    .setColor('Green');

  const friendlyMsg = await message.channel.send({ embeds: [embed] });
  for (const emoji of POSITION_EMOJIS) await friendlyMsg.react(emoji);

  const collector = friendlyMsg.createReactionCollector({ time: 10 * 60 * 1000 });

  collector.on('collect', async (reaction, user) => {
    if (user.bot) return;

    await new Promise(r => setTimeout(r, 3000)); // wait 3 seconds
    const existing = Object.values(claimed).find(u => u === user.id);
    if (existing) return;

    const index = POSITION_EMOJIS.indexOf(reaction.emoji.name);
    if (index === -1 || claimed[POSITIONS[index]]) return;

    claimed[POSITIONS[index]] = user.id;
    claimedUsers.add(user.id);

    const desc = POSITIONS.map((pos, i) => {
      const userId = claimed[POSITIONS[i]];
      return `React ${POSITION_EMOJIS[i]} → ${pos}${userId ? ` - <@${userId}>` : ''}`;
    }).join('\n') + '\n@everyone';

    embed.setDescription(desc);
    await friendlyMsg.edit({ embeds: [embed] });
    await message.channel.send(`✅ ${POSITIONS[index]} confirmed for <@${user.id}>`);

    if (Object.keys(claimed).length === POSITIONS.length) {
      collector.stop();
      const lineup = POSITIONS.map(pos => `${pos}: <@${claimed[pos]}>`).join('\n');
      await message.channel.send(`**Final Lineup:**\n${lineup}`);
      await message.channel.send('Finding friendly, looking for a rob...');
    }
  });

  // After 1 minute
  setTimeout(() => {
    if (Object.keys(claimed).length < 7) {
      message.channel.send('@everyone More reacts to get a friendly!');
    }
  }, 60 * 1000);

  // After 10 minutes
  collector.on('end', () => {
    if (Object.keys(claimed).length < 7) {
      message.channel.send('❌ Friendly cancelled — not enough players.');
    }
  });

  // Watch for Roblox link
  const robloxFilter = m => m.author.id === message.author.id && m.content.includes('roblox.com/games/');
  const linkCollector = message.channel.createMessageCollector({ filter: robloxFilter, time: 30 * 60 * 1000 });

  linkCollector.on('collect', async m => {
    const players = Object.values(claimed);
    for (const userId of players) {
      try {
        const user = await client.users.fetch(userId);
        await user.send(`Here’s the friendly, join up: ${m.content}`);
      } catch {}
    }
    linkCollector.stop();
  });
});

// MUSIC SYSTEM

const queue = new Map();

client.on('messageCreate', async message => {
  if (!message.content.startsWith('!')) return;
  const args = message.content.split(' ');
  const cmd = args.shift().toLowerCase();
  const serverQueue = queue.get(message.guild.id);

  if (cmd === '!play') {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('Join a VC.');

    const songInfo = await play.search(args.join(' '), { limit: 1 });
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
        loop: false
      };

      queue.set(message.guild.id, queueContruct);
      queueContruct.songs.push(song);

      try {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: voiceChannel.guild.id,
          adapterCreator: voiceChannel.guild.voiceAdapterCreator,
          selfMute: false
        });

        queueContruct.connection = connection;
        playSong(message.guild.id, queueContruct.songs[0]);
      } catch (err) {
        console.error(err);
        queue.delete(message.guild.id);
      }
    } else {
      serverQueue.songs.push(song);
      return message.channel.send(`${song.title} added to queue`);
    }
  }

  if (cmd === '!skip') {
    if (!serverQueue) return;
    serverQueue.connection.dispatcher.end();
  }

  if (cmd === '!stop') {
    if (!serverQueue) return;
    serverQueue.songs = [];
    serverQueue.connection.dispatcher.end();
  }

  if (cmd === '!queue') {
    if (!serverQueue) return message.channel.send('No songs.');
    return message.channel.send(serverQueue.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n'));
  }

  if (cmd === '!loop') {
    if (!serverQueue) return;
    serverQueue.loop = !serverQueue.loop;
    message.channel.send(`Loop is now ${serverQueue.loop ? 'on' : 'off'}`);
  }
});

async function playSong(guildId, song) {
  const serverQueue = queue.get(guildId);
  if (!song) {
    queue.delete(guildId);
    return;
  }

  const stream = await play.stream(song.url);
  const resource = createAudioResource(stream.stream, { inputType: stream.type });
  const player = createAudioPlayer();
  player.play(resource);
  serverQueue.connection.subscribe(player);

  player.on(AudioPlayerStatus.Idle, () => {
    if (!serverQueue.loop) serverQueue.songs.shift();
    playSong(guildId, serverQueue.songs[0]);
  });
}

client.login(TOKEN);