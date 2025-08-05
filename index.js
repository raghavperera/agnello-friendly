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

// Format the reaction role message with username + mention
async function formatPositionMessage(claimedMap) {
  let lines = ['React to claim your position:\n'];
  for (let i = 0; i < 7; i++) {
    const emoji = numberEmojis[i];
    const pos = positionNames[i];
    if (claimedMap.has(i)) {
      try {
        const user = await client.users.fetch(claimedMap.get(i));
        lines.push(`${emoji} ${pos} - ${user.tag} (<@${user.id}>)`);
      } catch {
        lines.push(`${emoji} ${pos} - Unknown User`);
      }
    } else {
      lines.push(`${emoji} ${pos} - Unclaimed`);
    }
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

  const claimedMap = new Map();
  const claimedUsers = new Set();

  // Initial message with reaction roles, use async formatPositionMessage
  const ann = await channel.send(await formatPositionMessage(claimedMap));
  for (const e of numberEmojis) await ann.react(e);

  let done = false;
  const collector = ann.createReactionCollector({ time: 10 * 60_000 });

  collector.on('collect', async (reaction, user) => {
    if (user.bot || done) return;
    const idx = numberEmojis.indexOf(reaction.emoji.name);
    if (idx === -1) return;

    if (claimedUsers.has(user.id) || claimedMap.has(idx)) {
      reaction.users.remove(user.id).catch(() => {});
      return;
    }

    setTimeout(async () => {
      if (claimedUsers.has(user.id) || claimedMap.has(idx)) return;
      claimedMap.set(idx, user.id);
      claimedUsers.add(user.id);
      await ann.edit(await formatPositionMessage(claimedMap));
      if (claimedMap.size >= 7 && !done) {
        done = true;
        collector.stop();
      }
    }, 3000);
  });

  collector.on('end', async () => {
    if (claimedMap.size < 7) {
      await channel.send('❌ Not enough players reacted. Friendly cancelled.');
      active.delete(channel.id);
      return;
    }
    // Final lineup with username + mention
    const finalLines = [];
    for (let i = 0; i < 7; i++) {
      const uid = claimedMap.get(i);
      try {
        const user = await client.users.fetch(uid);
        finalLines.push(`${positionNames[i]} — ${user.tag} (<@${user.id}>)`);
      } catch {
        finalLines.push(`${positionNames[i]} — Unknown User`);
      }
    }
    await channel.send('✅ Final Positions:\n' + finalLines.join('\n'));

    // Wait for host to send the friendly link, then DM players
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
      await channel.send('✅ DMs sent!');
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
    return;
  }

  if (msg.content === '!joinvc') {
    await connectToVC(msg.guild);
    msg.channel.send('🔊 Joining VC...');
    return;
  }

  if (msg.content.startsWith('!dmrole')) {
    const [_, roleMention, ...rest] = msg.content.split(' ');
    const text = rest.join(' ');
    if (!roleMention || !text) {
      return msg.reply('❌ Usage: `!dmrole @Role message`');
    }
    const roleId = roleMention.replace(/[<@&>]/g, '');
    const role = msg.guild.roles.cache.get(roleId);
    if (!role) return msg.reply('❌ Role not found.');
    const failed = [];
    await msg.reply(`📨 Sending to **${role.name}**...`);
    for (const member of role.members.values()) {
      try {
        await member.send(`<@${member.id}>`);
        await member.send(text);
      } catch {
        failed.push(member.user.tag);
      }
    }
    if (failed.length) {
      await msg.author.send(`❌ Failed to DM: ${failed.join(', ')}`);
    }
    msg.channel.send('✅ DMs sent!');
    return;
  }

  if (msg.content.startsWith('!dmchannel')) {
    const [_, channelMention] = msg.content.split(' ');
    if (!channelMention) {
      return msg.reply('❌ Usage: `!dmchannel #channel`');
    }
    if (!msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return msg.reply('❌ You need Admin permission.');
    }
    const channelId = channelMention.replace(/[<#>]/g, '');
    let target;
    try {
      target = await msg.guild.channels.fetch(channelId);
    } catch {
      return msg.reply('❌ Invalid channel.');
    }
    if (!target || !target.isTextBased()) {
      return msg.reply('❌ Not a text channel.');
    }
    const fetched = await target.messages.fetch({ limit: 100 });
    const users = new Set();
    fetched.forEach(m => {
      if (!m.author.bot) users.add(m.author);
    });
    const invite = 'https://discord.gg/cbpWRu6xn5';
    const failed = [];
    for (const user of users) {
      try {
        await user.send(invite);
      } catch {
        failed.push(user.tag);
      }
    }
    msg.reply(`✅ DMed ${users.size - failed.length} users.` +
      (failed.length ? ` ❌ Failed: ${failed.join(', ')}` : ''));
    return;
  }
});

client.login(token);
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);