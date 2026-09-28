import {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  EmbedBuilder,
  Events,
  REST,
  Routes,
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
import OpenAI from 'openai';
import 'dotenv/config';

// =========================
// EXPRESS KEEPALIVE
// =========================

const app = express();

app.get('/', (_, res) => {
  res.send('erts United Bot is alive!');
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Web server running');
});

// =========================
// CLIENT
// =========================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [
    Partials.Channel,
    Partials.Message
  ]
});

// =========================
// CONFIG
// =========================

const TOKEN = process.env.TOKEN;

const GUILD_ID =
  process.env.GUILD_ID ||
  '1540116399558313995';

const HOST_ROLE_ID =
  process.env.HOST_ROLE_ID ||
  '1541193960041615361';

const RESULTS_CHANNEL_ID =
  process.env.RESULTS_CHANNEL_ID ||
  '1540136949908770827';

const VC_CHANNEL_ID =
  process.env.VC_CHANNEL_ID ||
  '1368359914145058956';

const AI_MODEL =
  process.env.AI_MODEL ||
  'gpt-5.5';

// =========================
// DATA
// =========================

const dmRoleCache = new Set();
const musicQueues = new Map();
const activeFriendlies = new Map();
const completedFriendlies = new Map();

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    })
  : null;

// =========================
// FRIENDLY POSITIONS
// =========================

const positions = [
  { emoji: '1️⃣', name: 'GK' },
  { emoji: '2️⃣', name: 'CB' },
  { emoji: '3️⃣', name: 'CB2' },
  { emoji: '4️⃣', name: 'CM' },
  { emoji: '5️⃣', name: 'LW' },
  { emoji: '6️⃣', name: 'RW' },
  { emoji: '7️⃣', name: 'ST' }
];

// =========================
// PERMISSIONS
// =========================

function isGuildCommand(interaction) {
  return (
    interaction.inGuild() &&
    interaction.guildId === GUILD_ID
  );
}

function hasHostRole(interaction) {
  return (
    interaction.member?.roles?.cache?.has(HOST_ROLE_ID) ??
    false
  );
}

function hasAdmin(interaction) {
  return (
    interaction.member?.permissions?.has(
      PermissionsBitField.Flags.Administrator
    ) ?? false
  );
}

// =========================
// FRIENDLY HELPERS
// =========================

function lineupText(claimed) {
  return positions
    .map(position => {
      return `${position.name}: ${
        claimed[position.name]
          ? `<@${claimed[position.name]}>`
          : '---'
      }`;
    })
    .join('\n');
}

function finalLineupText(claimed) {
  return positions
    .map(position => {
      return `${position.name}: <@${claimed[position.name]}>`;
    })
    .join('\n');
}

// =========================
// SLASH COMMANDS
// =========================

function buildCommands() {
  return [

    // /help
    new SlashCommandBuilder()
      .setName('help')
      .setDescription('Show erts United Bot commands'),

    // /dmrole
    new SlashCommandBuilder()
      .setName('dmrole')
      .setDescription('DM all non-bot members of a role')
      .addRoleOption(option =>
        option
          .setName('role')
          .setDescription('Role to DM')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('message')
          .setDescription('Message to send')
          .setRequired(true)
      ),

    // /joinvc
    new SlashCommandBuilder()
      .setName('joinvc')
      .setDescription('Make the bot join the fixed VC'),

    // /hostfriendly
    new SlashCommandBuilder()
      .setName('hostfriendly')
      .setDescription('Host a 7v7 friendly')
      .addStringOption(option =>
        option
          .setName('position')
          .setDescription('Your position')
          .setRequired(false)
          .addChoices(
            ...positions.map(position => ({
              name: position.name,
              value: position.name
            }))
          )
      ),

    // /friendlylink
    new SlashCommandBuilder()
      .setName('friendlylink')
      .setDescription('DM the friendly link to the final lineup')
      .addStringOption(option =>
        option
          .setName('link')
          .setDescription('Discord invite or friendly link')
          .setRequired(true)
      ),

    // /endfriendly
    new SlashCommandBuilder()
      .setName('endfriendly')
      .setDescription('End the friendly and clear this channel'),

    // /result
    new SlashCommandBuilder()
      .setName('result')
      .setDescription('Post a friendly result')
      .addStringOption(option =>
        option
          .setName('outcome')
          .setDescription('Win or loss')
          .setRequired(true)
          .addChoices(
            {
              name: 'Win',
              value: 'win'
            },
            {
              name: 'Loss',
              value: 'loss'
            }
          )
      )
      .addStringOption(option =>
        option
          .setName('score')
          .setDescription('Final score, e.g. 7-3')
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName('team')
          .setDescription('Opponent/team name')
          .setRequired(false)
      ),

    // /play
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a YouTube URL')
      .addStringOption(option =>
        option
          .setName('url')
          .setDescription('YouTube URL')
          .setRequired(true)
      ),

    // /skip
    new SlashCommandBuilder()
      .setName('skip')
      .setDescription('Skip the current song'),

    // /stop
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop music and clear queue'),

    // /loop
    new SlashCommandBuilder()
      .setName('loop')
      .setDescription('Toggle music loop'),

    // /queue
    new SlashCommandBuilder()
      .setName('queue')
      .setDescription('Show the music queue')

  ].map(command => command.toJSON());
}

// =========================
// REGISTER COMMANDS
// =========================

async function registerCommands() {
  const rest = new REST({
    version: '10'
  }).setToken(TOKEN);

  const commands = buildCommands();

  console.log(
    `Registering ${commands.length} slash commands...`
  );

  await rest.put(
    Routes.applicationGuildCommands(
      client.user.id,
      GUILD_ID
    ),
    {
      body: commands
    }
  );

  console.log('Slash commands registered successfully.');
}

// =========================
// AUTO JOIN VC
// =========================

async function connectToVC() {
  try {
    const guild =
      await client.guilds.fetch(GUILD_ID);

    const channel =
      await guild.channels.fetch(VC_CHANNEL_ID);

    if (!channel || !channel.isVoiceBased()) {
      console.log(
        'Fixed VC channel not found or is not voice based.'
      );

      return null;
    }

    const connection =
      joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator:
          guild.voiceAdapterCreator,
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

    return connection;

  } catch (error) {
    console.error(
      'VC connection error:',
      error
    );

    return null;
  }
}

// =========================
// DM ROLE
// =========================

async function handleDmRole(role, content) {
  let sent = 0;
  let failed = 0;

  for (const member of role.members.values()) {

    if (
      member.user.bot ||
      dmRoleCache.has(member.id)
    ) {
      continue;
    }

    try {
      await member.send(content);

      dmRoleCache.add(member.id);

      sent++;

    } catch {
      failed++;
    }
  }

  return {
    sent,
    failed
  };
}

// =========================
// PURGE CHANNEL
// =========================

async function purgeAllMessages(channel) {
  if (
    !channel ||
    !channel.isTextBased() ||
    !channel.messages?.fetch
  ) {
    return 0;
  }

  let deleted = 0;
  let safety = 0;

  while (safety++ < 1000) {

    const messages =
      await channel.messages.fetch({
        limit: 100
      });

    if (!messages.size) {
      break;
    }

    const recent =
      messages.filter(
        message =>
          Date.now() -
            message.createdTimestamp <
          14 * 24 * 60 * 60 * 1000
      );

    const old =
      messages.filter(
        message =>
          Date.now() -
            message.createdTimestamp >=
          14 * 24 * 60 * 60 * 1000
      );

    if (recent.size) {
      try {

        const removed =
          await channel.bulkDelete(
            recent,
            true
          );

        deleted += removed.size;

      } catch (error) {

        console.error(
          'Bulk delete error:',
          error
        );

        for (
          const message of recent.values()
        ) {

          try {
            await message.delete();
            deleted++;
          } catch {}
        }
      }
    }

    for (
      const message of old.values()
    ) {

      try {
        await message.delete();
        deleted++;
      } catch {}
    }
  }

  return deleted;
}

// =========================
// MUSIC
// =========================

async function playSong(guildId) {
  const queue =
    musicQueues.get(guildId);

  if (!queue) {
    return;
  }

  if (queue.songs.length === 0) {

    try {
      queue.connection?.destroy();
    } catch {}

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

    await queue.textChannel
      .send(`▶️ Now playing: ${url}`)
      .catch(() => {});

    queue.player.once(
      AudioPlayerStatus.Idle,
      () => {

        if (!musicQueues.has(guildId)) {
          return;
        }

        if (!queue.loop) {
          queue.songs.shift();
        }

        playSong(guildId)
          .catch(console.error);
      }
    );

  } catch (error) {

    console.error(
      'Music error:',
      error
    );

    queue.songs.shift();

    await queue.textChannel
      .send('⚠️ Could not play that URL.')
      .catch(() => {});

    playSong(guildId)
      .catch(console.error);
  }
}

// =========================
// HELP
// =========================

async function replyHelp(interaction) {

  const embed =
    new EmbedBuilder()
      .setTitle('erts United Bot')
      .setDescription(
        [
          '`/hostfriendly` • Host a friendly',
          '`/friendlylink` • DM the lineup a link',
          '`/endfriendly` • End/clear friendly',
          '`/result` • Post a match result',
          '`/dmrole` • DM a role',
          '`/joinvc` • Join the fixed VC',
          '`/play` • Play music',
          '`/skip` • Skip music',
          '`/stop` • Stop music',
          '`/loop` • Toggle loop',
          '`/queue` • View queue'
        ].join('\n')
      );

  return interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

// =========================
// READY
// =========================

client.once(
  Events.ClientReady,
  async readyClient => {

    console.log(
      `Logged in as ${readyClient.user.tag}`
    );

    try {

      await registerCommands();

    } catch (error) {

      console.error(
        'Slash command registration failed:',
        error
      );
    }

    await connectToVC();
  }
);

// =========================
// AI BOT MENTION
// =========================

client.on(
  Events.MessageCreate,
  async message => {

    if (
      message.author.bot ||
      !message.guild ||
      !openai
    ) {
      return;
    }

    if (
      !message.mentions.users.has(
        client.user.id
      )
    ) {
      return;
    }

    // Do not respond to @everyone/@here
    if (
      message.mentions.everyone
    ) {
      return;
    }

    // Only respond when the bot is directly mentioned
    if (
      message.mentions.users.size !== 1
    ) {
      return;
    }

    const prompt =
      message.content
        .replace(
          new RegExp(
            `<@!?${client.user.id}>`,
            'g'
          ),
          ''
        )
        .trim();

    if (!prompt) {
      return message.reply(
        'What do you need?'
      );
    }

    try {

      await message.channel.sendTyping();

      const response =
        await openai.responses.create({
          model: AI_MODEL,

          instructions:
            'You are the erts United Discord Bot. Answer clearly, briefly, and helpfully. Keep a casual Discord-friendly tone. Do not claim to be a human.',

          input: prompt
        });

      const output =
        response.output_text?.trim() ||
        'I could not generate a response.';

      await message.reply(
        output.slice(0, 2000)
      );

    } catch (error) {

      console.error(
        'OpenAI error:',
        error
      );

      await message.reply(
        '⚠️ I had trouble generating a response right now.'
      );
    }
  }
);

// =========================
// SLASH INTERACTIONS
// =========================

client.on(
  Events.InteractionCreate,
  async interaction => {

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (!isGuildCommand(interaction)) {

      return interaction.reply({
        content:
          'This bot is configured for the erts United server.',
        ephemeral: true
      });
    }

    try {

      // =====================
      // /HELP
      // =====================

      if (
        interaction.commandName === 'help'
      ) {
        return replyHelp(interaction);
      }

      // =====================
      // /DMROLE
      // =====================

      if (
        interaction.commandName === 'dmrole'
      ) {

        if (!hasAdmin(interaction)) {

          return interaction.reply({
            content:
              '❌ Administrator permission required.',
            ephemeral: true
          });
        }

        const role =
          interaction.options.getRole(
            'role',
            true
          );

        const content =
          interaction.options.getString(
            'message',
            true
          );

        const guildRole =
          await interaction.guild.roles.fetch(
            role.id
          );

        if (!guildRole) {

          return interaction.reply({
            content:
              '❌ That role could not be found.',
            ephemeral: true
          });
        }

        await interaction.deferReply({
          ephemeral: true
        });

        const result =
          await handleDmRole(
            guildRole,
            content
          );

        return interaction.editReply(
          `✅ DMs sent: ${result.sent}\n❌ Failed: ${result.failed}`
        );
      }

      // =====================
      // /JOINVC
      // =====================

      if (
        interaction.commandName === 'joinvc'
      ) {

        const connection =
          await connectToVC();

        return interaction.reply({
          content:
            connection
              ? '✅ Joined the fixed VC.'
              : '❌ I could not join the fixed VC. Check the VC ID and permissions.',
          ephemeral: true
        });
      }

      // =====================
      // /HOSTFRIENDLY
      // =====================

      if (
        interaction.commandName ===
        'hostfriendly'
      ) {

        if (!hasHostRole(interaction)) {

          return interaction.reply({
            content:
              '❌ You need the Friendly Hoster role.',
            ephemeral: true
          });
        }

        if (
          activeFriendlies.has(
            interaction.channelId
          )
        ) {

          return interaction.reply({
            content:
              '❌ There is already an active friendly in this channel.',
            ephemeral: true
          });
        }

        const hostPos =
          interaction.options
            .getString('position')
            ?.toUpperCase();

        const claimed = {};
        const users = new Set();

        if (hostPos) {

          claimed[hostPos] =
            interaction.user.id;

          users.add(
            interaction.user.id
          );
        }

        await interaction.reply({

          content:
            `**ERTS UNITED 7v7 FRIENDLY**\n${lineupText(claimed)}\n@here`,

          allowedMentions: {
            parse: ['everyone']
          }
        });

        const announce =
          await interaction.fetchReply();

        // Add reactions
        for (
          const position of positions
        ) {

          if (
            !claimed[position.name]
          ) {

            await announce
              .react(position.emoji)
              .catch(() => {});
          }
        }

        const state = {
          announce,
          claimed,
          users,
          collecting: true,
          collector: null
        };

        activeFriendlies.set(
          interaction.channelId,
          state
        );

        const updateBoard =
          async () => {

            const full =
              Object.keys(claimed)
                .length ===
              positions.length;

            const text = full
              ? `**FINAL LINEUP**\n${finalLineupText(claimed)}`
              : `**ERTS UNITED 7v7 FRIENDLY**\n${lineupText(claimed)}\nReact to claim a position.`;

            await announce
              .edit({
                content: text,
                allowedMentions: {
                  parse: []
                }
              })
              .catch(() => {});
          };

        const collector =
          announce.createReactionCollector({
            time: 10 * 60 * 1000
          });

        state.collector = collector;

        collector.on(
          'collect',
          async (reaction, user) => {

            if (
              !state.collecting ||
              user.bot
            ) {
              return;
            }

            const position =
              positions.find(
                p =>
                  p.emoji ===
                  reaction.emoji.name
              );

            if (
              !position ||
              claimed[position.name] ||
              users.has(user.id)
            ) {

              await reaction.users
                .remove(user.id)
                .catch(() => {});

              return;
            }

            claimed[position.name] =
              user.id;

            users.add(user.id);

            await reaction.users
              .remove(user.id)
              .catch(() => {});

            await updateBoard();

            const full =
              Object.keys(claimed)
                .length ===
              positions.length;

            if (full) {
              collector.stop('filled');
            }
          }
        );

        collector.on(
          'end',
          async (_, reason) => {

            state.collecting = false;

            activeFriendlies.delete(
              interaction.channelId
            );

            if (reason === 'filled') {

              completedFriendlies.set(
                interaction.channelId,
                {
                  claimed: {
                    ...claimed
                  },
                  hostId:
                    interaction.user.id
                }
              );

              await announce
                .edit({
                  content:
                    `**FINAL LINEUP**\n${finalLineupText(claimed)}`,

                  allowedMentions: {
                    parse: []
                  }
                })
                .catch(() => {});

              return;
            }

            await announce
              .edit({
                content:
                  '❌ Friendly cancelled or timed out.',

                allowedMentions: {
                  parse: []
                }
              })
              .catch(() => {});
          }
        );

        return;
      }

      // =====================
      // /FRIENDLYLINK
      // =====================

      if (
        interaction.commandName ===
        'friendlylink'
      ) {

        if (!hasHostRole(interaction)) {

          return interaction.reply({
            content:
              '❌ You need the Friendly Hoster role.',
            ephemeral: true
          });
        }

        const link =
          interaction.options.getString(
            'link',
            true
          );

        const state =
          completedFriendlies.get(
            interaction.channelId
          );

        if (
          !state ||
          !state.claimed ||
          Object.keys(state.claimed)
            .length !== positions.length
        ) {

          return interaction.reply({
            content:
              '❌ There is no completed friendly lineup in this channel.',
            ephemeral: true
          });
        }

        const uniqueUsers =
          [...new Set(
            Object.values(
              state.claimed
            )
          )];

        let sent = 0;

        for (
          const userId of uniqueUsers
        ) {

          try {

            const user =
              await client.users.fetch(
                userId
              );

            await user.send(
              `Here is the erts United friendly link: ${link}`
            );

            sent++;

          } catch {}
        }

        completedFriendlies.delete(
          interaction.channelId
        );

        return interaction.reply({
          content:
            `✅ Friendly link sent to ${sent}/${uniqueUsers.length} players.`,
          ephemeral: true
        });
      }

      // =====================
      // /ENDFRIENDLY
      // =====================

      if (
        interaction.commandName ===
        'endfriendly'
      ) {

        if (!hasHostRole(interaction)) {

          return interaction.reply({
            content:
              '❌ You need the Friendly Hoster role.',
            ephemeral: true
          });
        }

        const active =
          activeFriendlies.get(
            interaction.channelId
          );

        if (active?.collector) {
          active.collector.stop(
            'ended'
          );
        }

        activeFriendlies.delete(
          interaction.channelId
        );

        completedFriendlies.delete(
          interaction.channelId
        );

        await interaction.deferReply({
          ephemeral: true
        });

        const deleted =
          await purgeAllMessages(
            interaction.channel
          );

        return interaction.editReply(
          `✅ Friendly ended. Cleared ${deleted} messages.`
        );
      }

      // =====================
      // /RESULT
      // =====================

      if (
        interaction.commandName ===
        'result'
      ) {

        if (!hasHostRole(interaction)) {

          return interaction.reply({
            content:
              '❌ You need the Friendly Hoster role.',
            ephemeral: true
          });
        }

        const outcome =
          interaction.options.getString(
            'outcome',
            true
          );

        const score =
          interaction.options.getString(
            'score',
            true
          );

        const team =
          interaction.options.getString(
            'team'
          ) || 'Random Team';

        const resultsChannel =
          await interaction.guild.channels.fetch(
            RESULTS_CHANNEL_ID
          );

        if (
          !resultsChannel?.isTextBased()
        ) {

          return interaction.reply({
            content:
              '❌ Results channel was not found.',
            ephemeral: true
          });
        }

        const embed =
          new EmbedBuilder()
            .setTitle(
              '⚽ FRIENDLY RESULT'
            )
            .addFields(
              {
                name: 'Result',
                value:
                  outcome === 'win'
                    ? 'WIN'
                    : 'LOSS',
                inline: true
              },
              {
                name: 'Score',
                value: score,
                inline: true
              },
              {
                name: 'Team',
                value: team,
                inline: true
              },
              {
                name: 'Posted by',
                value:
                  `<@${interaction.user.id}>`,
                inline: false
              }
            )
            .setTimestamp();

        await resultsChannel.send({
          embeds: [embed]
        });

        return interaction.reply({
          content:
            `✅ Result posted in <#${RESULTS_CHANNEL_ID}>.`,
          ephemeral: true
        });
      }

      // =====================
      // /PLAY
      // =====================

      if (
        interaction.commandName ===
        'play'
      ) {

        const url =
          interaction.options.getString(
            'url',
            true
          );

        const voiceChannel =
          interaction.member.voice?.channel;

        if (!voiceChannel) {

          return interaction.reply({
            content:
              '❌ Join a VC first.',
            ephemeral: true
          });
        }

        const perms =
          voiceChannel.permissionsFor(
            client.user
          );

        if (
          !perms?.has(
            PermissionsBitField.Flags.Connect
          ) ||
          !perms?.has(
            PermissionsBitField.Flags.Speak
          )
        ) {

          return interaction.reply({
            content:
              '❌ I need Connect and Speak permissions in that VC.',
            ephemeral: true
          });
        }

        let queue =
          musicQueues.get(
            interaction.guildId
          );

        if (!queue) {

          queue = {
            connection: null,
            player:
              createAudioPlayer(),
            songs: [],
            loop: false,
            textChannel:
              interaction.channel
          };

          musicQueues.set(
            interaction.guildId,
            queue
          );

          const connection =
            joinVoiceChannel({
              channelId:
                voiceChannel.id,
              guildId:
                interaction.guildId,
              adapterCreator:
                interaction.guild
                  .voiceAdapterCreator
            });

          queue.connection =
            connection;

          connection.subscribe(
            queue.player
          );
        }

        queue.songs.push(url);

        await interaction.reply(
          '✅ Added to queue.'
        );

        if (
          queue.player.state.status ===
          AudioPlayerStatus.Idle
        ) {

          await playSong(
            interaction.guildId
          );
        }

        return;
      }

      // =====================
      // /SKIP
      // =====================

      if (
        interaction.commandName ===
        'skip'
      ) {

        const queue =
          musicQueues.get(
            interaction.guildId
          );

        if (!queue) {

          return interaction.reply({
            content:
              '❌ Nothing is playing.',
            ephemeral: true
          });
        }

        queue.player.stop();

        return interaction.reply(
          '⏭️ Skipped.'
        );
      }

      // =====================
      // /STOP
      // =====================

      if (
        interaction.commandName ===
        'stop'
      ) {

        const queue =
          musicQueues.get(
            interaction.guildId
          );

        if (!queue) {

          return interaction.reply({
            content:
              '❌ Music is not active.',
            ephemeral: true
          });
        }

        queue.songs = [];

        queue.player.stop();

        try {
          queue.connection?.destroy();
        } catch {}

        musicQueues.delete(
          interaction.guildId
        );

        return interaction.reply(
          '⏹️ Music stopped and queue cleared.'
        );
      }

      // =====================
      // /LOOP
      // =====================

      if (
        interaction.commandName ===
        'loop'
      ) {

        const queue =
          musicQueues.get(
            interaction.guildId
          );

        if (!queue) {

          return interaction.reply({
            content:
              '❌ Nothing is playing.',
            ephemeral: true
          });
        }

        queue.loop =
          !queue.loop;

        return interaction.reply(
          `🔁 Loop is now **${queue.loop ? 'on' : 'off'}**.`
        );
      }

      // =====================
      // /QUEUE
      // =====================

      if (
        interaction.commandName ===
        'queue'
      ) {

        const queue =
          musicQueues.get(
            interaction.guildId
          );

        if (
          !queue ||
          !queue.songs.length
        ) {

          return interaction.reply(
            'Queue is empty.'
          );
        }

        const text =
          queue.songs
            .map(
              (url, index) =>
                `${index + 1}. ${url}`
            )
            .join('\n');

        return interaction.reply(
          text.slice(0, 2000)
        );
      }

    } catch (error) {

      console.error(
        `/${interaction.commandName} error:`,
        error
      );

      const content =
        '❌ Something went wrong while running that command.';

      if (
        interaction.replied ||
        interaction.deferred
      ) {

        return interaction
          .editReply({
            content
          })
          .catch(() => {});
      }

      return interaction
        .reply({
          content,
          ephemeral: true
        })
        .catch(() => {});
    }
  }
);

// =========================
// ERROR HANDLERS
// =========================

process.on(
  'unhandledRejection',
  error => {
    console.error(
      'Unhandled rejection:',
      error
    );
  }
);

process.on(
  'uncaughtException',
  error => {
    console.error(
      'Uncaught exception:',
      error
    );
  }
);

// =========================
// LOGIN
// =========================

if (!TOKEN) {

  console.error(
    'TOKEN is missing from Render Environment Variables.'
  );

  process.exit(1);
}

client.login(TOKEN);