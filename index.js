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

let currentConnection;
const VC_ID = '1368359914145058956';
const CHANNEL_TO_DM = '1325529675912450239';
const INVITE_LINK = 'https://discord.gg/cbpWRu6xn5';
const reactionEmojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
const positions = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
let activeHostMessage = null;
let positionClaimers = {};

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

client.on('voiceStateUpdate', (oldState, newState) => {
  if (newState.id === client.user.id && newState.channelId !== VC_ID) {
    setTimeout(() => joinVC(), 2000);
  }
});

client.on('messageCreate', async (msg) => {
  if (msg.author.bot) return;

  // ✅ DM entire role
  if (msg.content.startsWith('!dmrole') && msg.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    const role = msg.mentions.roles.first();
    const content = msg.content.split(' ').slice(2).join(' ');
    if (!role || !content) return msg.reply('Mention a role and provide a message.');
    msg.reply(`Dming role: ${role.name}`);
    const failed = [];

    const promises = Array.from(role.members.values()).map(async (member) => {
      if (member.user.bot) return;
      try {
        await member.send(content);
      } catch {
        failed.push(`<@${member.id}>`);
      }
    });

    await Promise.all(promises);
    if (failed.length > 0) {
      msg.author.send(`Could not DM:\n${failed.join(', ')}`);
    }
  }

  // ✅ DM channel
  if (msg.content === '!dmchannel') {
    const channel = client.channels.cache.get(CHANNEL_TO_DM);
    if (!channel || !channel.isTextBased()) return;
    const members = await channel.members;
    for (const member of members.values()) {
      if (member.user.bot) continue;
      try {
        await member.send(`Join up - ${INVITE_LINK}`);
      } catch {
        console.log(`Failed to DM ${member.user.tag}`);
      }
    }
  }

  // ✅ Join VC
  if (msg.content === '!joinvc') {
    joinVC();
    msg.reply('Joining VC...');
  }

  // ✅ Activity check
  if (msg.content === '!activitycheck') {
    const embed = new EmbedBuilder()
      .setTitle('<:Agnello:123456789> Agnello FC Activity Check')
      .setDescription(`**React with:** 🐐\n**Goal:** 40\n**Duration:** 1 Day\n@everyone`);
    const message = await msg.channel.send({ content: '@everyone', embeds: [embed] });
    await message.react('🐐');
  }

  // ✅ Hostfriendly
  if (msg.content === '!hostfriendly') {
    if (activeHostMessage) return msg.reply('A friendly is already being hosted.');
    const embed = new EmbedBuilder()
      .setTitle('**AGNELLO FC 7v7 FRIENDLY**')
      .setDescription(
        reactionEmojis.map((emoji, index) => `React ${emoji} → ${positions[index]}`).join('\n') + '\n@everyone'
      );
    const message = await msg.channel.send({ embeds: [embed] });
    activeHostMessage = message;
    positionClaimers = {};
    for (const emoji of reactionEmojis) {
      await message.react(emoji);
    }

    // 1 minute check
    setTimeout(async () => {
      const freshMsg = await message.fetch();
      const totalReacts = reactionEmojis.reduce((sum, emoji) => {
        const reaction = freshMsg.reactions.cache.get(emoji);
        return sum + (reaction ? reaction.count - 1 : 0);
      }, 0);
      if (totalReacts < 7) {
        msg.channel.send('@here More reacts to get a friendly');
      }
    }, 60_000);

    // 10 minute timeout
    setTimeout(async () => {
      const freshMsg = await message.fetch();
      const totalReacts = reactionEmojis.reduce((sum, emoji) => {
        const reaction = freshMsg.reactions.cache.get(emoji);
        return sum + (reaction ? reaction.count - 1 : 0);
      }, 0);
      if (totalReacts < 7) {
        await msg.channel.send('❌ Friendly cancelled.');
        activeHostMessage = null;
        positionClaimers = {};
      }
    }, 600_000);
  }

  // ✅ Detect friendly link from host and DM players
  if (activeHostMessage && msg.content.includes('https://')) {
    const mentions = Object.values(positionClaimers);
    for (const user of mentions) {
      try {
        await user.send('Here’s the friendly, join up:\n' + msg.content);
      } catch {
        console.log(`Failed to DM ${user.tag}`);
      }
    }
    await msg.channel.send('✅ Lineup notified.');
    activeHostMessage = null;
    positionClaimers = {};
  }

  // ✅ React ✅ to @everyone / @here
  if (msg.mentions.everyone || msg.content.includes('@here')) {
    msg.react('✅');
  }
});

// ✅ Reaction for hostfriendly
client.on('messageReactionAdd', async (reaction, user) => {
  if (!activeHostMessage || user.bot || reaction.message.id !== activeHostMessage.id) return;
  const index = reactionEmojis.indexOf(reaction.emoji.name);
  if (index === -1) return;

  // Don't allow user to claim multiple roles
  if (Object.values(positionClaimers).some(u => u.id === user.id)) return;

  const position = positions[index];
  positionClaimers[position] = user;
  const updatedDesc = reactionEmojis.map((emoji, i) => {
    const p = positions[i];
    return `React ${emoji} → ${p} ${positionClaimers[p] ? `✅ <@${positionClaimers[p].id}>` : ''}`;
  }).join('\n') + '\n@everyone';
  const embed = EmbedBuilder.from(activeHostMessage.embeds[0]).setDescription(updatedDesc);
  await activeHostMessage.edit({ embeds: [embed] });

  await reaction.message.channel.send(`✅ ${position} confirmed for <@${user.id}>`);

  // Send lineup if all filled
  if (Object.keys(positionClaimers).length === 7) {
    const lineup = positions.map(p => `${p}: <@${positionClaimers[p].id}>`).join('\n');
    await reaction.message.channel.send(`**Final Lineup:**\n${lineup}`);
    await reaction.message.channel.send('Finding friendly, looking for a rob...');
  }
});

// ✅ Goodbye message
client.on('guildMemberRemove', async (member) => {
  const goodbyeMessage = `Dear <@${member.id}>,

We hope this message finds you well. We wanted to take a moment to sincerely apologize for any frustrations, miscommunication, or inactivity that may have led you to leave the team. Your presence truly meant a lot to us—not just as players, but as part of our football family.

[...same message as before...]

https://discord.gg/QqTWBUkPCw

With respect and gratitude,  
The Agnello FC Team`;
  try {
    await member.send(goodbyeMessage);
  } catch {
    console.log(`Could not DM ${member.user.tag}`);
  }
});

// ✅ Slash command /dmrole
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

    const promises = Array.from(role.members.values()).map(async (member) => {
      if (member.user.bot) return;
      try {
        await member.send(message);
      } catch {
        failed.push(`<@${member.id}>`);
      }
    });

    await Promise.all(promises);
    if (failed.length > 0) {
      interaction.user.send(`Could not DM:\n${failed.join(', ')}`);
    }
  }
});

client.login(process.env.TOKEN);