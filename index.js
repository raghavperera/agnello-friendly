import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder
} from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, VoiceConnectionStatus, AudioPlayerStatus, NoSubscriberBehavior } from '@discordjs/voice';
import ytdl from 'ytdl-core';
import express from 'express';
import 'dotenv/config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

// Music player setup
const queue = new Map();
const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });

client.on('messageCreate', async message => {
  if (!message.guild || message.author.bot) return;
  const prefix = '!';

  // PLAY COMMAND
  if (message.content.startsWith(`${prefix}play`)) {
    const args = message.content.split(' ').slice(1);
    const url = args[0];
    if (!url || !ytdl.validateURL(url)) return message.channel.send('Please provide a valid YouTube URL.');

    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('Join a voice channel first.');

    const serverQueue = queue.get(message.guild.id);
    const song = { title: url, url };

    if (!serverQueue) {
      const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false
      });

      const songs = [song];
      queue.set(message.guild.id, { voiceChannel, connection, songs });

      playSong(message.guild, song);
      message.channel.send(`🎶 Playing: ${song.title}`);
    } else {
      serverQueue.songs.push(song);
      message.channel.send(`🎶 Queued: ${song.title}`);
    }
  }

  // SKIP
  if (message.content.startsWith(`${prefix}skip`)) {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue) return message.channel.send('Nothing to skip!');
    serverQueue.connection.destroy();
    queue.delete(message.guild.id);
    message.channel.send('⏭️ Skipped!');
  }

  // STOP
  if (message.content.startsWith(`${prefix}stop`)) {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue) return;
    serverQueue.connection.destroy();
    queue.delete(message.guild.id);
    message.channel.send('⏹️ Music stopped.');
  }

  // QUEUE
  if (message.content.startsWith(`${prefix}queue`)) {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) return message.channel.send('The queue is empty.');
    const q = serverQueue.songs.map((s, i) => `${i + 1}. ${s.title}`).join('\n');
    message.channel.send(`🎵 **Queue:**\n${q}`);
  }

  // LOOP (simple restart)
  if (message.content.startsWith(`${prefix}loop`)) {
    const serverQueue = queue.get(message.guild.id);
    if (!serverQueue || serverQueue.songs.length === 0) return message.channel.send('Nothing to loop.');
    serverQueue.songs.push(serverQueue.songs[0]);
    message.channel.send('🔁 Looping current song.');
  }

  // JOIN VC
  if (message.content === '!joinvc') {
    const vcId = '1368359914145058956';
    const guild = message.guild;
    joinVoiceChannel({
      channelId: vcId,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true
    });
    message.channel.send(`✅ Joined VC.`);
  }

  // HOSTFRIENDLY
  if (message.content.startsWith('!hostfriendly')) {
    const positions = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
    const claimed = {};

    const msg = await message.channel.send(
      `@everyone\n**PARMA FC 7v7 FRIENDLY**\nReact:\n${numberEmojis.map((e, i) => `${e} → ${positions[i]}`).join('\n')}`
    );

    for (const emoji of numberEmojis) await msg.react(emoji);

    const collector = msg.createReactionCollector({ time: 600000 });

    collector.on('collect', async (reaction, user) => {
      if (user.bot) return;

      const emojiIndex = numberEmojis.indexOf(reaction.emoji.name);
      if (emojiIndex === -1) return;

      const pos = positions[emojiIndex];

      if (Object.values(claimed).includes(user.id)) {
        reaction.users.remove(user.id);
        return user.send('❌ You already picked a position.');
      }

      if (claimed[pos]) {
        reaction.users.remove(user.id);
        return user.send('❌ Position already taken.');
      }

      claimed[pos] = user.id;
      message.channel.send(`✅ ${pos} confirmed for <@${user.id}>`);

      if (Object.keys(claimed).length === 7) {
        collector.stop('filled');
        const lineup = positions.map(p => `${p}: <@${claimed[p] || 'unclaimed'}>`).join('\n');
        message.channel.send(`**Lineup Filled!**\n${lineup}\nFinding friendly, looking for a rob.`);
      }
    });

    setTimeout(() => {
      if (Object.keys(claimed).length < 7) {
        message.channel.send('❌ Not enough players. Friendly cancelled.');
      }
    }, 600000);
  }

  // ACTIVITY CHECK
  if (message.content.startsWith('!activitycheck')) {
    const args = message.content.split(' ').slice(1);
    const goal = args[0] || '40';
    const emoji = args[1] || '🟢';

    const embed = new EmbedBuilder()
      .setTitle('#  *<:RFL:1360413714175492246> - <:Palmont:1357102365697642697> | Agnello FC Activity Check*')
      .setDescription(`**React with:** ${emoji}\n**Goal:** ${goal}\n**Duration:** 1 Day\n@everyone`)
      .setColor('Blue');

    const msg = await message.channel.send({ embeds: [embed] });
    msg.react(emoji);
  }
});

// MUSIC PLAY FUNCTION
function playSong(guild, song) {
  const serverQueue = queue.get(guild.id);
  if (!song) {
    serverQueue.connection.destroy();
    queue.delete(guild.id);
    return;
  }

  const stream = ytdl(song.url, { filter: 'audioonly' });
  const resource = createAudioResource(stream);
  serverQueue.connection.subscribe(player);
  player.play(resource);

  player.once(AudioPlayerStatus.Idle, () => {
    serverQueue.songs.shift();
    playSong(guild, serverQueue.songs[0]);
  });
}

// MEMBER LEAVE EVENT
client.on('guildMemberRemove', async member => {
  try {
    await member.send(
      `We're sorry to see you leave **Agnello FC**.\nWe’d love to have you back! Here’s the invite: https://discord.gg/QqTWBUkPCw`
    );
  } catch (err) {
    console.log(`Failed to DM ${member.user.tag}`);
  }
});

// KEEP ALIVE SERVER
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(3000, () => console.log('Keep-alive server ready.'));

client.login(process.env.TOKEN);