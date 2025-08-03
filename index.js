import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField
} from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import express from 'express';
import 'dotenv/config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const app = express();
app.get('/', (_, res) => res.send('Bot is alive!'));
app.listen(3000, () => console.log('Server running'));

const wait = ms => new Promise(res => setTimeout(res, ms));

const token = process.env.DISCORD_TOKEN;
const voiceChannelId = '1368359914145058956';

const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
const positions = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
const active = new Set();

// === AUTO VC CONNECT ===
async function connectToVC(guild) {
  try {
    const channel = guild.channels.cache.get(voiceChannelId);
    if (!channel || channel.type !== 2) return;
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfMute: true
    });
    await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
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
    await wait(5000);
    const guild = oldState.guild;
    await connectToVC(guild);
  }
});

// === FRIENDLY ===
async function runHostFriendly(channel, hostMember) {
  const hasPermission =
    hostMember.permissions.has(PermissionsBitField.Flags.Administrator) ||
    hostMember.roles.cache.some(r => r.name === 'Friendlies Department');

  if (!hasPermission) {
    await channel.send('❌ Only Admins or members of **Friendlies Department** can host.');
    return;
  }

  if (active.has(channel.id)) {
    await channel.send('❌ A friendly is already being hosted in this channel.');
    return;
  }

  active.add(channel.id);

  const ann = await channel.send({
    content:
      `> **AGNELLO FC 7v7 FRIENDLY**\n` +
      `> React 1️⃣ → GK\n` +
      `> React 2️⃣ → CB\n` +
      `> React 3️⃣ → CB2\n` +
      `> React 4️⃣ → CM\n` +
      `> React 5️⃣ → LW\n` +
      `> React 6️⃣ → RW\n` +
      `> React 7️⃣ → ST\n` +
      `@here`
  });

  for (const e of emojis) await ann.react(e);

  let done = false;
  const claimedMap = new Map();
  const claimedUsers = new Set();

  const collector = ann.createReactionCollector({ time: 10 * 60_000 });

  collector.on('collect', (reaction, user) => {
    if (user.bot || done) return;
    const emoji = reaction.emoji.name;
    const idx = emojis.indexOf(emoji);
    if (idx === -1) return;

    if (claimedUsers.has(user.id)) {
      reaction.users.remove(user.id).catch(() => {});
      return;
    }

    if (!claimedMap.has(emoji)) {
      setTimeout(async () => {
        if (claimedUsers.has(user.id)) return;
        claimedMap.set(emoji, user.id);
        claimedUsers.add(user.id);
        await channel.send(`✅ ${positions[idx]} confirmed for <@${user.id}>`);
        if (claimedMap.size >= 7) {
          done = true;
          collector.stop('full');
        }
      }, 3000);
    } else {
      reaction.users.remove(user.id).catch(() => {});
    }
  });

  setTimeout(async () => {
    if (!done && claimedMap.size < 7) {
      await channel.send({
        content: '@here not enough reacts yet!',
        allowedMentions: { parse: ['here'] }
      });
    }
  }, 60_000);

  collector.on('end', async (_, reason) => {
    if (!done || claimedMap.size < 7) {
      await channel.send('❌ Not enough players reacted. Friendly cancelled.');
      active.delete(channel.id);
      return;
    }

    const lines = positions.map((pos, i) => {
      const uid = claimedMap.get(emojis[i]);
      return `${pos} — ${uid ? `<@${uid}>` : 'OPEN'}`;
    });

    await channel.send('✅ Final Positions:\n' + lines.join('\n'));

    const filter = msg =>
      msg.author.id === hostMember.id &&
      msg.channel.id === channel.id &&
      msg.content.includes('https://');

    const linkCollector = channel.createMessageCollector({ filter, time: 5 * 60_000, max: 1 });

    linkCollector.on('collect', async msg => {
      const link = msg.content.trim();
      for (const uid of claimedMap.values()) {
        try {
          const u = await client.users.fetch(uid);
          await u.send(`Here’s the friendly, join up: ${link}`);
        } catch {
          console.error('❌ Failed to DM', uid);
        }
      }
      await channel.send('✅ DMs sent to all players!');
      active.delete(channel.id);
    });

    linkCollector.on('end', collected => {
      if (collected.size === 0) {
        channel.send('❌ No link received—friendly not shared.');
        active.delete(channel.id);
      }
    });
  });
}

// === PREFIX COMMANDS ===
client.on('messageCreate', async msg => {
  if (msg.author.bot) return;

  if (msg.content === '!hostfriendly') {
    await runHostFriendly(msg.channel, msg.member);
  }

  if (msg.content === '!joinvc') {
    const guild = msg.guild;
    await connectToVC(guild);
    msg.channel.send('🔊 Joining VC...');
  }

  if (msg.content.startsWith('!dmrole')) {
    const args = msg.content.split(' ');
    const roleMention = args[1];
    const messageToSend = args.slice(2).join(' ');

    if (!roleMention || !messageToSend) {
      return msg.reply('❌ Usage: `!dmrole @Role message here`');
    }

    const roleId = roleMention.replace(/[<@&>]/g, '');
    const role = msg.guild.roles.cache.get(roleId);
    if (!role) return msg.reply('❌ Role not found.');

    const failed = [];

    msg.reply(`📨 Sending messages to **${role.name}**...`);

    for (const member of role.members.values()) {
      try {
        await member.send(messageToSend);
      } catch {
        failed.push(member.user.tag);
      }
    }

    if (failed.length > 0) {
      const failedList = failed.join('\n');
      await msg.author.send(`❌ Failed to DM these users:\n${failedList}`);
    }

    msg.channel.send('✅ DMs sent!');
  }
});

client.login(token);
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);