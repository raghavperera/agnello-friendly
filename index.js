import { 
  Client, 
  GatewayIntentBits, 
  Partials, 
  EmbedBuilder, 
  PermissionsBitField, 
  Events, 
  REST, 
  Routes, 
  SlashCommandBuilder 
} from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { DisTube } from 'distube';
import express from 'express';
import 'dotenv/config';

// Environment variables
const TOKEN = process.env.DISCORD_TOKEN;
const PORT = process.env.PORT || 3000;
const VOICE_CHANNEL_ID = process.env.VOICE_CHANNEL_ID || '1368359914145058956'; // replace with your VC ID
const GUILD_ID = process.env.GUILD_ID || ''; // For slash commands registration (optional)

// Client setup
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// DisTube music setup
const distube = new DisTube(client, {
  leaveOnStop: true,
  emitNewSongOnly: true,
  leaveOnEmpty: true,
});

// Express server for uptime
const app = express();
app.get('/', (req, res) => res.send('Agnello FC Bot is running!'));
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

// ======= Global variables & caches =======
let joinVCConnection = null;
const dmFailLog = new Map(); // command user ID => array of failed DMs
const dmRoleCache = new Set(); // user IDs already DM'd in dmrole to avoid repeats
const hostFriendlyActive = new Map(); // guildId => { message, collector, positions, usersReacted, timeoutIds }

// Position emojis and roles mapping
const positions = [
  { emoji: '1️⃣', role: 'GK', slot: 0 },
  { emoji: '2️⃣', role: 'CB', slot: 1 },
  { emoji: '3️⃣', role: 'CB2', slot: 2 },
  { emoji: '4️⃣', role: 'CM', slot: 3 },
  { emoji: '5️⃣', role: 'LW', slot: 4 },
  { emoji: '6️⃣', role: 'RW', slot: 5 },
  { emoji: '7️⃣', role: 'ST', slot: 6 },
];

// Allowed roles for hosting friendlies
const HOST_ROLES = ['Admin', 'Friendlies Department'];

// Utility function to check if member can host
function canHost(member) {
  return member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    HOST_ROLES.some(roleName => member.roles.cache.some(r => r.name === roleName));
}

// === Helper: Compose Host Friendly embed message ===
function createFriendlyEmbed(claims) {
  const embed = new EmbedBuilder()
    .setTitle('AGNELLO FC 7v7 FRIENDLY')
    .setDescription(positions.map((pos, i) => {
      const userTag = claims[i] ? `<@${claims[i]}>` : '_Available_';
      return `${pos.emoji} → **${pos.role}**: ${userTag}`;
    }).join('\n'))
    .setColor('#0099ff');
  return embed;
}

// === Helper: Send final lineup text ===
function createLineupText(claims) {
  return `**FINAL LINEUP:**\n` + positions.map((pos, i) => {
    return `${pos.role}: <@${claims[i]}>`;
  }).join('\n');
}

// === !hostfriendly command logic ===
async function handleHostFriendly(message) {
  if (!canHost(message.member)) {
    return message.reply("You don't have permission to host a friendly.");
  }

  if (hostFriendlyActive.has(message.guild.id)) {
    return message.reply("A friendly is already being hosted in this server.");
  }

  // Initial claims array to store user IDs per position
  const claims = Array(7).fill(null);

  // Send embed message
  const embed = createFriendlyEmbed(claims);
  const friendlyMessage = await message.channel.send({ embeds: [embed], content: '@everyone React 1️⃣ to 7️⃣ to claim your position!' });

  // React with all position emojis
  for (const pos of positions) {
    await friendlyMessage.react(pos.emoji);
  }

  // Track users who reacted (to prevent multi-pos)
  const usersReacted = new Map(); // userId -> position index

  // Create Reaction Collector
  const filter = (reaction, user) => {
    return positions.some(pos => pos.emoji === reaction.emoji.name) && !user.bot;
  };

  const collector = friendlyMessage.createReactionCollector({ filter, time: 10 * 60 * 1000 }); // 10 minutes

  // Timeout functions
  const pingTimeout = setTimeout(() => {
    if (usersReacted.size < 7) {
      message.channel.send('@here Friendly still looking for players, react to claim your position!');
    }
  }, 60 * 1000); // 1 minute

  const cancelTimeout = setTimeout(() => {
    if (usersReacted.size < 7) {
      message.channel.send('Friendly cancelled due to insufficient players.');
      collector.stop('cancelled');
    }
  }, 10 * 60 * 1000); // 10 minutes

  collector.on('collect', async (reaction, user) => {
    // Only one position per user allowed
    if (usersReacted.has(user.id)) {
      // Remove their new reaction if trying to claim a second position
      try {
        await reaction.users.remove(user.id);
      } catch {}
      return;
    }

    // Find which position this reaction corresponds to
    const posIndex = positions.findIndex(p => p.emoji === reaction.emoji.name);
    if (posIndex === -1) return;

    // Check if position already claimed
    if (claims[posIndex]) {
      // Remove reaction because position taken
      try {
        await reaction.users.remove(user.id);
      } catch {}
      return;
    }

    // Assign position
    claims[posIndex] = user.id;
    usersReacted.set(user.id, posIndex);

    // Edit embed to update lineup
    const newEmbed = createFriendlyEmbed(claims);
    await friendlyMessage.edit({ embeds: [newEmbed] });

    // Confirm message
    message.channel.send(`✅ **${positions[posIndex].role}** confirmed for <@${user.id}>`);

    // If all positions filled - end collector early
    if (usersReacted.size === 7) {
      clearTimeout(pingTimeout);
      clearTimeout(cancelTimeout);
      collector.stop('filled');
    }
  });

  collector.on('remove', async (reaction, user) => {
    // When user removes reaction, free up position
    if (!usersReacted.has(user.id)) return;
    const posIndex = usersReacted.get(user.id);

    // Remove claim & user react record
    claims[posIndex] = null;
    usersReacted.delete(user.id);

    // Update embed
    const newEmbed = createFriendlyEmbed(claims);
    await friendlyMessage.edit({ embeds: [newEmbed] });

    message.channel.send(`❌ <@${user.id}> has unclaimed position **${positions[posIndex].role}**.`);
  });

  collector.on('end', (collected, reason) => {
    hostFriendlyActive.delete(message.guild.id);
    if (reason === 'filled') {
      message.channel.send(createLineupText(claims));
      message.channel.send('Friendly is ready! Waiting for the host to post the invite link.');
    } else if (reason === 'cancelled') {
      // already notified cancel in timeout
    } else {
      message.channel.send('Friendly ended.');
    }
  });

  // Store active friendly state
  hostFriendlyActive.set(message.guild.id, {
    message: friendlyMessage,
    collector,
    claims,
    usersReacted,
    pingTimeout,
    cancelTimeout,
  });
}

// === DM Role command (prefix and slash) ===
async function handleDmRole(message, args) {
  if (!canHost(message.member)) {
    return message.reply("You don't have permission to use this command.");
  }

  const roleName = args.join(' ');
  if (!roleName) return message.reply('Please specify a role name.');

  const role = message.guild.roles.cache.find(r => r.name === roleName);
  if (!role) return message.reply('Role not found.');

  const failedUsers = [];
  dmRoleCache.clear();

  await message.channel.send(`Dming all users with the role **${role.name}**...`);

  for (const member of role.members.values()) {
    if (dmRoleCache.has(member.id)) continue;
    try {
      await member.send('Here is a message for your role!');
      dmRoleCache.add(member.id);
    } catch {
      failedUsers.push(member.user.tag);
    }
  }

  if (failedUsers.length > 0) {
    await message.author.send(`Failed to DM the following users:\n${failedUsers.join('\n')}`);
  }

  await message.channel.send('DMing complete.');
}

// === JoinVC command ===
async function joinVoiceChannelHandler(message) {
  if (!canHost(message.member)) return message.reply("You don't have permission.");

  try {
    const channel = message.guild.channels.cache.get(VOICE_CHANNEL_ID);
    if (!channel || channel.type !== 2) return message.reply('Voice channel not found or invalid.');

    joinVCConnection = joinVoiceChannel({
      channelId: VOICE_CHANNEL_ID,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfMute: true,
      selfDeaf: false,
    });

    // Wait until connected
    await entersState(joinVCConnection, VoiceConnectionStatus.Ready, 30_000);

    message.reply('Joined voice channel and muted.');

    // Reconnect logic if disconnected
    joinVCConnection.on('stateChange', (oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        // Attempt reconnect
        joinVCConnection.destroy();
        setTimeout(() => {
          joinVoiceChannel({
            channelId: VOICE_CHANNEL_ID,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
            selfMute: true,
            selfDeaf: false,
          });
        }, 5000);
      }
    });

  } catch (err) {
    console.error(err);
    message.reply('Failed to join voice channel.');
  }
}

// === Music command handlers ===
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  if (!message.guild) return;

  const prefix = '!';

  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift().toLowerCase();

  // === Host Friendly ===
  if (command === 'hostfriendly') {
    return handleHostFriendly(message);
  }

  // === DM Role ===
  if (command === 'dmrole') {
    return handleDmRole(message, args);
  }

  // === JoinVC ===
  if (command === 'joinvc') {
    return joinVoiceChannelHandler(message);
  }

  // === Music commands ===
  if (command === 'play') {
    if (!args.length) return message.reply('Please provide a song name or URL.');
    try {
      await distube.play(message.member.voice.channel, args.join(' '), { textChannel: message.channel, member: message.member });
    } catch (err) {
      message.reply('Error playing the song.');
      console.error(err);
    }
    return;
  }

  if (command === 'skip') {
    try {
      const queue = distube.getQueue(message);
      if (!queue) return message.reply('Nothing to skip.');
      queue.skip();
      message.reply('Skipped the song.');
    } catch {
      message.reply('Error skipping song.');
    }
    return;
  }

  if (command === 'stop') {
    try {
      const queue = distube.getQueue(message);
      if (!queue) return message.reply('Nothing to stop.');
      queue.stop();
      message.reply('Stopped the music.');
    } catch {
      message.reply('Error stopping music.');
    }
    return;
  }

  if (command === 'queue') {
    const queue = distube.getQueue(message);
    if (!queue) return message.reply('No songs in queue.');
    message.channel.send(`Queue:\n${queue.songs.map((song, i) => `${i+1}. ${song.name} - ${song.formattedDuration}`).join('\n')}`);
    return;
  }

  if (command === 'loop')