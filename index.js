import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  Events,
  Routes,
  REST,
  SlashCommandBuilder
} from 'discord.js';

import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} from '@discordjs/voice';

import express from 'express';
import play from 'play-dl';
import 'dotenv/config';

const app = express();

app.get('/', (_, res) => res.send('Bot is alive!'));

app.listen(process.env.PORT || 3000, () => {
  console.log('Express server running');
});

// =========================
// CONFIG
// =========================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction
  ]
});

const TOKEN = process.env.TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const CLIENT_ID = process.env.CLIENT_ID;

const VC_CHANNEL_ID = '1368359914145058956';

const PREFIX = '!';

const dmRoleCache = new Set();
const musicQueues = new Map();

// =========================
// AUTO JOIN VC
// =========================

async function connectToVC() {
  try {
    const guild = await client.guilds.fetch(GUILD_ID);

    const channel = await guild.channels.fetch(VC_CHANNEL_ID);

    if (!channel?.isVoiceBased()) {
      console.log('VC channel not found or is not a voice channel.');
      return;
    }

    const connection = joinVoiceChannel({
      channelId: VC_CHANNEL_ID,
      guildId: guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfMute: true
    });

    connection.on(
      VoiceConnectionStatus.Disconnected,
      () => {
        setTimeout(() => {
          connectToVC().catch(console.error);
        }, 5000);
      }
    );

    console.log('Connected to voice channel.');
  } catch (error) {
    console.error('VC connection error:', error);
  }
}

// =========================
// READY
// =========================

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await connectToVC();
});

// =========================
// DM ROLE
// =========================

async function handleDmRole(members, content, replyFn) {
  const failed = [];

  for (const member of members.values()) {
    if (member.user.bot || dmRoleCache.has(member.id)) continue;

    try {
      await member.send(content);
      dmRoleCache.add(member.id);
    } catch {
      failed.push(`<@${member.id}>`);
    }
  }

  if (failed.length) {
    await replyFn(
      `❌ Failed to DM:\n${failed.join('\n')}`
    );
  }
}

// =========================
// SLASH COMMANDS
// =========================

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    if (!CLIENT_ID) {
      console.log('CLIENT_ID is missing. Slash commands were not registered.');
      return;
    }

    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      {
        body: [
          new SlashCommandBuilder()
            .setName('dmrole')
            .setDescription('DM all users in a role')
            .addRoleOption(option =>
              option
                .setName('role')
                .setDescription('Role')
                .setRequired(true)
            )
            .addStringOption(option =>
              option
                .setName('message')
                .setDescription('Message')
                .setRequired(true)
            )
            .toJSON()
        ]
      }
    );

    console.log('Slash commands registered.');
  } catch (error) {
    console.error('Slash command registration error:', error);
  }
})();

client.on(Events.InteractionCreate, async interaction => {
  if (
    !interaction.isChatInputCommand() ||
    interaction.commandName !== 'dmrole'
  ) {
    return;
  }

  if (
    !interaction.member.permissions.has(
      PermissionsBitField.Flags.Administrator
    )
  ) {
    return interaction.reply({
      content: 'No permission',
      ephemeral: true
    });
  }

  const role = interaction.options.getRole('role');
  const content = interaction.options.getString('message');

  await interaction.reply({
    content: `DMing ${role.members.size} users...`,
    ephemeral: true
  });

  await handleDmRole(
    role.members,
    content,
    msg => interaction.user.send(msg)
  );
});

// =========================
// JOIN VC
// =========================

client.on(Events.MessageCreate, async message => {
  if (
    message.author.bot ||
    message.content !== `${PREFIX}joinvc`
  ) {
    return;
  }

  await connectToVC();

  await message.reply(
    'Joined VC and will stay connected.'
  );
});

// =========================
// HOST FRIENDLY
// =========================

client.on(Events.MessageCreate, async message => {
  if (
    message.author.bot ||
    !message.guild ||
    !message.content
      .toLowerCase()
      .startsWith(`${PREFIX}hostfriendly`)
  ) {
    return;
  }

  const allowedRoles = [
    'Admin',
    'Friendlies Department'
  ];

  if (
    !message.member.roles.cache.some(
      role => allowedRoles.includes(role.name)
    )
  ) {
    return message.reply('No permission to host.');
  }

  const args = message.content
    .trim()
    .split(/\s+/)
    .slice(1);

  const hostPos = args[0]?.toUpperCase();

  const positions = [
    { emoji: '1️⃣', name: 'GK' },
    { emoji: '2️⃣', name: 'CB' },
    { emoji: '3️⃣', name: 'CB2' },
    { emoji: '4️⃣', name: 'CM' },
    { emoji: '5️⃣', name: 'LW' },
    { emoji: '6️⃣', name: 'RW' },
    { emoji: '7️⃣', name: 'ST' }
  ];

  let collecting = true;

  const claimed = {};
  const users = new Set();

  // =========================
  // PRE-CLAIM HOST POSITION
  // =========================

  if (hostPos) {
    const index = positions.findIndex(
      position => position.name === hostPos
    );

    if (index !== -1) {
      claimed[positions[index].emoji] =
        message.author.id;

      users.add(message.author.id);
    }
  }

  // =========================
  // LINEUP DISPLAY
  // =========================

  const lines = () =>
    positions
      .map(position =>
        `${position.emoji} → ${position.name}: ${
          claimed[position.emoji]
            ? `<@${claimed[position.emoji]}>`
            : '---'
        }`
      )
      .join('\n');

  const announce = await message.channel.send(
    `**ERTS UNITED 7v7 FRIENDLY**\n\n${lines()}\n\n@here`
  );

  // Add reactions only to open positions
  for (const position of positions) {
    if (!claimed[position.emoji]) {
      await announce.react(position.emoji).catch(() => {});
    }
  }

  // =========================
  // 1-MINUTE REMINDER
  // =========================

  setTimeout(() => {
    if (
      Object.keys(claimed).length < 7 &&
      collecting
    ) {
      message.channel.send(
        '@here More reacts needed for the lineup!'
      ).catch(() => {});
    }
  }, 60000);

  // =========================
  // REACTION COLLECTOR
  // =========================

  const collector =
    announce.createReactionCollector({
      time: 600000
    });

  collector.on(
    'collect',
    async (reaction, user) => {
      if (user.bot) {
        return reaction.users
          .remove(user.id)
          .catch(() => {});
      }

      if (users.has(user.id)) {
        return reaction.users
          .remove(user.id)
          .catch(() => {});
      }

      const position = positions.find(
        p => p.emoji === reaction.emoji.name
      );

      if (!position || claimed[position.emoji]) {
        return reaction.users
          .remove(user.id)
          .catch(() => {});
      }

      // Small delay before confirming selection
      setTimeout(async () => {
        if (
          users.has(user.id) ||
          claimed[position.emoji]
        ) {
          return;
        }

        claimed[position.emoji] = user.id;
        users.add(user.id);

        // Remove the user's reaction so the board stays clean
        await reaction.users
          .remove(user.id)
          .catch(() => {});

        // Update the lineup board.
        // NO individual "position confirmed" message.
        await announce.edit(
          `**ERTS UNITED 7v7 FRIENDLY**\n\n${lines()}\n\n@here`
        );

        if (
          Object.keys(claimed).length ===
          positions.length
        ) {
          collector.stop('filled');
        }
      }, 3000);
    }
  );

  // =========================
  // COLLECTOR END
  // =========================

  collector.on(
    'end',
    async (_, reason) => {
      collecting = false;

      if (reason !== 'filled') {
        return message.channel.send(
          '❌ Friendly cancelled.'
        );
      }

      // =========================
      // FINAL LINEUP
      // ONE MESSAGE ONLY
      // =========================

      const finalLineup = positions
        .map(
          position =>
            `${position.name}: <@${claimed[position.emoji]}>`
        )
        .join('\n');

      await message.channel.send(
        `**FINAL LINEUP**\n${finalLineup}`
      );

      // =========================
      // DM LINK
      // =========================

      message.channel
        .createMessageCollector({
          filter: m =>
            m.author.id === message.author.id &&
            /https?:\/\//.test(m.content),
          max: 1,
          time: 300000
        })
        .on('collect', m => {
          for (const userId of Object.values(claimed)) {
            client.users
              .send(
                userId,
                `Here’s the friendly, join up: https://discord.gg/ZrNuUKJFfS`
              )
              .catch(() => {});
          }
        });
    }
  );
});

// =========================
// MUSIC COMMANDS
// !play
// !skip
// !stop
// !loop
// !queue
// =========================

client.on(Events.MessageCreate, async message => {
  if (
    message.author.bot ||
    !message.content.startsWith(`${PREFIX}play`)
  ) {
    return;
  }

  const url = message.content.split(' ')[1];

  if (!url) {
    return message.reply(
      'Provide a YouTube URL.'
    );
  }

  const voiceChannel =
    message.member.voice.channel;

  if (!voiceChannel) {
    return message.reply(
      'Join a VC first.'
    );
  }

  const perms =
    voiceChannel.permissionsFor(
      message.client.user
    );

  if (
    !perms.has('Connect') ||
    !perms.has('Speak')
  ) {
    return message.reply(
      'Missing VC permissions.'
    );
  }

  let serverQueue =
    musicQueues.get(message.guild.id);

  if (!serverQueue) {
    serverQueue = {
      connection: null,
      player: createAudioPlayer(),
      songs: [],
      loop: false,
      textChannel: message.channel
    };

    musicQueues.set(
      message.guild.id,
      serverQueue
    );

    const connection =
      joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: message.guild.id,
        adapterCreator:
          message.guild.voiceAdapterCreator
      });

    serverQueue.connection =
      connection;

    connection.subscribe(
      serverQueue.player
    );
  }

  serverQueue.songs.push(url);

  await message.channel.send(
    '+ Added to queue.'
  );

  if (
    serverQueue.player.state.status ===
    AudioPlayerStatus.Idle
  ) {
    playSong(message.guild.id);
  }
});

// =========================
// PLAY SONG
// =========================

async function playSong(guildId) {
  const queue =
    musicQueues.get(guildId);

  if (
    !queue ||
    queue.songs.length === 0
  ) {
    if (queue?.connection) {
      queue.connection.destroy();
    }

    musicQueues.delete(guildId);
    return;
  }

  const url = queue.songs[0];

  try {
    const stream =
      await play.stream(url);

    const resource =
      createAudioResource(
        stream.stream,
        {
          inputType: stream.type
        }
      );

    queue.player.play(resource);

    await queue.textChannel.send(
      `▶️ Now playing: ${url}`
    );

    queue.player.once(
      AudioPlayerStatus.Idle,
      () => {
        if (!queue.loop) {
          queue.songs.shift();
        }

        playSong(guildId);
      }
    );
  } catch (error) {
    console.error(
      'Music error:',
      error
    );

    queue.songs.shift();

    playSong(guildId);
  }
}

// =========================
// OTHER MUSIC COMMANDS
// =========================

client.on(
  Events.MessageCreate,
  message => {
    if (message.author.bot) return;

    // !skip
    if (
      message.content ===
      `${PREFIX}skip`
    ) {
      const queue =
        musicQueues.get(
          message.guild.id
        );

      if (queue) {
        queue.player.stop();
      }

      return;
    }

    // !stop
    if (
      message.content ===
      `${PREFIX}stop`
    ) {
      const queue =
        musicQueues.get(
          message.guild.id
        );

      if (queue) {
        queue.songs = [];

        queue.player.stop();

        if (queue.connection) {
          queue.connection.destroy();
        }

        musicQueues.delete(
          message.guild.id
        );
      }

      return;
    }

    // !loop
    if (
      message.content ===
      `${PREFIX}loop`
    ) {
      const queue =
        musicQueues.get(
          message.guild.id
        );

      if (queue) {
        queue.loop = !queue.loop;

        message.channel.send(
          `Loop is now ${
            queue.loop
              ? 'on'
              : 'off'
          }.`
        );
      }

      return;
    }

    // !queue
    if (
      message.content ===
      `${PREFIX}queue`
    ) {
      const queue =
        musicQueues.get(
          message.guild.id
        );

      if (
        queue &&
        queue.songs.length
      ) {
        message.channel.send(
          queue.songs
            .map(
              (url, index) =>
                `${index + 1}. ${url}`
            )
            .join('\n')
        );
      } else {
        message.channel.send(
          'Queue is empty.'
        );
      }
    }
  }
);

// =========================
// LOGIN
// =========================

client.login(TOKEN);