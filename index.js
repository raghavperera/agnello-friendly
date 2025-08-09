import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} from '@discordjs/voice';
import express from 'express';
import ytdl from 'ytdl-core';
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

const queue = new Map();
const voiceChannelId = '1368359914145058956';
const welcomeChannelId = '1361113546829729914';
const goodbyeChannelId = '1361113558347415728';
const inviteLink = 'https://discord.gg/QqTWBUkPCw';

// WELCOME
client.on('guildMemberAdd', async member => {
  try {
    await member.send(`👋 Welcome to the team, ${member.user.username}! Glad to have you with us. - mossedbyerts`);
    const channel = member.guild.channels.cache.get(welcomeChannelId);
    if (channel) channel.send(`Welcome <@${member.id}> to Agnello FC!`);
  } catch (err) {
    console.error('Welcome DM failed:', err);
  }
});

// GOODBYE
client.on('guildMemberRemove', async member => {
  try {
    const channel = member.guild.channels.cache.get(goodbyeChannelId);
    if (channel) channel.send(`😢 ${member.user.tag} has left the server.`);
    await member.send(`We're sorry to see you go, ${member.user.username}. If you ever want to return, here's the invite: ${inviteLink}`);
  } catch (err) {
    console.error('Goodbye DM failed:', err);
  }
});

// AUTO VC CONNECT
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  const channel = client.channels.cache.get(voiceChannelId);
  if (channel && channel.isVoiceBased()) {
    joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfMute: true
    });
  }
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (oldState.member.id === client.user.id && !newState.channelId) {
    const channel = client.channels.cache.get(voiceChannelId);
    if (channel && channel.isVoiceBased()) {
      joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfMute: true
      });
    }
  }
});

// !joinvc
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

// !hostfriendly
const positionEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
const positionNames = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];

client.on('messageCreate', async message => {
  if (!message.content.startsWith('!hostfriendly') || message.author.bot) return;

  const allowedRoles = ['Admin', 'Friendlies Department'];
  const hasPermission = message.member.roles.cache.some(r => allowedRoles.includes(r.name));
  if (!hasPermission) return message.reply('You don’t have permission to host.');

  let claimed = Array(7).fill(null);
  let claimedUsers = new Set();

  const buildLineup = () =>
    `**AGNELLO FC 7v7 FRIENDLY**\n` +
    positionEmojis.map((emoji, i) =>
      `${emoji} → ${positionNames[i]}: ${claimed[i] ? `<@${claimed[i]}>` : '---'}`
    ).join('\n') +
    `\n\n@everyone`;

  const msg = await message.channel.send(buildLineup());
  for (let emoji of positionEmojis) await msg.react(emoji);

  const collector = msg.createReactionCollector({
    filter: (reaction, user) => !user.bot && positionEmojis.includes(reaction.emoji.name),
    time: 10 * 60 * 1000
  });

  collector.on('collect', async (reaction, user) => {
    if (claimedUsers.has(user.id)) {
      await reaction.users.remove(user.id);
      return;
    }
    const index = positionEmojis.indexOf(reaction.emoji.name);
    if (!claimed[index]) {
      await new Promise(r => setTimeout(r, 3000));
      if (claimedUsers.has(user.id)) {
        await reaction.users.remove(user.id);
        return;
      }
      claimed[index] = user.id;
      claimedUsers.add(user.id);
      await msg.edit(buildLineup());
      await message.channel.send(`✅ ${positionNames[index]} confirmed for <@${user.id}>`);
      if (claimed.every(c => c)) collector.stop('filled');
    } else {
      await reaction.users.remove(user.id);
    }
  });

  setTimeout(() => {
    if (claimed.filter(Boolean).length < 7) {
      message.channel.send('@everyone more reacts to get a friendly.');
    }
  }, 60 * 1000);

  collector.on('end', async (_, reason) => {
    if (reason !== 'filled' && claimed.filter(Boolean).length < 7) {
      return message.channel.send('❌ Friendly cancelled due to not enough players.');
    }
    let finalLineup = '**FRIENDLY LINEUP**\n' +
      claimed.map((id, i) => `${positionNames[i]} → <@${id}>`).join('\n');
    await message.channel.send(finalLineup);
    await message.channel.send('✅ Finding friendly, waiting for host link...');

    const userIds = claimed.filter(Boolean);
    const linkCollector = message.channel.createMessageCollector({
      filter: m => m.author.id === message.author.id && m.content.includes('http'),
      max: 1,
      time: 5 * 60 * 1000
    });
    linkCollector.on('collect', async m => {
      for (let uid of userIds) {
        try {
          const member = await message.guild.members.fetch(uid);
          await member.send(`Here’s the friendly, join up: ${m.content}`);
        } catch {}
      }
    });
  });
});

// !activitycheck
client.on('messageCreate', async message => {
  if (message.content.startsWith('!activitycheck')) {
    const goal = parseInt(message.content.split(' ')[1]) || 40;
    const msg = await message.channel.send(
      `# 📋 Agnello FC Activity Check\nReact with ✅ to confirm you're active!\n**Goal:** ${goal}\n**Duration:** 1 day\n@everyone`
    );
    msg.react('✅');
  }
});

// !dmrole
client.on('messageCreate', async message => {
  if (message.content.startsWith('!dmrole')) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('No permission.');
    }
    const roleName = message.content.split(' ').slice(1).join(' ');
    if (!roleName) return message.reply('Specify a role.');
    const role = message.guild.roles.cache.find(r => r.name === roleName);
    if (!role) return message.reply('Role not found.');

    message.reply(`📨 Dming role: ${role.name}...`);
    const failed = [];
    const sent = new Set();

    for (const member of role.members.values()) {
      if (sent.has(member.id)) continue;
      sent.add(member.id);
      try {
        await member.send(`Hello from Agnello FC!`);
      } catch {
        failed.push(member.user.tag);
      }
    }

    if (failed.length) {
      message.author.send(`❌ Failed to DM:\n${failed.join('\n')}`);
    } else {
      message.author.send(`✅ All members in ${role.name} DMed successfully.`);
    }
  }
});

// MUSIC
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
  const args = message.content.split(' ');
  let serverQueue = queue.get(message.guild.id);

  if (message.content.startsWith('!play')) {
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('Join a VC first!');
    const perms = vc.permissionsFor(message.client.user);
    if (!perms.has(PermissionsBitField.Flags.Connect) || !perms.has(PermissionsBitField.Flags.Speak)) {
      return message.reply('No permission to join/speak.');
    }
    const songInfo = await ytdl.getInfo(args[1]);
    const song = { title: songInfo.videoDetails.title, url: songInfo.videoDetails.video_url };

    if (!serverQueue) {
      const audioPlayer = createAudioPlayer();
      const connection = joinVoiceChannel({
        channelId: vc.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
      });
      serverQueue = { textChannel: message.channel, voiceConnection: connection, audioPlayer, songs: [], loop: false };
      queue.set(message.guild.id, serverQueue);
      serverQueue.songs.push(song);
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
    if (!serverQueue || !serverQueue.songs.length) return message.reply('Queue empty!');
    message.reply(`🎶 Queue:\n${serverQueue.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}`);
  }

  if (message.content.startsWith('!loop')) {
    if (!serverQueue) return;
    serverQueue.loop = !serverQueue.loop;
    message.reply(`🔁 Loop is now ${serverQueue.loop ? 'ON' : 'OFF'}`);
  }
});

// EXPRESS KEEP-ALIVE
const app = express();
app.get('/', (req, res) => res.send('Bot is alive'));
app.listen(3000, () => console.log('Express server running'));

client.login(process.env.TOKEN);