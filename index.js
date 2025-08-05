import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder
} from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import express from 'express';
import 'dotenv/config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const app = express();
const port = process.env.PORT || 3000;

app.get('/', (_, res) => {
  res.send('Bot is alive!');
});
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

const voiceChannelId = '1368359914145058956';
let currentVC;

async function connectToVC(guild) {
  try {
    const channel = await guild.channels.fetch(voiceChannelId);
    if (!channel?.isVoiceBased()) return;
    currentVC = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfMute: true
    });
    await entersState(currentVC, VoiceConnectionStatus.Ready, 30_000);
    console.log('🔊 Connected to VC');
  } catch (err) {
    console.error('Failed to join VC:', err);
  }
}

client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  const guild = client.guilds.cache.first();
  if (guild) await connectToVC(guild);
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  if (
    oldState.channelId === voiceChannelId &&
    !newState.channelId &&
    oldState.member?.user.id === client.user.id
  ) {
    setTimeout(() => connectToVC(oldState.guild), 5000);
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // React ✅ to @everyone or @here pings
  if (message.content.toLowerCase().includes('@everyone') || message.content.toLowerCase().includes('@here')) {
    try {
      await message.react('✅');
    } catch {
      // Ignore
    }
  }

  // === !hostfriendly command ===
  if (message.content.toLowerCase().startsWith('!hostfriendly')) {
    const args = message.content.split(' ');
    const positions = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
    const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
    const positionMap = {}; // emoji -> user
    const claimed = new Map(); // userID -> emoji

    // Permission check: Admin or Friendlies Department role
    const member = message.member;
    if (
      !member.permissions.has(PermissionsBitField.Flags.Administrator) &&
      !member.roles.cache.some(r => r.name === 'Friendlies Department')
    ) {
      return message.channel.send('❌ Only Admins or members of **Friendlies Department** can host.');
    }

    // Check for active friendly in channel (optional, can remove if you want multiple)
    // You can implement a Set to prevent multiple simultaneous friendlies per channel if desired

    // Optional host position
    const hostPosition = args[1]?.toUpperCase();
    if (hostPosition && !positions.includes(hostPosition)) {
      return message.channel.send(`❌ Invalid position. Choose one of: ${positions.join(', ')}`);
    }

    // Assign host position if specified
    if (hostPosition) {
      const idx = positions.indexOf(hostPosition);
      const emoji = emojis[idx];
      positionMap[emoji] = message.author;
      claimed.set(message.author.id, emoji);
    }

    // Build initial embed
    const embed = new EmbedBuilder()
      .setTitle('Agnello FC Friendly Positions')
      .setDescription(positions.map((pos, i) => {
        const emoji = emojis[i];
        const user = positionMap[emoji];
        return `${emoji} ${pos}: ${user ? `<@${user.id}> (${user.username})` : 'Unclaimed'}`;
      }).join('\n'))
      .setColor(0x00AE86);

    const sent = await message.channel.send({ content: '@here React to claim a position!', embeds: [embed] });

    // React only with emojis for unclaimed positions
    for (let i = 0; i < emojis.length; i++) {
      if (!positionMap[emojis[i]]) {
        await sent.react(emojis[i]);
      }
    }

    const filter = (reaction, user) => emojis.includes(reaction.emoji.name) && !user.bot;

    const collector = sent.createReactionCollector({ filter, time: 600_000 });

    collector.on('collect', async (reaction, user) => {
      // Only one position per user
      if (claimed.has(user.id)) {
        reaction.users.remove(user.id).catch(() => {});
        return;
      }

      const emoji = reaction.emoji.name;

      // Position must be free
      if (positionMap[emoji]) {
        reaction.users.remove(user.id).catch(() => {});
        return;
      }

      // Assign position
      positionMap[emoji] = user;
      claimed.set(user.id, emoji);

      // Update embed
      const updatedEmbed = new EmbedBuilder()
        .setTitle('Agnello FC Friendly Positions')
        .setDescription(positions.map((pos, i) => {
          const e = emojis[i];
          const u = positionMap[e];
          return `${e} ${pos}: ${u ? `<@${u.id}> (${u.username})` : 'Unclaimed'}`;
        }).join('\n'))
        .setColor(0x00AE86);

      await sent.edit({ embeds: [updatedEmbed] });

      if (claimed.size === 7) {
        collector.stop('filled');
      }
    });

    // Ping @here at 1 minute if not full
    setTimeout(() => {
      if (claimed.size < 7) {
        message.channel.send('@here Need more reactions to start the friendly!');
      }
    }, 60_000);

    // Cancel friendly after 10 minutes if not full
    setTimeout(() => {
      if (claimed.size < 7) {
        message.channel.send('❌ Friendly cancelled — not enough players after 10 minutes.');
        collector.stop('timeout');
      }
    }, 600_000);

    collector.on('end', async (collected, reason) => {
      if (reason === 'filled') {
        await message.channel.send('✅ All positions claimed! Waiting for host to post the invite link...');
      } else if (reason === 'timeout') {
        return;
      }

      // Wait for host to post link in same channel
      const filterLink = m => m.author.id === message.author.id && m.channel.id === message.channel.id && m.content.includes('https://');
      const linkCollector = message.channel.createMessageCollector({ filter: filterLink, time: 5 * 60_000, max: 1 });

      linkCollector.on('collect', async (msg) => {
        const link = msg.content.trim();

        // DM all claimed players
        const failed = [];
        for (const user of claimed.values()) {
          try {
            const u = await client.users.fetch(user.id);
            await u.send(`Here’s the friendly, join up: ${link}`);
          } catch {
            failed.push(user.username || user.id);
          }
        }

        if (failed.length) {
          message.channel.send(`❌ Failed to DM: ${failed.join(', ')}`);
        } else {
          message.channel.send('✅ DMs sent to all players!');
        }
      });

      linkCollector.on('end', collected => {
        if (collected.size === 0) {
          message.channel.send('❌ No invite link received. Friendly not shared.');
        }
      });
    });

    return;
  }

  // === !joinvc command ===
  if (message.content.toLowerCase() === '!joinvc') {
    if (!message.guild) return;
    await connectToVC(message.guild);
    message.channel.send('🔊 Joining VC...');
    return;
  }

  // === !dmrole command ===
  if (message.content.toLowerCase().startsWith('!dmrole')) {
    if (!message.guild) return;
    const [_, roleMention, ...rest] = message.content.split(' ');
    const text = rest.join(' ');
    if (!roleMention || !text) {
      return message.reply('❌ Usage: `!dmrole @Role message`');
    }
    const roleId = roleMention.replace(/[<@&>]/g, '');
    const role = message.guild.roles.cache.get(roleId);
    if (!role) return message.reply('❌ Role not found.');

    const failed = [];
    await message.reply(`📨 Sending to **${role.name}**...`);
    for (const member of role.members.values()) {
      try {
        await member.send(`<@${member.id}>`);
        await member.send(text);
      } catch {
        failed.push(member.user.tag);
      }
    }
    if (failed.length) {
      await message.author.send(`❌ Failed to DM: ${failed.join(', ')}`);
    }
    message.channel.send('✅ DMs sent!');
    return;
  }

  // === !dmchannel command ===
  if (message.content.toLowerCase().startsWith('!dmchannel')) {
    if (!message.guild) return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('❌ You need Admin permission.');
    }
    const [_, channelMention] = message.content.split(' ');
    if (!channelMention) {
      return message.reply('❌ Usage: `!dmchannel #channel`');
    }
    const channelId = channelMention.replace(/[<#>]/g, '');
    let targetChannel;
    try {
      targetChannel = await message.guild.channels.fetch(channelId);
    } catch {
      return message.reply('❌ Invalid channel.');
    }
    if (!targetChannel?.isTextBased()) {
      return message.reply('❌ Not a text channel.');
    }
    const fetched = await targetChannel.messages.fetch({ limit: 100 });
    const users = new Set();
    fetched.forEach(m => {
      if (!m.author.bot) users.add(m.author);
    });

    const invite = 'https://discord.gg/cbpWRu6xn5'; // your invite link
    const failed = [];

    for (const user of users) {
      try {
        await user.send(invite);
      } catch {
        failed.push(user.tag);
      }
    }

    message.reply(`✅ DMed ${users.size - failed.length} users.` + (failed.length ? ` ❌ Failed: ${failed.join(', ')}` : ''));
    return;
  }
});

client.login(process.env.TOKEN);

process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);