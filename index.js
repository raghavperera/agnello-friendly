// index.js - Agnello FC combined bot (full features)
// Requirements: node 18+, discord.js v14+, @discordjs/voice, ytdl-core, express, dotenv
import 'dotenv/config';
import express from 'express';
import ytdl from 'ytdl-core';
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  ChannelType
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus,
  StreamType
} from '@discordjs/voice';

// ---------- CONFIG ----------
const VOICE_CHANNEL_ID = '1368359914145058956';
const WELCOME_CHANNEL_ID = '1361113546829729914';
const GOODBYE_CHANNEL_ID = '1361113558347415728';
const INVITE_LINK = 'https://discord.gg/QqTWBUkPCw';
const EXPRESS_PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const HOSTFRIENDLY_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const HOSTFRIENDLY_PING_MS = 60 * 1000; // 1 minute
const HOSTFRIENDLY_WAIT_FOR_LINK_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVITYCHECK_DEFAULT_GOAL = 40;
// Positions mapping
const POSITION_EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
const POSITION_NAMES  = ['GK','CB','CB2','CM','LW','RW','ST'];

// ---------- CLIENT ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// Simple memory caches to avoid duplicates across repeated runs (in-memory)
const dmRoleSentCache = new Set(); // tracks member IDs we've DM'd via !dmrole during this process
const hostfriendlyActivePerChannel = new Set(); // avoid accidental double-hosting in same channel

// Music queue map: guildId -> { textChannel, voiceConnection, audioPlayer, songs[], loop }
const musicQueue = new Map();

// ---------- UTIL ----------
const wait = ms => new Promise(r => setTimeout(r, ms));

function buildFriendlyEmbed(claimedArray, hostMember) {
  const desc = POSITION_EMOJIS.map((emoji, i) => {
    const claimed = claimedArray[i];
    return `${emoji} → ${POSITION_NAMES[i]}: ${claimed ? `<@${claimed}>` : '---'}`;
  }).join('\n');

  const embed = new EmbedBuilder()
    .setTitle('AGNELLO FC 7v7 FRIENDLY')
    .setDescription(desc)
    .setFooter({ text: '@everyone' })
    .setTimestamp();

  if (hostMember) {
    embed.setAuthor({ name: `Host: ${hostMember.user.tag}`, iconURL: hostMember.user.displayAvatarURL() });
  }
  return embed;
}

// Safe channel fetch helper
async function getChannel(guild, id) {
  try {
    const ch = await guild.channels.fetch(id);
    return ch || null;
  } catch {
    return null;
  }
}

// ---------- WELCOME & GOODBYE ----------
client.on('guildMemberAdd', async (member) => {
  try {
    // send DM (best effort)
    await member.send(`👋 Welcome to the team, ${member.user.username}! Glad to have you with us. - mossedbyerts`);
  } catch (err) {
    // DM may fail if blocked; just continue
    console.warn('Welcome DM failed for', member.user.tag);
  }

  // public welcome
  try {
    const channel = await getChannel(member.guild, WELCOME_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      channel.send(`Welcome <@${member.id}> to Agnello FC!`);
    }
  } catch (err) {
    console.error('Welcome channel send failed', err);
  }
});

client.on('guildMemberRemove', async (member) => {
  try {
    // fetch user data safely before they fully leave
    const username = member.user?.username || 'member';
    const tag = member.user?.tag || '';
    const channel = await getChannel(member.guild, GOODBYE_CHANNEL_ID);
    if (channel && channel.isTextBased()) {
      channel.send(`😢 ${tag} has left the server.`);
    }
    // attempt DM with invite
    try {
      await member.send(`We're sorry to see you go, ${username}. If you ever want to return, here's the invite: ${INVITE_LINK}`);
    } catch (err) {
      // cannot DM
      console.warn('Goodbye DM failed for', tag);
    }
  } catch (err) {
    console.error('guildMemberRemove handler error', err);
  }
});

// ---------- AUTO JOIN / AUTO RECONNECT TO VC ----------
async function tryJoinConfiguredVC() {
  try {
    const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    if (!channel.isVoiceBased && channel.type !== ChannelType.GuildVoice) return;
    joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfMute: true,
      selfDeaf: false
    });
    console.log('Attempted to join configured VC.');
  } catch (err) {
    console.error('tryJoinConfiguredVC error', err);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  // Attempt initial join
  await tryJoinConfiguredVC();
});

// If our bot gets disconnected from voice, rejoin the configured channel
client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    // If the bot was in a VC (oldState) and now is not (newState.channelId == null) and it's our bot
    if (oldState.member && oldState.member.id === client.user.id && oldState.channelId && !newState.channelId) {
      // reconnect to configured voice channel
      await tryJoinConfiguredVC();
    }
  } catch (err) {
    console.error('voiceStateUpdate error', err);
  }
});

// ---------- !joinvc command (manual) ----------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.content.trim() === '!joinvc') {
      const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
      if (!channel || !channel.isVoiceBased()) return message.reply('Configured VC not found.');
      joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfMute: true
      });
      return message.reply('Joined VC!');
    }
  } catch (err) {
    console.error('!joinvc error', err);
  }
});

// ---------- !activitycheck (embed-like) ----------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith('!activitycheck')) return;

    // parse goal (optional)
    const parts = message.content.split(' ').filter(Boolean);
    const goal = (parts[1] && !isNaN(parseInt(parts[1]))) ? parseInt(parts[1]) : ACTIVITYCHECK_DEFAULT_GOAL;

    const embed = new EmbedBuilder()
      .setTitle('📋 Agnello FC Activity Check')
      .setDescription(`React with ✅ to confirm you're active!\n**Goal:** ${goal}\n**Duration:** 1 day`)
      .setFooter({ text: '@everyone' })
      .setTimestamp();

    const sent = await message.channel.send({ content: '@everyone', embeds: [embed] });
    await sent.react('✅');
  } catch (err) {
    console.error('!activitycheck error', err);
  }
});

// ---------- !dmrole (DM EVERY POSSIBLE MEMBER IN ROLE) ----------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith('!dmrole')) return;

    // permission check: allow admins and users with 'Friendlies Department' maybe? original asked admin
    const isAdmin = message.member.permissions.has(PermissionsBitField.Flags.Administrator);
    if (!isAdmin) return message.reply('No permission.');

    const parts = message.content.split(' ').slice(1);
    if (parts.length === 0) return message.reply('Usage: `!dmrole <Role Name>`');
    const roleName = parts.join(' ');

    const role = message.guild.roles.cache.find(r => r.name === roleName);
    if (!role) return message.reply('Role not found.');

    await message.reply(`📨 Attempting to DM everyone in role **${role.name}**...`);

    // Ensure guild members are cached
    try { await message.guild.members.fetch(); } catch (err) { /* continue anyway */ }

    const failed = [];
    const success = [];
    let total = 0;

    for (const [id, member] of role.members) {
      total++;
      // avoid DMing same member more than once across repeated runs during this process (in-memory)
      if (dmRoleSentCache.has(member.id)) {
        // still count as success (we attempted earlier this runtime)
        success.push(member.user.tag + ' (skipped-dup)');
        continue;
      }
      try {
        // Try sending DM; if blocked or disabled will throw
        await member.send(`Hello from Agnello FC!`);
        success.push(member.user.tag);
        dmRoleSentCache.add(member.id);
      } catch (err) {
        failed.push(member.user.tag);
      }
      // small throttle to be nice to Discord (avoid bursts)
      await wait(250);
    }

    // Report back to issuer via DM to avoid spamming channel
    const report = `DM Role Report for **${role.name}**\nTotal members in role: ${total}\nSuccessfully messaged: ${success.length}\nFailed to message: ${failed.length}`;
    try {
      await message.author.send(report + (failed.length ? `\n\nFailed users:\n${failed.join('\n')}` : '\n\nAll reachable members were messaged.'));
    } catch {
      // If we can't DM the issuer, at least send a short channel message
      message.channel.send('Could not DM you the full report; check channel permissions.');
    }

  } catch (err) {
    console.error('!dmrole error', err);
  }
});

// ---------- !hostfriendly (live embed, single embed updated live) ----------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith('!hostfriendly')) return;

    // permission: Admin or Friendlies Department role allowed
    const allowedRoles = ['Admin', 'Friendlies Department'];
    const hasPermission = message.member.roles.cache.some(r => allowedRoles.includes(r.name));
    if (!hasPermission) return message.reply('You don’t have permission to host.');

    // Prevent multiple hostfriendlies in same channel
    const uniqueChannelKey = `${message.guild.id}:${message.channel.id}`;
    if (hostfriendlyActivePerChannel.has(uniqueChannelKey)) {
      return message.reply('A friendly is already being hosted in this channel. Wait for it to finish.');
    }
    hostfriendlyActivePerChannel.add(uniqueChannelKey);

    // Optional: allow host to pre-assign a position: "!hostfriendly GK"
    const args = message.content.split(' ').slice(1);
    let hostPreassignIndex = -1;
    if (args.length && args[0]) {
      const requested = args[0].toUpperCase();
      const idx = POSITION_NAMES.indexOf(requested);
      if (idx !== -1) hostPreassignIndex = idx;
    }

    let claimed = Array(POSITION_NAMES.length).fill(null);
    let claimedUsers = new Set(); // track users who've claimed a pos
    if (hostPreassignIndex !== -1) {
      claimed[hostPreassignIndex] = message.author.id;
      claimedUsers.add(message.author.id);
    }

    // create embed and post
    const embedMsg = await message.channel.send({ embeds: [buildFriendlyEmbed(claimed, message.member)] });

    // add reactions
    for (const em of POSITION_EMOJIS) {
      try { await embedMsg.react(em); } catch {}
    }

    // reaction collector
    const collector = embedMsg.createReactionCollector({
      filter: (reaction, user) => {
        if (user.bot) return false;
        // only the number emojis matter
        return POSITION_EMOJIS.includes(reaction.emoji.name);
      },
      time: HOSTFRIENDLY_DURATION_MS
    });

    // 1-minute ping timer (will only ping if still <7 at that time)
    const pingTimeout = setTimeout(async () => {
      if (claimed.filter(Boolean).length < POSITION_NAMES.length) {
        try { await message.channel.send('@here more reacts to get a friendly.'); } catch {}
      }
    }, HOSTFRIENDLY_PING_MS);

    collector.on('collect', async (reaction, user) => {
      try {
        // single reaction per user: if they already claimed something, remove reaction and ignore
        if (claimedUsers.has(user.id)) {
          try { await reaction.users.remove(user.id); } catch {}
          return;
        }

        const index = POSITION_EMOJIS.indexOf(reaction.emoji.name);
        if (index === -1) {
          // unknown emoji
          try { await reaction.users.remove(user.id); } catch {}
          return;
        }

        // If position already claimed, remove user's reaction
        if (claimed[index]) {
          try { await reaction.users.remove(user.id); } catch {}
          return;
        }

        // wait 3 seconds to reduce duplicate race conditions
        await wait(3000);

        // re-check if user or position taken
        if (claimedUsers.has(user.id)) {
          try { await reaction.users.remove(user.id); } catch {}
          return;
        }
        if (claimed[index]) {
          try { await reaction.users.remove(user.id); } catch {}
          return;
        }

        // assign
        claimed[index] = user.id;
        claimedUsers.add(user.id);
        // update embed
        try { await embedMsg.edit({ embeds: [buildFriendlyEmbed(claimed, message.member)] }); } catch {}
        // announce confirmation
        try { await message.channel.send(`✅ ${POSITION_NAMES[index]} confirmed for <@${user.id}>`); } catch {}

        // stop if filled
        if (claimed.filter(Boolean).length >= POSITION_NAMES.length) {
          collector.stop('filled');
        }
      } catch (err) {
        console.error('collector collect error', err);
      }
    });

    collector.on('end', async (collected, reason) => {
      try {
        clearTimeout(pingTimeout);
        hostfriendlyActivePerChannel.delete(uniqueChannelKey);

        if (reason !== 'filled' && claimed.filter(Boolean).length < POSITION_NAMES.length) {
          // cancelled
          try { await message.channel.send('❌ Friendly cancelled due to not enough players.'); } catch {}
          return;
        }

        // final lineup message
        const finalLineupText = '**FRIENDLY LINEUP**\n' + POSITION_NAMES.map((p,i) => `${p} → ${claimed[i] ? `<@${claimed[i]}>` : '---'}`).join('\n');
        await message.channel.send(finalLineupText);
        await message.channel.send('✅ Finding friendly, waiting for host link...');

        // wait for host to post link in same channel
        const userIds = claimed.filter(Boolean);
        if (userIds.length === 0) return;

        const linkCollector = message.channel.createMessageCollector({
          filter: m => m.author.id === message.author.id && /https?:\/\//i.test(m.content),
          max: 1,
          time: HOSTFRIENDLY_WAIT_FOR_LINK_MS
        });

        linkCollector.on('collect', async (m) => {
          const link = m.content.trim();
          for (const uid of userIds) {
            try {
              const member = await message.guild.members.fetch(uid).catch(() => null);
              if (!member) continue;
              await member.send(`Here’s the friendly, join up: ${link}`);
              // small throttle
              await wait(150);
            } catch (err) {
              // ignore DM failures individually
            }
          }
        });

        linkCollector.on('end', (_, lReason) => {
          if (lReason === 'time') {
            message.channel.send('Host did not provide a link in time.');
          }
        });

      } catch (err) {
        console.error('collector end error', err);
      }
    });

  } catch (err) {
    console.error('!hostfriendly error', err);
    try { message.channel.send('An error occurred starting the friendly.'); } catch {}
  }
});

// ---------- MUSIC commands (!play, !skip, !stop, !queue, !loop) ----------
async function playSong(guild, song) {
  const serverQueue = musicQueue.get(guild.id);
  if (!serverQueue) return;
  if (!song) {
    try {
      serverQueue.voiceConnection.destroy();
    } catch {}
    musicQueue.delete(guild.id);
    return;
  }

  const stream = ytdl(song.url, { filter: 'audioonly', highWaterMark: 1 << 25 });
  const resource = createAudioResource(stream, { inputType: StreamType.Arbitrary });
  try {
    serverQueue.audioPlayer.play(resource);
  } catch (err) {
    console.error('playSong play error', err);
  }

  // on end
  serverQueue.audioPlayer.once(AudioPlayerStatus.Idle, async () => {
    try {
      if (serverQueue.loop) {
        // rotate first song to end
        const s = serverQueue.songs.shift();
        serverQueue.songs.push(s);
      } else {
        serverQueue.songs.shift();
      }
      // play next
      playSong(guild, serverQueue.songs[0]);
    } catch (err) {
      console.error('audio idle handler error', err);
    }
  });
}

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const [cmd, ...args] = message.content.trim().split(/\s+/);
    const serverQueue = musicQueue.get(message.guild.id);

    if (cmd === '!play') {
      const url = args[0];
      if (!url) return message.reply('Usage: `!play <YouTube URL>`');
      // ensure user in VC
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a VC first!');
      const perms = vc.permissionsFor(message.client.user);
      if (!perms || !perms.has(PermissionsBitField.Flags.Connect) || !perms.has(PermissionsBitField.Flags.Speak)) {
        return message.reply('I need permission to join & speak in that VC.');
      }
      // get info
      let info;
      try { info = await ytdl.getInfo(url); } catch (err) { return message.reply('Invalid YouTube URL or failed to fetch info.'); }
      const song = { title: info.videoDetails.title, url: info.videoDetails.video_url };

      if (!serverQueue) {
        const audioPlayer = createAudioPlayer();
        const connection = joinVoiceChannel({
          channelId: vc.id,
          guildId: message.guild.id,
          adapterCreator: message.guild.voiceAdapterCreator,
          selfMute: false
        });
        // store queue
        const queueObj = { textChannel: message.channel, voiceConnection: connection, audioPlayer, songs: [], loop: false };
        musicQueue.set(message.guild.id, queueObj);
        queueObj.songs.push(song);
        // subscribe audio player
        try { connection.subscribe(audioPlayer); } catch {}
        playSong(message.guild, song);
        return message.reply(`🎶 Now playing: **${song.title}**`);
      } else {
        serverQueue.songs.push(song);
        return message.reply(`✅ Added to queue: **${song.title}**`);
      }
    }

    if (cmd === '!skip') {
      if (!serverQueue) return message.reply('Nothing to skip!');
      serverQueue.audioPlayer.stop();
      return message.reply('⏭ Skipped!');
    }

    if (cmd === '!stop') {
      if (!serverQueue) return message.reply('Not playing.');
      serverQueue.songs = [];
      try { serverQueue.audioPlayer.stop(); } catch {}
      try { serverQueue.voiceConnection.destroy(); } catch {}
      musicQueue.delete(message.guild.id);
      return message.reply('🛑 Stopped and left VC!');
    }

    if (cmd === '!queue') {
      if (!serverQueue || !serverQueue.songs.length) return message.reply('Queue empty!');
      return message.reply(`🎶 Queue:\n${serverQueue.songs.map((s,i) => `${i+1}. ${s.title}`).join('\n')}`);
    }

    if (cmd === '!loop') {
      if (!serverQueue) return message.reply('Not playing.');
      serverQueue.loop = !serverQueue.loop;
      return message.reply(`🔁 Loop is now ${serverQueue.loop ? 'ON' : 'OFF'}`);
    }

  } catch (err) {
    console.error('music command handler error', err);
  }
});

// ---------- EXPRESS KEEP-ALIVE ----------
const app = express();
app.get('/', (req, res) => res.send('Bot is alive'));
app.listen(EXPRESS_PORT, () => console.log(`Express server running on port ${EXPRESS_PORT}`));

// ---------- LOGIN ----------
client.login(process.env.TOKEN).catch(err => {
  console.error('Failed to login (check TOKEN):', err);
  process.exit(1);
});