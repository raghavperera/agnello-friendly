import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder
} from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, AudioPlayerStatus } from '@discordjs/voice';
import express from 'express';
import ytdl from 'ytdl-core';
import 'dotenv/config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

const queue = new Map();
const voiceChannelId = '1368359914145058956';
const goodbyeChannelId = '1361113558347415728';
const welcomeChannelId = '1361113546829729914';
const serverInviteLink = 'https://discord.gg/QqTWBUkPCw';

// Welcome new members
client.on('guildMemberAdd', async member => {
  try {
    await member.send(`👋 Welcome to the team, ${member.user.username}! Glad to have you with us. -mossedbyerts`);
    const welcomeChannel = member.guild.channels.cache.get(welcomeChannelId);
    if (welcomeChannel) {
      welcomeChannel.send(`Welcome <@${member.id}> to Agnello FC!`);
    }
  } catch (err) {
    console.error('Error sending welcome DM:', err);
  }
});

// Goodbye message
client.on('guildMemberRemove', async member => {
  try {
    const goodbyeChannel = member.guild.channels.cache.get(goodbyeChannelId);
    if (goodbyeChannel) {
      goodbyeChannel.send(`😢 ${member.user.tag} has left the server.`);
    }
    await member.send(`We're sorry to see you go, ${member.user.username}. Coming from Erts, if you left because of inactivity or something else, feel free to dm mossedbyerts.If you ever want to come back, here's the invite: ${serverInviteLink}`);
  } catch (err) {
    console.error('Failed to send goodbye message:', err);
  }
});

// !joinvc command
client.on('messageCreate', async message => {
  if (message.content === '!joinvc') {
    const channel = client.channels.cache.get(voiceChannelId);
    if (channel && channel.isVoiceBased()) {
      joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfMute: true
      });
      message.reply('Joined VC!');
    }
  }
});

// !hostfriendly command
const positionEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
const positionNames = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
let ongoingHost = false;

client.on('messageCreate', async message => {
  if (!message.content.startsWith('!hostfriendly') || message.author.bot) return;

  if (ongoingHost) {
    return message.reply('A friendly is already being hosted.');
  }

  const allowedRoles = ['Admin', 'Friendlies Department'];
  const hasPermission = message.member.roles.cache.some(role => allowedRoles.includes(role.name));
  if (!hasPermission) return message.reply('You don’t have permission to host a friendly.');

  ongoingHost = true;

  const posMessage = await message.channel.send(
    `**AGNELLO FC 7v7 FRIENDLY**\n` +
    `React to claim a position:\n\n` +
    `1️⃣ → GK\n2️⃣ → CB\n3️⃣ → CB2\n4️⃣ → CM\n5️⃣ → LW\n6️⃣ → RW\n7️⃣ → ST\n\n@everyone`
  );

  for (const emoji of positionEmojis) {
    await posMessage.react(emoji);
  }

  const collectedReactions = {};
  const claimedUsers = new Set();

  const collector = posMessage.createReactionCollector({
    filter: (reaction, user) => !user.bot && positionEmojis.includes(reaction.emoji.name),
    time: 10 * 60 * 1000 // 10 minutes
  });

  collector.on('collect', async (reaction, user) => {
    if (claimedUsers.has(user.id)) {
      await reaction.users.remove(user.id); // Remove if user already claimed a spot
      return;
    }

    const index = positionEmojis.indexOf(reaction.emoji.name);
    if (!collectedReactions[index]) {
      collectedReactions[index] = user;
      claimedUsers.add(user.id);
      message.channel.send(`✅ ${positionNames[index]}-<@${user.id}>`);

      // All positions filled
      if (Object.keys(collectedReactions).length === 7) {
        collector.stop('filled');
      }
    } else {
      await reaction.users.remove(user.id); // Position already taken
    }
  });

  // 1 minute warning if not enough reacts
  setTimeout(() => {
    if (Object.keys(collectedReactions).length < 7) {
      message.channel.send('@everyone more reacts to get a friendly.');
    }
  }, 60 * 1000);

  collector.on('end', async (_, reason) => {
    if (reason !== 'filled') {
      if (Object.keys(collectedReactions).length < 7) {
        await message.channel.send('❌ Friendly cancelled due to not enough players.');
        ongoingHost = false;
        return;
      }
    }

    // Final lineup
    let finalLineup = '**FRIENDLY LINEUP**\n';
    for (let i = 0; i < positionEmojis.length; i++) {
      const user = collectedReactions[i];
      if (user) {
        finalLineup += `${positionNames[i]} → <@${user.id}>\n`;
      }
    }
    await message.channel.send(finalLineup);
    await message.channel.send('✅ Finding friendly, looking for a link by a hoster.');

    const userIdsToDM = Object.values(collectedReactions).map(user => user.id);

    // Watch for link from host and DM everyone
    const linkCollector = message.channel.createMessageCollector({
      filter: msg => msg.author.id === message.author.id && msg.content.includes('http'),
      time: 5 * 60 * 1000,
      max: 1
    });

    linkCollector.on('collect', async msg => {
      for (const userId of userIdsToDM) {
        try {
          const member = await message.guild.members.fetch(userId);
          await member.send(`Here’s the friendly, join up: ${msg.content}`);
        } catch (err) {
          console.error(`Failed to DM ${userId}:`, err.message);
        }
      }
    });

    ongoingHost = false;
  });
});

// !activitycheck command
client.on('messageCreate', async message => {
  if (message.content.startsWith('!activitycheck')) {
    const parts = message.content.split(' ');
    const goal = parseInt(parts[1]) || 40;
    const embed = new EmbedBuilder()
      .setTitle('📋 Agnello FC Activity Check')
      .setDescription(`React with ✅ to confirm you're active!\n**Goal:** ${goal}\n**Duration:** 1 day\n@everyone`)
      .setColor(0x00FF00)
      .setTimestamp();

    const activityMsg = await message.channel.send({ embeds: [embed] });
    activityMsg.react('✅');
  }
});

// MUSIC COMMANDS

async function playSong(guild, song) {
  const serverQueue = queue.get(guild.id);
  if (!song) {
    serverQueue.voiceConnection.destroy();
    queue.delete(guild.id);
    return;
  }

  const stream = ytdl(song.url, { filter: 'audioonly' });
  const resource = createAudioResource(stream);
  serverQueue.audioPlayer.play(resource);

  serverQueue.audioPlayer.once(AudioPlayerStatus.Idle, () => {
    serverQueue.songs.shift();
    playSong(guild, serverQueue.songs[0]);
  });
}

client.on('messageCreate', async message => {
  if (!message.content.startsWith('!')) return;
  const serverQueue = queue.get(message.guild.id);
  const args = message.content.split(' ');

  if (message.content.startsWith('!play')) {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('Join a voice channel first!');
    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has(PermissionsBitField.Flags.Connect) || !permissions.has(PermissionsBitField.Flags.Speak)) {
      return message.reply('Missing permissions to join and speak!');
    }

    const songInfo = await ytdl.getInfo(args[1]);
    const song = { title: songInfo.videoDetails.title, url: songInfo.videoDetails.video_url };

    let serverQueue = queue.get(message.guild.id);
    if (!serverQueue) {
      const audioPlayer = createAudioPlayer();
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
      });

      const queueContruct = {
        textChannel: message.channel,
        voiceConnection: connection,
        audioPlayer,
        songs: [],
        loop: false
      };

      queue.set(message.guild.id, queueContruct);
      queueContruct.songs.push(song);
      playSong(message.guild, song);
    } else {
      serverQueue.songs.push(song);
      return message.reply(`✅ Added to queue: **${song.title}**`);
    }
  }

  if (message.content.startsWith('!skip')) {
    if (!serverQueue) return message.reply('Nothing to skip!');
    serverQueue.audioPlayer.stop();
    message.reply('⏭ Skipped!');
  }

  if (message.content.startsWith('!stop')) {
    if (!serverQueue) return;
    serverQueue.audioPlayer.stop();
    serverQueue.voiceConnection.destroy();
    queue.delete(message.guild.id);
    message.reply('🛑 Stopped and left VC!');
  }

  if (message.content.startsWith('!queue')) {
    if (!serverQueue || !serverQueue.songs.length) return message.reply('Queue is empty!');
    message.reply(`🎶 Queue:\n${serverQueue.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`);
  }

  if (message.content.startsWith('!loop')) {
    if (!serverQueue) return;
    serverQueue.loop = !serverQueue.loop;
    message.reply(`🔁 Loop is now ${serverQueue.loop ? 'ON' : 'OFF'}`);
  }
});

// Stay alive (Render)
const app = express();
app.get('/', (req, res) => res.send('Bot is alive'));
app.listen(3000, () => console.log('Express server running'));

client.login(process.env.TOKEN);