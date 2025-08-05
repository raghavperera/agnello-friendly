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

// Create client
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
  // Show "Listening to Spotify"
  client.user.setActivity('Spotify', { type: ActivityType.Listening });
  // Auto join VC
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

// React ✅ to @everyone/@here
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

  // === Music Commands ===
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

  // === !dmrole Prefix ===
  if (cmd === '!dmrole') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    const role = message.mentions.roles.first();
    if (!role) return message.reply('❌ Please mention a role.');
    const text = arg.replace(/<@&\d+>/, '').trim();
    const failed = [];
    await message.reply(`📨 Sending to **${role.name}**...`);
    for (const m of role.members.values()) {
      if (dmCache.has(m.id)) continue;
      try {
        await m.send(text);
        dmCache.add(m.id);
      } catch {
        failed.push(m.user.tag);
      }
    }
    if (failed.length) {
      message.author.send(`❌ Failed to DM: ${failed.join(', ')}`);
    }
    message.channel.send('✅ DMs sent!');
    return;
  }

  // === /dmrole Slash ===
  // Make sure you've registered this slash cmd separately
  if (message.content === '!dmchannel') {
    // (Using prefix for simplicity)
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;
    const channel = await client.channels.fetch('1325529675912450239');
    const invite = 'https://discord.gg/cbpWRu6xn5';
    for (const m of channel.members.values()) {
      if (dmCache.has(m.id)) continue;
      try {
        await m.send(`Join our server: ${invite}`);
        dmCache.add(m.id);
      } catch {}
    }
    message.reply('✅ DMs sent to channel members.');
    return;
  }

  // === !hostfriendly ===
  if (cmd === '!hostfriendly') {
    // Permission
    const canHost =
      message.member.permissions.has(PermissionsBitField.Flags.Administrator) ||
      message.member.roles.cache.some((r) => r.name === 'Friendlies Department');
    if (!canHost) return;
    // Setup positions
    const positions = Array(7).fill(null);
    const names = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
    const hostPos = args[0]?.toUpperCase();
    const idx = names.indexOf(hostPos);
    if (idx !== -1) positions[idx] = message.author;
    // Build embed
    const makeEmbed = () =>
      new EmbedBuilder()
        .setTitle('Agnello FC Friendly Positions')
        .setDescription(
          names
            .map((n, i) => `${emojis[i]} ${n}: ${positions[i] ? `<@${positions[i].id}>` : 'Unclaimed'}`)
            .join('\n')
        )
        .setColor(0x00ae86);
    const sent = await message.channel.send({
      content: '@here React to claim a position!',
      embeds: [makeEmbed()],
      allowedMentions: { parse: ['users', 'everyone'] },
    });
    // React
    for (let i = 0; i < 7; i++) if (!positions[i]) await sent.react(emojis[i]);
    const claimed = new Map();
    const collector = sent.createReactionCollector({ time: 600000, filter: (r, u) => emojis.includes(r.emoji.name) && !u.bot });
    collector.on('collect', async (reaction, user) => {
      if (claimed.has(user.id)) return reaction.users.remove(user.id);
      const i = emojis.indexOf(reaction.emoji.name);
      if (positions[i]) return reaction.users.remove(user.id);
      positions[i] = user;
      claimed.set(user.id, i);
      await sent.edit({ embeds: [makeEmbed()], allowedMentions: { parse: ['users'] } });
      if (claimed.size === 7) collector.stop('filled');
    });
    // 1-min @here ping
    setTimeout(() => {
      if (claimed.size < 7) {
        message.channel.send({ content: '@here Need more reactions to start!', allowedMentions: { parse: ['everyone'] } });
      }
    }, 60000);
    // 10-min cancel
    setTimeout(() => {
      if (claimed.size < 7) {
        message.channel.send('❌ Friendly cancelled — not enough players.');
        collector.stop();
      }
    }, 600000);
    collector.on('end', (_, reason) => {
      if (reason === 'filled') message.channel.send('✅ All positions filled! Post invite link to DM players.');
      // Wait for link
      const linkCollector = message.channel.createMessageCollector({
        filter: (m) => m.author.id === message.author.id && m.content.includes('https://'),
        time: 300000,
        max: 1,
      });
      linkCollector.on('collect', async (m) => {
        const link = m.content.trim();
        const failed = [];
        for (const [userId] of claimed) {
          try {
            (await client.users.fetch(userId)).send(`Here’s the friendly, join up: ${link}`);
          } catch {
            failed.push(userId);
          }
        }
        if (failed.length) message.channel.send(`❌ Failed to DM: ${failed.join(', ')}`);
        else message.channel.send('✅ DMs sent to all players!');
      });
    });
    return;
  }
});

// Login
client.login(process.env.TOKEN);

// Error handling
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);