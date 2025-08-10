import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import dotenv from 'dotenv';
import express from 'express';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';

dotenv.config();

const TOKEN = process.env.TOKEN;
const GUILD_ID = '1357085245983162708';            // Your guild ID
const VOICE_CHANNEL_ID = '1368359914145058956';    // Your voice channel ID

if (!TOKEN) {
  console.error('Error: TOKEN is not set in environment variables.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Positions & emojis
const POSITIONS = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];

let friendlyMessage = null;
let friendlyCollector = null;
let claimedPositions = {};
let claimedUsers = new Set();
let pingedEveryone = false;

let voiceConnection = null;

async function tryAutoJoinVC() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);
    if (!guild) {
      console.log('Guild not found.');
      return;
    }
    const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);
    if (!channel || channel.type !== 2) {
      console.log('Voice channel not found or not a voice channel.');
      return;
    }

    voiceConnection = joinVoiceChannel({
      channelId: VOICE_CHANNEL_ID,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute: true,
      selfDeaf: false,
    });

    await entersState(voiceConnection, VoiceConnectionStatus.Ready, 20000);

    voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(voiceConnection, VoiceConnectionStatus.Signalling, 5000),
          entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5000),
        ]);
      } catch {
        voiceConnection.destroy();
        voiceConnection = null;
        console.log('Voice connection destroyed after failed reconnect.');
      }
    });

    console.log('Bot auto-joined voice channel.');
  } catch (error) {
    console.error('Error in tryAutoJoinVC:', error);
  }
}

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  tryAutoJoinVC();
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  if (message.mentions.everyone) {
    message.react('✅').catch(() => {});
  }

  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  if (command === 'hostfriendly') {
    if (friendlyMessage) {
      message.channel.send('A friendly is already being hosted. Please wait for it to finish.').catch(() => {});
      return;
    }

    claimedPositions = {};
    claimedUsers = new Set();
    pingedEveryone = false;

    const embed = new EmbedBuilder()
      .setTitle('AGNELLO FC 7v7 FRIENDLY')
      .setDescription(
        POSITIONS.map((pos, i) => `${numberEmojis[i]} → ${pos} : _available_`).join('\n') +
        '\n\nReact to claim your position. Only one position per user.'
      )
      .setColor('Blue');

    friendlyMessage = await message.channel.send({ content: '@everyone', embeds: [embed] });

    for (const emoji of numberEmojis) {
      await friendlyMessage.react(emoji);
    }

    friendlyCollector = friendlyMessage.createReactionCollector({
      filter: (reaction, user) => !user.bot && numberEmojis.includes(reaction.emoji.name),
      time: 10 * 60 * 1000,
      dispose: true,
    });

    setTimeout(async () => {
      if (!pingedEveryone && Object.keys(claimedPositions).length < POSITIONS.length) {
        await message.channel.send('@everyone More reacts to get a friendly!').catch(() => {});
        pingedEveryone = true;
      }
    }, 60 * 1000);

    friendlyCollector.on('collect', async (reaction, user) => {
      try {
        const userReactions = friendlyMessage.reactions.cache.filter(r => r.users.cache.has(user.id));
        for (const r of userReactions.values()) {
          if (r.emoji.name !== reaction.emoji.name) {
            await r.users.remove(user.id).catch(() => {});
          }
        }

        const posIndex = numberEmojis.indexOf(reaction.emoji.name);
        if (posIndex === -1) return;

        if (claimedPositions[posIndex]) {
          if (claimedPositions[posIndex] === user.id) return;
          reaction.users.remove(user.id).catch(() => {});
          message.channel.send(`${reaction.emoji} is already claimed by <@${claimedPositions[posIndex]}>.`).catch(() => {});
          return;
        }

        if (claimedUsers.has(user.id)) {
          reaction.users.remove(user.id).catch(() => {});
          message.channel.send(`<@${user.id}>, you already claimed a position.`).catch(() => {});
          return;
        }

        claimedPositions[posIndex] = user.id;
        claimedUsers.add(user.id);

        const lines = POSITIONS.map((pos, i) => {
          const userId = claimedPositions[i];
          return `${numberEmojis[i]} → ${pos} : ${userId ? `<@${userId}>` : '_available_'}`;
        });
        embed.setDescription(lines.join('\n') + '\n\nReact to claim your position. Only one position per user.');
        await friendlyMessage.edit({ embeds: [embed] });

        message.channel.send(`✅ ${posIndex + 1}️⃣ ${POSITIONS[posIndex]} confirmed for <@${user.id}>`).catch(() => {});

        if (Object.keys(claimedPositions).length === POSITIONS.length) {
          friendlyCollector.stop('full');
        }
      } catch (error) {
        console.error('Error handling friendly reaction:', error);
      }
    });

    friendlyCollector.on('end', async (_, reason) => {
      if (Object.keys(claimedPositions).length === POSITIONS.length) {
        const lineup = POSITIONS.map((pos, i) => `${pos}: <@${claimedPositions[i]}>`).join('\n');
        await message.channel.send(`**Friendly lineup confirmed:**\n${lineup}\n\nWaiting for the host to post the friendly link...`);
      } else {
        await message.channel.send('Friendly cancelled due to not enough players.');
      }

      friendlyMessage = null;
      friendlyCollector = null;
      claimedPositions = {};
      claimedUsers.clear();
      pingedEveryone = false;
    });

    return;
  }

  if (command === 'dmrole') {
    const role = message.mentions.roles.first();
    if (!role) {
      message.reply('Please mention a role to DM.').catch(() => {});
      return;
    }
    args.shift();
    const dmMessage = args.join(' ');
    if (!dmMessage) {
      message.reply('Please provide a message to send.').catch(() => {});
      return;
    }

    let success = 0;
    let failed = 0;
    for (const member of role.members.values()) {
      try {
        await member.send(dmMessage);
        success++;
      } catch {
        failed++;
      }
    }

    message.channel.send(`Sent message to ${success} members. Failed to DM ${failed} members.`).catch(() => {});
    return;
  }

  if (command === 'activitycheck') {
    let goal = parseInt(args[0]);
    if (isNaN(goal) || goal < 1) goal = 40;
    let duration = parseInt(args[1]);
    if (isNaN(duration) || duration < 1) duration = 24;

    const embed = new EmbedBuilder()
      .setTitle('🏆 Agnello FC Activity Check')
      .setDescription('React with ✅ to join the activity check!')
      .addFields(
        { name: 'Goal', value: `${goal}`, inline: true },
        { name: 'Duration', value: `${duration} hour(s)`, inline: true }
      )
      .setColor('Green')
      .setFooter({ text: 'React to this message!' });

    const activityMessage = await message.channel.send({ content: '@everyone', embeds: [embed] });
    await activityMessage.react('✅');
    return;
  }

  if (command === 'joinvc') {
    try {
      const guild = await client.guilds.fetch(GUILD_ID);
      if (!guild) {
        message.channel.send('Guild not found.').catch(() => {});
        return;
      }

      const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);
      if (!channel || channel.type !== 2) {
        message.channel.send('Voice channel not found or invalid.').catch(() => {});
        return;
      }

      voiceConnection = joinVoiceChannel({
        channelId: VOICE_CHANNEL_ID,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfMute: true,
        selfDeaf: false,
      });

      await entersState(voiceConnection, VoiceConnectionStatus.Ready, 20000);
      message.channel.send('Joined the voice channel and muted.').catch(() => {});

      voiceConnection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(voiceConnection, VoiceConnectionStatus.Signalling, 5000),
            entersState(voiceConnection, VoiceConnectionStatus.Connecting, 5000),
          ]);
        } catch {
          voiceConnection.destroy();
          voiceConnection = null;
          console.log('Voice connection destroyed after failed reconnect.');
        }
      });
    } catch (error) {
      console.error('Error joining voice channel:', error);
      message.channel.send('Failed to join voice channel.').catch(() => {});
    }
    return;
  }
});

// Simple express server to keep bot alive
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

client.login(TOKEN);