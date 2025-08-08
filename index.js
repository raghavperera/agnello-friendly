import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  Routes,
  REST
} from 'discord.js';
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import express from 'express';
import ytdl from 'ytdl-core';
import 'dotenv/config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel]
});

// Keep alive
const app = express();
app.get('/', (_, res) => res.send('Bot is alive!'));
app.listen(3000, () => console.log('Express server ready'));

// VC JOIN + RECONNECT
const VC_CHANNEL_ID = '1368359914145058956';
let voiceConnection;
async function connectToVC() {
  try {
    const channel = await client.channels.fetch(VC_CHANNEL_ID);
    if (channel && channel.isVoiceBased()) {
      voiceConnection = joinVoiceChannel({
        channelId: VC_CHANNEL_ID,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true
      });

      voiceConnection.on(VoiceConnectionStatus.Disconnected, () => {
        setTimeout(connectToVC, 5000); // Retry after 5s
      });
    }
  } catch (err) {
    console.error('VC connect error:', err);
  }
}

// Cache to avoid duplicate DMs
const dmCache = new Set();

// DM ROLE COMMAND (prefix and slash)
async function dmRoleMembers(role, messageContent, issuer) {
  const members = role.members;
  const failed = [];

  for (const member of members.values()) {
    if (dmCache.has(member.id)) continue;
    try {
      await member.send(messageContent);
      dmCache.add(member.id);
    } catch {
      failed.push(member.user.tag);
    }
  }

  if (failed.length > 0) {
    try {
      await issuer.send(`❌ Failed to DM these users:\n${failed.join('\n')}`);
    } catch (err) {
      console.error('Could not DM issuer about failures:', err);
    }
  }
}

// SLASH COMMAND SETUP
client.on('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  connectToVC();

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id), {
    body: [{
      name: 'dmrole',
      description: 'DMs everyone in a role',
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
    }]
  });
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'dmrole') {
    const role = interaction.options.getRole('role');
    const message = interaction.options.getString('message');

    await interaction.reply('Dming role...');
    await dmRoleMembers(role, message, interaction.user);
    await interaction.editReply('✅ Done.');
  }
});

// PREFIX COMMANDS
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/ +/);
  const command = args.shift()?.toLowerCase();

  if (command === 'dmrole') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

    const roleMention = message.mentions.roles.first();
    const content = args.slice(1).join(' ');
    if (!roleMention || !content) return message.reply('Usage: `!dmrole @role message`');

    message.reply('Dming role...');
    await dmRoleMembers(roleMention, content, message.author);
    message.reply('✅ Done.');
  }

  if (command === 'joinvc') {
    await connectToVC();
    message.reply('🔊 Joined VC');
  }

  // MUSIC COMMANDS
  if (command === 'play') {
    const query = args.join(' ');
    if (!query) return message.reply('Provide a YouTube URL or search term.');

    const channel = message.member.voice.channel;
    if (!channel) return message.reply('Join a voice channel first.');

    const stream = ytdl(query, { filter: 'audioonly' });
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator
    });

    const player = connection.receiver;
    channel.join();
    message.reply('🎵 Playing...');
  }

  if (command === 'skip') {
    // placeholder logic – expand with queue management
    message.reply('⏭ Skipped (not fully implemented)');
  }

  if (command === 'stop') {
    voiceConnection?.destroy();
    message.reply('🛑 Stopped music.');
  }

  if (command === 'loop') {
    message.reply('🔁 Loop mode toggled (not fully implemented)');
  }

  if (command === 'queue') {
    message.reply('📄 Queue: (not fully implemented)');
  }

  if (message.mentions.everyone || message.mentions.roles.size > 0) {
    try {
      await message.react('✅');
    } catch (err) {
      console.error('Failed to react:', err);
    }
  }
});

client.login(process.env.TOKEN);