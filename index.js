// index.js - Agnello FC bot (complete)
// Requires: node >= 18, discord.js v14, distube, @distube/spotify, @discordjs/voice, express, dotenv
import 'dotenv/config';
import express from 'express';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType
} from 'discord.js';
import { DisTube } from 'distube';
import SpotifyPlugin from '@distube/spotify';
import { joinVoiceChannel } from '@discordjs/voice';

// ---------- CONFIG ----------
const VOICE_CHANNEL_ID = '1368359914145058956';
const WELCOME_CHANNEL_ID = '1361113546829729914';
const GOODBYE_CHANNEL_ID = '1361113558347415728';
const INVITE_LINK = 'https://discord.gg/QqTWBUkPCw';
const EXPRESS_PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const HOSTFRIENDLY_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const HOSTFRIENDLY_PING_MS = 60 * 1000; // 1 minute
const HOSTFRIENDLY_LINK_WAIT_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVITYCHECK_DEFAULT_GOAL = 40;

// Position mapping
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

// Distube (music)
const distube = new DisTube(client, {
  leaveOnEmpty: true,
  leaveOnFinish: false,
  leaveOnStop: true,
  emitNewSongOnly: false,
  plugins: [new SpotifyPlugin()]
});

// Simple in-memory caches
const dmRoleSentCache = new Set(); // avoid re-dming same users during this runtime
const hostfriendlyActivePerChannel = new Set();

// small helper
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

async function safeFetchChannel(guild, id) {
  try {
    return await guild.channels.fetch(id);
  } catch {
    return null;
  }
}

// ---------- WELCOME / GOODBYE ----------
client.on('guildMemberAdd', async (member) => {
  try {
    await member.send(`👋 Welcome to the team, ${member.user.username}! Glad to have you with us. - mossedbyerts`);
  } catch {
    // ignore DM failures
  }
  try {
    const ch = await safeFetchChannel(member.guild, WELCOME_CHANNEL_ID);
    if (ch && ch.isTextBased()) ch.send(`Welcome <@${member.id}> to Agnello FC!`);
  } catch (err) {
    console.error('Welcome channel send failed', err);
  }
});

client.on('guildMemberRemove', async (member) => {
  try {
    const tag = member.user?.tag || 'A member';
    const ch = await safeFetchChannel(member.guild, GOODBYE_CHANNEL_ID);
    if (ch && ch.isTextBased()) ch.send(`😢 ${tag} has left the server.`);
  } catch (err) {
    console.error('Goodbye channel send failed', err);
  }
  try {
    await member.send(`We're sorry to see you go, ${member.user?.username || 'friend'}. If you ever want to return, here's the invite: ${INVITE_LINK}`);
  } catch {
    // ignore DM failures
  }
});

// ---------- AUTO JOIN / RECONNECT to VC ----------
async function tryJoinConfiguredVC() {
  try {
    const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    // ChannelType.GuildVoice ensures compatibility
    if (channel.type !== ChannelType.GuildVoice && !channel.isVoiceBased()) return;
    joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfMute: true
    });
    console.log('Attempted to join configured VC.');
  } catch (err) {
    console.error('tryJoinConfiguredVC error', err);
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await tryJoinConfiguredVC();
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (oldState.member && oldState.member.id === client.user.id && oldState.channelId && !newState.channelId) {
      // bot was disconnected from VC — rejoin
      await tryJoinConfiguredVC();
    }
  } catch (err) {
    console.error('voiceStateUpdate error', err);
  }
});

// ---------- MESSAGE HANDLER (commands + reactions) ----------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    // auto-react ✅ to @everyone / @here
    if (/(?:@everyone|@here)/i.test(message.content)) {
      try {
        if (message.channel.permissionsFor && message.channel.permissionsFor(message.guild.me || client.user).has(PermissionsBitField.Flags.AddReactions)) {
          await message.react('✅');
        }
      } catch {}
    }

    // Commands
    const content = message.content.trim();

    // ----- !joinvc -----
    if (content === '!joinvc') {
      const channel = await client.channels.fetch(VOICE_CHANNEL_ID).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildVoice) return message.reply('Configured VC not found.');
      joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfMute: true
      });
      return message.reply('Joined VC!');
    }

    // ----- !activitycheck -----
    if (content.startsWith('!activitycheck')) {
      const args = content.split(/\s+/);
      const goal = (args[1] && !isNaN(parseInt(args[1]))) ? parseInt(args[1]) : ACTIVITYCHECK_DEFAULT_GOAL;
      const embed = new EmbedBuilder()
        .setTitle('📋 Agnello FC Activity Check')
        .setDescription(`React with ✅ to confirm you're active!\n**Goal:** ${goal}\n**Duration:** 1 day`)
        .setFooter({ text: '@everyone' })
        .setTimestamp();
      const sent = await message.channel.send({ content: '@everyone', embeds: [embed] });
      try { await sent.react('✅'); } catch {}
      return;
    }

    // ----- !dmrole -----
    if (content.startsWith('!dmrole')) {
      // permission: admin
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply('You must be an administrator to use this.');
      }
      const parts = content.split(/\s+/).slice(1);
      if (parts.length === 0) return message.reply('Usage: `!dmrole <Role Name>`');
      const roleName = parts.join(' ');
      const role = message.guild.roles.cache.find(r => r.name === roleName);
      if (!role) return message.reply('Role not found.');

      await message.reply(`📨 Attempting to DM everyone in role **${role.name}**...`);
      // ensure members cached
      try { await message.guild.members.fetch(); } catch {}

      const failed = [];
      const success = [];
      let total = 0;

      for (const [id, member] of role.members) {
        total++;
        if (dmRoleSentCache.has(member.id)) {
          success.push(`${member.user.tag} (skipped-dup)`);
          continue;
        }
        try {
          await member.send(`Hello from Agnello FC!`);
          success.push(member.user.tag);
          dmRoleSentCache.add(member.id);
        } catch {
          failed.push(member.user.tag);
        }
        // throttle a little
        await wait(200);
      }

      const report = `DM Role Report for **${role.name}**\nTotal members in role: ${total}\nSuccessfully messaged: ${success.length}\nFailed to message: ${failed.length}`;
      try {
        await message.author.send(report + (failed.length ? `\n\nFailed users:\n${failed.join('\n')}` : '\n\nAll reachable members were messaged.'));
      } catch {
        // fallback: send short message in channel
        message.channel.send('Could not DM you the full report. Check your DMs or bot permissions.');
      }
      return;
    }

    // ----- !hostfriendly -----
    if (content.startsWith('!hostfriendly')) {
      // permission: Admin or Friendlies Department role
      const allowedRoles = ['Admin', 'Friendlies Department'];
      const hasPermission = message.member.roles.cache.some(r => allowedRoles.includes(r.name));
      if (!hasPermission) return message.reply('You don’t have permission to host.');

      const uniqueChannelKey = `${message.guild.id}:${message.channel.id}`;
      if (hostfriendlyActivePerChannel.has(uniqueChannelKey)) {
        return message.reply('A friendly is already active in this channel.');
      }
      hostfriendlyActivePerChannel.add(uniqueChannelKey);

      // parse preassign (e.g., "!hostfriendly GK")
      const args = content.split(/\s+/).slice(1);
      let hostPreassignIndex = -1;
      if (args[0]) {
        const req = args[0].toUpperCase();
        const idx = POSITION_NAMES.indexOf(req);
        if (idx !== -1) hostPreassignIndex = idx;
      }

      try {
        let claimed = Array(POSITION_NAMES.length).fill(null);
        let claimedUsers = new Set();
        if (hostPreassignIndex !== -1) {
          claimed[hostPreassignIndex] = message.author.id;
          claimedUsers.add(message.author.id);
        }

        const embedMsg = await message.channel.send({ embeds: [buildFriendlyEmbed(claimed, message.member)] });
        // add reactions
        for (const em of POSITION_EMOJIS) {
          try { await embedMsg.react(em); } catch {}
        }

        const collector = embedMsg.createReactionCollector({
          filter: (reaction, user) => {
            if (!reaction || !reaction.emoji) return false;
            if (user.bot) return false;
            return POSITION_EMOJIS.includes(reaction.emoji.name);
          },
          time: HOSTFRIENDLY_DURATION_MS
        });

        const pingTimer = setTimeout(async () => {
          if (claimed.filter(Boolean).length < POSITION_NAMES.length) {
            try { await message.channel.send('@here more reacts to get a friendly.'); } catch {}
          }
        }, HOSTFRIENDLY_PING_MS);

        collector.on('collect', async (reaction, user) => {
          try {
            if (claimedUsers.has(user.id)) {
              try { await reaction.users.remove(user.id); } catch {}
              return;
            }
            const index = POSITION_EMOJIS.indexOf(reaction.emoji.name);
            if (index === -1) {
              try { await reaction.users.remove(user.id); } catch {}
              return;
            }
            if (claimed[index]) {
              try { await reaction.users.remove(user.id); } catch {}
              return;
            }

            // wait 3s to avoid race conditions
            await wait(3000);

            // re-check
            if (claimedUsers.has(user.id)) {
              try { await reaction.users.remove(user.id); } catch {}
              return;
            }
            if (claimed[index]) {
              try { await reaction.users.remove(user.id); } catch {}
              return;
            }

            claimed[index] = user.id;
            claimedUsers.add(user.id);

            try { await embedMsg.edit({ embeds: [buildFriendlyEmbed(claimed, message.member)] }); } catch {}
            try { await message.channel.send(`✅ ${POSITION_NAMES[index]} confirmed for <@${user.id}>`); } catch {}

            if (claimed.filter(Boolean).length >= POSITION_NAMES.length) {
              collector.stop('filled');
            }
          } catch (err) {
            console.error('hostfriendly collect error', err);
          }
        });

        collector.on('end', async (collected, reason) => {
          try {
            clearTimeout(pingTimer);
            hostfriendlyActivePerChannel.delete(uniqueChannelKey);

            if (reason !== 'filled' && claimed.filter(Boolean).length < POSITION_NAMES.length) {
              try { await message.channel.send('❌ Friendly cancelled due to not enough players.'); } catch {}
              return;
            }

            // final lineup
            const finalText = '**FRIENDLY LINEUP**\n' + POSITION_NAMES.map((p,i) => `${p} → ${claimed[i] ? `<@${claimed[i]}>` : '---'}`).join('\n');
            await message.channel.send(finalText);
            await message.channel.send('✅ Finding friendly, waiting for host link...');

            const userIds = claimed.filter(Boolean);
            if (userIds.length === 0) return;

            const linkCollector = message.channel.createMessageCollector({
              filter: m => m.author.id === message.author.id && /https?:\/\//i.test(m.content),
              max: 1,
              time: HOSTFRIENDLY_LINK_WAIT_MS
            });

            linkCollector.on('collect', async (m) => {
              const link = m.content.trim();
              for (const uid of userIds) {
                try {
                  const mem = await message.guild.members.fetch(uid).catch(() => null);
                  if (!mem) continue;
                  await mem.send(`Here’s the friendly, join up: ${link}`);
                  await wait(150);
                } catch {
                  // ignore DM errors per user
                }
              }
            });

            linkCollector.on('end', (_, lr) => {
              if (lr === 'time') {
                message.channel.send('Host did not provide a link in time.');
              }
            });

          } catch (err) {
            console.error('hostfriendly end error', err);
          }
        });

      } catch (err) {
        console.error('!hostfriendly runtime error', err);
        try { message.channel.send('An error occurred trying to host the friendly.'); } catch {}
        hostfriendlyActivePerChannel.delete(uniqueChannelKey);
      }

      return;
    }

    // ---------- Music commands handled via distube ----------
    if (content.startsWith('!play')) {
      const args = content.split(/\s+/).slice(1);
      const url = args[0];
      if (!url) return message.reply('Usage: `!play <URL or search terms>`');
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a voice channel first!');
      try {
        await distube.play(vc, url, { member: message.member, textChannel: message.channel });
      } catch (err) {
        console.error('distube play error', err);
        return message.reply('Failed to play the track.');
      }
      return;
    }

    if (content === '!skip') {
      try {
        await distube.skip(message.guild);
        return message.reply('⏭ Skipped!');
      } catch {
        return message.reply('Nothing to skip.');
      }
    }

    if (content === '!stop') {
      try {
        await distube.stop(message.guild);
        return message.reply('🛑 Stopped and left VC!');
      } catch {
        return message.reply('Not playing.');
      }
    }

    if (content === '!queue') {
      const q = distube.getQueue(message.guild.id);
      if (!q) return message.reply('Queue empty!');
      const lines = q.songs.map((s, i) => `${i + 1}. ${s.name}`).slice(0, 20).join('\n');
      return message.reply(`🎶 Queue:\n${lines}`);
    }

    if (content === '!loop') {
      const q = distube.getQueue(message.guild.id);
      if (!q) return message.reply('Nothing playing.');
      const mode = q.repeatMode === 0 ? 1 : 0; // 0 none, 1 song, 2 queue depending on config
      await distube.setRepeatMode(message.guild, mode);
      return message.reply(`🔁 Loop toggled.`);
    }

  } catch (err) {
    console.error('messageCreate handler error', err);
  }
});

// Optional: Distube event logging for helpful console messages
distube.on('playSong', (queue, song) => {
  console.log(`Playing ${song.name} in ${queue.textChannel.id}`);
});
distube.on('addSong', (queue, song) => {
  console.log(`Added ${song.name} to the queue in ${queue.textChannel.id}`);
});
distube.on('error', (channel, e) => {
  console.error('Distube error:', e);
  if (channel) channel.send('An error occurred with music playback.');
});

// ---------- EXPRESS keep-alive ----------
const app = express();
app.get('/', (req, res) => res.send('Agnello FC Bot is alive'));
app.listen(EXPRESS_PORT, () => console.log(`Express listening on ${EXPRESS_PORT}`));

// ---------- LOGIN ----------
if (!process.env.TOKEN) {
  console.error('Missing TOKEN in environment. Set TOKEN=your-bot-token in .env');
  process.exit(1);
}
client.login(process.env.TOKEN).catch(err => {
  console.error('Login error:', err);
  process.exit(1);
});