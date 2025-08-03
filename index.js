import { Client, GatewayIntentBits, Partials, PermissionsBitField, Routes, REST, Events } from 'discord.js';
import { joinVoiceChannel, getVoiceConnection } from '@discordjs/voice';
import express from 'express';
import 'dotenv/config';

const app = express();
app.get('/', (req, res) => res.send('Bot is alive!'));
app.listen(3000, () => console.log('Express server running'));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

const dmCache = new Set();
let currentHostMessage = null;
let reactedUsers = new Set();
let assignedRoles = new Map();
let positionEmojis = ['🧤', '🛡', '🛡️', '⚙️', '🌀', '🌀', '🎯'];
let positions = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), {
      body: [
        {
          name: 'dmrole',
          description: 'DMs a role',
          options: [
            {
              name: 'role',
              description: 'Role to DM',
              type: 8,
              required: true
            },
            {
              name: 'message',
              description: 'Message to send',
              type: 3,
              required: true
            }
          ]
        }
      ]
    });
  } catch (e) {
    console.error(e);
  }
});

client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  if (message.mentions.everyone) {
    try {
      await message.react('✅');
    } catch {}
  }

  if (message.content.startsWith('!joinvc')) {
    const channel = await message.guild.channels.fetch('1368359914145058956');
    if (!channel || channel.type !== 2) return;
    joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfMute: true
    });
  }

  if (message.content.startsWith('!dmrole')) {
    const args = message.content.split(' ').slice(1);
    const roleMention = message.mentions.roles.first();
    const dmMessage = args.slice(1).join(' ');
    if (!roleMention || !dmMessage) return message.reply('Usage: !dmrole @role message');

    const failed = [];
    for (const member of roleMention.members.values()) {
      if (dmCache.has(member.id)) continue;
      try {
        await member.send(dmMessage);
        dmCache.add(member.id);
      } catch {
        failed.push(member.user.tag);
      }
    }

    const log = failed.length
      ? `Failed to DM:\n${failed.join('\n')}`
      : 'All DMs sent successfully.';
    message.author.send(log).catch(() => {});
  }

  if (message.content.startsWith('!hostfriendly')) {
    runHostFriendly(message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'dmrole') {
    const role = interaction.options.getRole('role');
    const msg = interaction.options.getString('message');
    await interaction.reply({ content: 'Dming role...', ephemeral: true });

    const failed = [];
    for (const member of role.members.values()) {
      if (dmCache.has(member.id)) continue;
      try {
        await member.send(msg);
        dmCache.add(member.id);
      } catch {
        failed.push(member.user.tag);
      }
    }

    const log = failed.length
      ? `Failed to DM:\n${failed.join('\n')}`
      : 'All DMs sent successfully.';
    interaction.user.send(log).catch(() => {});
  }
});

async function runHostFriendly(message) {
  const member = await message.guild.members.fetch(message.author.id);
  const hasPermission = member.permissions.has(PermissionsBitField.Flags.Administrator) ||
    member.roles.cache.some(r => r.name === 'Friendlies Department');
  if (!hasPermission) return message.reply('You don’t have permission.');

  const friendlyMsg = await message.channel.send({
    content: '**Agnello FC Friendly Hosting - React to claim your position!**',
  });

  currentHostMessage = friendlyMsg;
  reactedUsers = new Set();
  assignedRoles = new Map();

  for (const emoji of positionEmojis) {
    await friendlyMsg.react(emoji);
  }

  const collector = friendlyMsg.createReactionCollector({ time: 10 * 60 * 1000 });

  collector.on('collect', async (reaction, user) => {
    if (user.bot) return;
    if (!positionEmojis.includes(reaction.emoji.name)) return;
    if (reactedUsers.has(user.id)) return;

    await wait(3000);
    const existing = [...assignedRoles.entries()].find(([_, uid]) => uid === user.id);
    if (existing) return;

    const index = positionEmojis.indexOf(reaction.emoji.name);
    if (index !== -1 && !assignedRoles.has(positions[index])) {
      assignedRoles.set(positions[index], user.id);
      reactedUsers.add(user.id);
      message.channel.send(`<@${user.id}> has claimed ${positions[index]}`);
    }
  });

  setTimeout(async () => {
    const totalReacts = [...assignedRoles.values()].length;
    if (totalReacts < 7) {
      message.channel.send('@here More reacts to get a friendly going!');
    }
  }, 60 * 1000);

  setTimeout(async () => {
    if (assignedRoles.size < 7) {
      message.channel.send('Friendly cancelled - not enough players.');
      currentHostMessage = null;
    }
  }, 10 * 60 * 1000);
}

client.on('messageCreate', async (msg) => {
  if (!currentHostMessage || !msg.channel || msg.author.bot) return;
  if (msg.channel.id !== currentHostMessage.channel.id) return;
  if (!msg.content.includes('http')) return;

  const recipients = [...assignedRoles.values()];
  for (const id of recipients) {
    try {
      const user = await client.users.fetch(id);
      await user.send(`Here’s the friendly, join up:\n${msg.content}`);
    } catch {}
  }

  currentHostMessage = null;
});

client.on('voiceStateUpdate', (oldState, newState) => {
  const connection = getVoiceConnection(newState.guild.id);
  if (!connection && oldState.channelId === '1368359914145058956') {
    const channel = oldState.guild.channels.cache.get('1368359914145058956');
    if (channel) {
      joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfMute: true
      });
    }
  }
});

client.login(process.env.TOKEN);