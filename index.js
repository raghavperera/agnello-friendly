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

const numberEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
const positionNames = ['GK','CB','CB2','CM','LW','RW','ST'];
const active = new Set();

function formatPositionMessage(claimedMap) {
  let lines = ['React to claim your position:\n'];
  for (let i = 0; i < 7; i++) {
    const emoji = numberEmojis[i];
    const pos = positionNames[i];
    const claimant = claimedMap.has(i)
      ? `<@${claimedMap.get(i)}>`
      : 'Unclaimed';
    lines.push(`${emoji} ${pos} - ${claimant}`);
  }
  return lines.join('\n');
}

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
    await connectToVC(oldState.guild);
  }
});

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

  // initial claimed map: emoji index -> userId
  const claimedMap = new Map();
  const claimedUsers = new Set();

  // send initial message
  const ann = await channel.send(
    formatPositionMessage(claimedMap)
  );
  for (const e of numberEmojis) await ann.react(e);

  let done = false;
  // ping @everyone 3 times over first minute
  let pingCount = 0;
  const pingInterval = setInterval(async () => {
    if (done || pingCount >= 3 || claimedMap.size >= 7) {
      clearInterval(pingInterval);
      return;
    }
    await channel.send({
      content: '@everyone react to get positions!',
      allowedMentions: { parse: ['everyone'] }
    });
    pingCount++;
  }, 20_000);

  const collector = ann.createReactionCollector({ time: 10 * 60_000 });

  collector.on('collect', async (reaction, user) => {
    if (user.bot || done) return;
    const idx = numberEmojis.indexOf(reaction.emoji.name);
    if (idx === -1) return;
    if (claimedUsers.has(user.id)) {
      reaction.users.remove(user.id).catch(() => {});
      return;
    }
    if (!claimedMap.has(idx)) {
      // first-come, first-serve
      setTimeout(async () => {
        if (claimedUsers.has(user.id)) return;
        claimedMap.set(idx, user.id);
        claimedUsers.add(user.id);
        // update the message
        await ann.edit(formatPositionMessage(claimedMap));
        if (claimedMap.size >= 7 && !done) {
          done = true;
          collector.stop('full');
        }
      }, 3000);
    } else {
      reaction.users.remove(user.id).catch(() => {});
    }
  });

  collector.on('end', async () => {
    clearInterval(pingInterval);
    if (!done || claimedMap.size < 7) {
      await channel.send('❌ Not enough players reacted. Friendly cancelled.');
      active.delete(channel.id);
      return;
    }
    // all positions filled
    await channel.send('✅ All positions claimed! Final lineup:');
    for (let i = 0; i < 7; i++) {
      const userId = claimedMap.get(i);
      await channel.send(`${positionNames[i]} — <@${userId}>`);
    }

    // collect host link and DM players
    const filter = msg =>
      msg.author.id === hostMember.id &&
      msg.channel.id === channel.id &&
      msg.content.includes('https://');
    const linkCollector = channel.createMessageCollector({ filter, time: 5 * 60_000, max: 1 });

    linkCollector.on('collect', async msg => {
      const link = msg.content.trim();
      for (const userId of claimedMap.values()) {
        try {
          const u = await client.users.fetch(userId);
          await u.send(`<@${userId}>`);
          await u.send(`Here’s the friendly, join up: ${link}`);
        } catch {
          console.error('❌ Failed to DM', userId);
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

client.on('messageCreate', async msg => {
  if (msg.author.bot) return;

  if (msg.content === '!hostfriendly') {
    await runHostFriendly(msg.channel, msg.member);
  }

  if (msg.content === '!joinvc') {
    await connectToVC(msg.guild);
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
        await member.send(`<@${member.id}>`);
        await member.send(messageToSend);
      } catch {
        failed.push(member.user.tag);
      }
    }
    if (failed.length) {
      await msg.author.send(`❌ Failed to DM these users:\n${failed.join('\n')}`);
    }
    msg.channel.send('✅ DMs sent!');
  }
});

client.login(token);
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);