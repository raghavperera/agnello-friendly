import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  ActivityType
} from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import express from 'express';
import 'dotenv/config';
import fs from 'fs';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

const app = express();
app.get('/', (_, res) => res.send('Bot is running.'));
app.listen(3000, () => console.log('Express server is online.'));

const failedDMs = {};
const dmCache = new Set();
let currentConnection;
const VC_ID = '1368359914145058956';
const CHANNEL_TO_DM = '1325529675912450239';
const INVITE_LINK = 'https://discord.gg/cbpWRu6xn5';

client.once('ready', () => {
  console.log(`Bot is ready as ${client.user.tag}`);
  joinVC();
  client.user.setActivity('for friendlies ⚽', { type: ActivityType.Watching });
});

async function joinVC() {
  const guild = client.guilds.cache.first();
  if (!guild) return;
  const channel = guild.channels.cache.get(VC_ID);
  if (!channel) return;
  currentConnection = joinVoiceChannel({
    channelId: VC_ID,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfMute: true
  });
  try {
    await entersState(currentConnection, VoiceConnectionStatus.Ready, 30_000);
    console.log('Connected to VC');
  } catch {
    console.error('Failed to connect to VC');
  }
}

client.on('voiceStateUpdate', (_, newState) => {
  if (newState.channelId !== VC_ID) {
    setTimeout(() => joinVC(), 2000);
  }
});

client.on('messageCreate', async (msg) => {
  if (msg.content.startsWith('!dmrole') && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    const role = msg.mentions.roles.first();
    const content = msg.content.split(' ').slice(2).join(' ');
    if (!role || !content) return msg.reply('Mention a role and provide a message.');
    msg.reply(`Dming role: ${role.name}`);
    const failed = [];
    const promises = role.members.map(async (member) => {
      if (dmCache.has(member.id)) return;
      try {
        await member.send(content);
        dmCache.add(member.id);
      } catch {
        failed.push(`<@${member.id}>`);
      }
    });
    await Promise.all(promises);
    if (failed.length > 0) {
      msg.author.send(`Could not DM:
${failed.join(', ')}`);
    }
  }

  if (msg.content === '!dmchannel') {
    const channel = client.channels.cache.get(CHANNEL_TO_DM);
    if (!channel || !channel.isTextBased()) return;
    const members = await channel.members;
    for (const member of members.values()) {
      if (dmCache.has(member.id) || member.user.bot) continue;
      try {
        await member.send(`Join up - ${INVITE_LINK}`);
        dmCache.add(member.id);
      } catch {
        console.log(`Failed to DM ${member.user.tag}`);
      }
    }
  }

  if (msg.content === '!joinvc') {
    joinVC();
    msg.reply('Joining VC...');
  }

  if (msg.content === '!activitycheck') {
    const embed = new EmbedBuilder()
      .setTitle('<:Agnello:123456789> Agnello FC Activity Check')
      .setDescription('**React with:** 🐐
**Goal:** 40
**Duration:** 1 Day
@everyone');
    const message = await msg.channel.send({ content: '@everyone', embeds: [embed] });
    await message.react('🐐');
  }
});

client.on('guildMemberRemove', async (member) => {
  const goodbyeMessage = `Dear <@${member.id}>,

We hope this message finds you well. We wanted to take a moment to sincerely apologize for any frustrations, miscommunication, or inactivity that may have led you to leave the team. Your presence truly meant a lot to us—not just as players, but as part of our football family.

We understand that things weren’t perfect. There were times when activity dropped, when communication could’ve been better, and maybe when we didn’t give everyone the playing time or attention they deserved. For that, we are genuinely sorry.

Moving forward, we’re committed to improving. That means:

• Scheduling more friendlies so everyone can stay active and enjoy the game
• Not over-pinging, but still keeping communication clear and respectful
• Making sure everyone gets fair playing time, because every player matters
• And most importantly, never taking our teammates for granted again

We’d love to see you back with us someday, but whether you return or not, please know that you were—and still are—valued and appreciated.

https://discord.gg/QqTWBUkPCw

With respect and gratitude,
The Agnello FC Team`;
  try {
    await member.send(goodbyeMessage);
  } catch (err) {
    console.log(`Could not DM ${member.user.tag}`);
  }
});

client.on('messageCreate', (msg) => {
  if (msg.mentions.everyone || msg.mentions.roles.some(role => ['everyone', 'here'].includes(role.name.toLowerCase()))) {
    msg.react('✅');
  }
});

// Slash command setup for /dmrole
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName === 'dmrole') {
    const role = interaction.options.getRole('role');
    const message = interaction.options.getString('message');
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: 'You do not have permission.', ephemeral: true });
    }
    await interaction.reply(`Dming role: ${role.name}`);
    const failed = [];
    const promises = role.members.map(async (member) => {
      if (dmCache.has(member.id)) return;
      try {
        await member.send(message);
        dmCache.add(member.id);
      } catch {
        failed.push(`<@${member.id}>`);
      }
    });
    await Promise.all(promises);
    if (failed.length > 0) {
      interaction.user.send(`Could not DM:
${failed.join(', ')}`);
    }
  }
});

client.login(process.env.TOKEN);