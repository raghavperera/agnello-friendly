
import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  MessageReaction,
  User,
  ActivityType
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  entersState,
  VoiceConnectionStatus
} from '@discordjs/voice';
import express from 'express';
import ytdl from 'ytdl-core';
import { DisTube } from 'distube';
import { SpotifyPlugin } from '@distube/spotify';
import 'dotenv/config';

// ---- Config & Constants ---- //
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

const VOICE_CHANNEL_ID = '1368359914145058956'; // Agnello FC voice channel ID
const WELCOME_CHANNEL_ID = '1361113546829729914'; // Welcome channel ID
const GOODBYE_CHANNEL_ID = '1361113558347415728'; // Goodbye channel ID
const SERVER_INVITE_LINK = 'https://discord.gg/QqTWBUkPCw'; // Server invite link

// Position emojis & names for hostfriendly
const positionEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
const positionNames = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];

// Cache to avoid DMing same user twice in one run
const dmSentCache = new Set();

// Distube music client
const distube = new DisTube(client, {
  plugins: [new SpotifyPlugin()],
  leaveOnFinish: true,
  leaveOnStop: true,
  leaveOnEmpty: true,
  youtubeDL: false,
  updateYouTubeDL: false,
});

// ---- Helper functions ---- //

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeSendDM(member, content) {
  if (!member || !member.user || dmSentCache.has(member.id)) return false;
  try {
    await member.send(content);
    dmSentCache.add(member.id);
    return true;
  } catch {
    return false;
  }
}

// ---- Bot Events ---- //

// Bot ready
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);

  // Auto join voice channel and mute self
  const channel = client.channels.cache.get(VOICE_CHANNEL_ID);
  if (channel?.isVoiceBased()) {
    joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfMute: true,
    });
    console.log('Auto-joined voice channel');
  }

  client.user.setActivity('Agnello FC | !help', { type: ActivityType.Playing });
});

// Reconnect to VC if disconnected unexpectedly
client.on('voiceStateUpdate', (oldState, newState) => {
  if (
    oldState.member?.id === client.user.id &&
    !newState.channelId
  ) {
    const channel = client.channels.cache.get(VOICE_CHANNEL_ID);
    if (channel?.isVoiceBased()) {
      joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfMute: true,
      });
      console.log('Reconnected to voice channel after disconnect');
    }
  }
});

// Welcome DM & channel message
client.on('guildMemberAdd', async (member) => {
  await safeSendDM(
    member,
    `👋 Welcome to the team, ${member.user.username}! Glad to have you with us. - Agnello FC`
  );
  const channel = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
  if (channel)
    channel.send(`Welcome <@${member.id}> to **Agnello FC**! 🎉`);
});

// Goodbye DM & channel message
client.on('guildMemberRemove', async (member) => {
  const channel = member.guild.channels.cache.get(GOODBYE_CHANNEL_ID);
  if (channel)
    channel.send(`😢 ${member.user.tag} has left **Agnello FC**.`);
  await safeSendDM(
    member,
    `We're sorry to see you go, ${member.user.username}. If you ever want to return, here's the invite: ${SERVER_INVITE_LINK}`
  );
});

// React ✅ to any @everyone or @here mentions in messages
client.on('messageCreate', async (message) => {
  if (
    message.mentions.everyone &&
    !message.author.bot &&
    message.channel
  ) {
    try {
      await message.react('✅');
    } catch {}
  }
});

// ---- Commands ---- //

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;

  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  // -- !joinvc -- //
  if (cmd === 'joinvc') {
    const channel = message.guild.channels.cache.get(VOICE_CHANNEL_ID);
    if (!channel?.isVoiceBased()) {
      return message.reply('Voice channel not found.');
    }
    try {
      joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfMute: true,
      });
      return message.reply('✅ Joined voice channel and muted.');
    } catch (e) {
      console.error(e);
      return message.reply('❌ Failed to join voice channel.');
    }
  }

  // -- !dmrole ROLE_NAME -- //
  if (cmd === 'dmrole') {
    if (
      !message.member.permissions.has(
        PermissionsBitField.Flags.Administrator
      )
    ) {
      return message.reply('❌ You do not have permission to use this.');
    }
    const roleName = args.join(' ');
    if (!roleName) return message.reply('❌ Please specify a role name.');

    const role = message.guild.roles.cache.find(
      (r) => r.name.toLowerCase() === roleName.toLowerCase()
    );
    if (!role) return message.reply('❌ Role not found.');

    await message.reply(`📨 Sending DMs to role: **${role.name}**...`);
    const failed = [];
    for (const member of role.members.values()) {
      if (dmSentCache.has(member.id)) continue;
      try {
        await member.send(`Hello from **Agnello FC**!`);
        dmSentCache.add(member.id);
      } catch {
        failed.push(member.user.tag);
      }
    }
    if (failed.length) {
      await message.author.send(
        `❌ Failed to DM the following users:\n${failed.join('\n')}`
      );
    } else {
      await message.author.send(
        `✅ Successfully sent DMs to all members of **${role.name}**.`
      );
    }
    return;
  }

  // -- !hostfriendly -- //
  if (cmd === 'hostfriendly') {
    // Check permission: Admin or Friendlies Department
    const allowedRoles = ['Admin', 'Friendlies Department'];
    const hasPerm = message.member.roles.cache.some((r) =>
      allowedRoles.includes(r.name)
    );
    if (!hasPerm) {
      return message.reply('❌ You do not have permission to host a friendly.');
    }

    let claimed = Array(7).fill(null);
    let claimedUsers = new Set();

    const buildLineupEmbed = () => {
      const embed = new EmbedBuilder()
        .setTitle('AGNELLO FC 7v7 FRIENDLY')
        .setDescription(
          positionEmojis
            .map(
              (emoji, i) =>
                `${emoji} → **${positionNames[i]}**: ${
                  claimed[i] ? `<@${claimed[i]}>` : '---'
                }`
            )
            .join('\n') + '\n\n@here'
        )
        .setColor('#0066CC')
        .setFooter({ text: 'React to claim your position. One position per user.' })
        .setTimestamp();
      return embed;
    };

    const friendlyMessage = await message.channel.send({
      embeds: [buildLineupEmbed()],
    });

    for (const emoji of positionEmojis) {
      await friendlyMessage.react(emoji);
    }

    const filter = (reaction, user) =>
      !user.bot && positionEmojis.includes(reaction.emoji.name);

    const collector = friendlyMessage.createReactionCollector({
      filter,
      time: 10 * 60 * 1000,
    });

    // Ping @here after 1 minute if fewer than 7 claimed
    const oneMinPing = setTimeout(() => {
      if (claimed.filter(Boolean).length < 7) {
        message.channel.send('@here More reacts to get a friendly!');
      }
    }, 60 * 1000);

    collector.on('collect', async (reaction, user) => {
      // If user already claimed a position, remove new reaction
      if (claimedUsers.has(user.id)) {
        await reaction.users.remove(user.id).catch(() => {});
        return;
      }

      const index = positionEmojis.indexOf(reaction.emoji.name);
      if (!claimed[index]) {
        // Wait 3 sec before assigning to check for duplicates
        await delay(3000);
        if (claimedUsers.has(user.id)) {
          await reaction.users.remove(user.id).catch(() => {});
          return;
        }
        claimed[index] = user.id;
        claimedUsers.add(user.id);

        // Edit lineup embed live
        await friendlyMessage.edit({ embeds: [buildLineupEmbed()] });
        await message.channel.send(`✅ ${positionNames[index]} confirmed for <@${user.id}>`);

        // Stop if all claimed
        if (claimed.every(Boolean)) {
          collector.stop('filled');
        }
      } else {
        await reaction.users.remove(user.id).catch(() => {});
      }
    });

    collector.on('end', async (_, reason) => {
      clearTimeout(oneMinPing);

      if (reason !== 'filled' && claimed.filter(Boolean).length < 7) {
        await message.channel.send('❌ Friendly cancelled due to not enough players.');
        return;
      }

      // Show final lineup plain text
      let finalLineup = '**FRIENDLY LINEUP**\n' +
        claimed.map((id, i) => `${positionNames[i]} → <@${id}>`).join('\n');

      await message.channel.send(finalLineup);
      await message.channel.send('✅ Finding friendly, waiting for host link...');

      // Wait for host to post link and DM players
      const userIds = claimed.filter(Boolean);

      const linkCollector = message.channel.createMessageCollector({
        filter: (m) => m.author.id === message.author.id && m.content.includes('http'),
        max: 1,
        time: 5 * 60 * 1000,
      });

      linkCollector.on('collect', async (m) => {
        for (const uid of userIds) {
          try {
            const member = await message.guild.members.fetch(uid);
            await safeSendDM(member, `Here’s the friendly, join up: ${m.content}`);
          } catch {}
        }
      });
    });

    return;
  }

  // -- !activitycheck [goal] -- //
  if (cmd === 'activitycheck') {
    let goal = parseInt(args[0], 10);
    if (isNaN(goal) || goal < 1) goal = 40;

    const embed = new EmbedBuilder()
      .setTitle('📋 Agnello FC Activity Check')
      .setDescription(
        `React with ✅ to confirm you're active!\n**Goal:** ${goal}\n**Duration:** 1 day\n@everyone`
      )
      .setColor('#00AAFF')
      .setTimestamp();

    const activityMsg = await message.channel.send({ content: '@everyone', embeds: [embed] });
    await activityMsg.react('✅');
    return;
  }

  // ---- MUSIC COMMANDS (using DisTube) ---- //

  if (cmd === 'play') {
    const voiceChannel = message.member.voice.channel;
    if (!voiceChannel) return message.reply('❌ You need to join a voice channel first.');

    try {
      await distube.play(voiceChannel, args.join(' '), {
        member: message.member,
        textChannel: message.channel,
      });
      return;
    } catch (e) {
      console.error(e);
      return message.reply('❌ Failed to play the song.');
    }
  }

  if (cmd === 'skip') {
    try {
      await distube.skip(message);
      return message.reply('⏭ Skipped the song!');
    } catch {
      return message.reply('❌ Nothing to skip.');
    }
  }

  if (cmd === 'stop') {
    try {
      await distube.stop(message);
      return message.reply('🛑 Stopped and left the voice channel.');
    } catch {
      return message.reply('❌ Nothing to stop.');
    }
  }

  if (cmd === 'queue') {
    const queue = distube.getQueue(message);
    if (!queue) return message.reply('❌ Queue is empty.');
    const q = queue.songs.map((song, i) => `${i + 1}. ${song.name}`).join('\n');
    return message.reply(`🎶 Queue:\n${q}`);
  }

  if (cmd === 'loop') {
    const queue = distube.getQueue(message);
    if (!queue) return message.reply('❌ No song playing.');
    let mode = queue.repeatMode;
    mode = (mode + 1) % 3; // 0: off, 1: song, 2: queue
    queue.setRepeatMode(mode);
    return message.reply(`🔁 Loop mode is now: ${['Off', 'Song', 'Queue'][mode]}`);
  }
});

// ---- Distube Events for feedback ---- //
distube
  .on('playSong', (queue, song) =>
    queue.textChannel.send(`🎶 Playing: **${song.name}** - \`${song.formattedDuration}\``)
  )
  .on('addSong', (queue, song) =>
    queue.textChannel.send(`✅ Added to queue: **${song.name}** - \`${song.formattedDuration}\``)
  )
  .on('error', (channel, e) => {
    if (channel) channel.send(`❌ Error: ${e.toString().slice(0, 1974)}`);
    else console.error(e);
  });

// ---- Express keep-alive server ---- //
const app = express();
app.get('/', (req, res) => res.send('Agnello FC Bot is alive.'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Express server running on port ${PORT}`));

// ---- Login ---- //
client.login(process.env.TOKEN);