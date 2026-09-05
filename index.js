// index.js
// erts United Friendly Bot
// Node 18+ / ESM / discord.js v14

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import ytdl from 'ytdl-core';

import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
} from 'discord.js';

import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';

// -----------------------------
// CONFIG
// -----------------------------
const TOKEN = process.env.TOKEN;
const ENABLE_VOICE = process.env.ENABLE_VOICE === 'true';
const PREFIX = process.env.PREFIX || '!';

const PORT = process.env.PORT || 10000;

const ALLOWED_GUILD_ID = '1540116395558313995';
const HOST_ROLE_ID = '1541193960041615361';

const OUTSIDE_REPLY =
  'This is NOT erts United.';

const LOG_CHANNEL_ID =
  process.env.LOG_CHANNEL_ID || '1362214241091981452';

const WELCOME_CHANNEL_ID =
  process.env.WELCOME_CHANNEL_ID || '1403929923084882012';

const FAREWELL_CHANNEL_ID =
  process.env.FAREWELL_CHANNEL_ID || '1403930222222643220';

// -----------------------------
// Lists / constants
// -----------------------------
const SWEARS = [
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'damn',
  'crap',
  'freak',
  'sucks',
  'idiot',
  'stfu',
  'wtf',
];

const COOLDOWNS = new Map();
const textWarnings = new Map();

const musicQueues = new Map();
const audioPlayers = new Map();

const lineups = new Map();
const hostfriendlyCounts = new Map();

// -----------------------------
// Small helpers
// -----------------------------
const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function safeGetLogChannel(guild) {
  if (!guild) return null;
  return guild.channels.cache.get(LOG_CHANNEL_ID) || null;
}

function cooldownReady(key, ms) {
  const now = Date.now();
  const last = COOLDOWNS.get(key) || 0;

  if (now - last < ms) return false;

  COOLDOWNS.set(key, now);
  return true;
}

function isAllowedGuild(message) {
  return message.guild && message.guild.id === ALLOWED_GUILD_ID;
}

function isPrefixedCommand(message) {
  return (
    typeof message.content === 'string' &&
    message.content.startsWith(PREFIX)
  );
}

// -----------------------------
// Lineup helper
// -----------------------------
function lineupEmbed(state) {
  const lines = state.positions
    .map(
      (pos, i) =>
        `${state.numbers[i]} ➜ **${pos}**\n${
          state.taken[i] ? `<@${state.taken[i]}>` : '_-_'
        }`
    )
    .join('\n\n');

  const final = state.positions
    .map(
      (pos, i) =>
        `${pos}: ${
          state.taken[i] ? `<@${state.taken[i]}>` : '_-_'
        }`
    )
    .join('\n');

  return new EmbedBuilder()
    .setColor(0x00a86b)
    .setTitle('ERTS UNITED 7v7 FRIENDLY')
    .setDescription(
      `${lines}\n\nReact to claim. Host can edit with \`!editlineup\` or \`!resetlineup\`.\n\n✅ **Final Lineup:**\n${final}`
    );
}

// -----------------------------
// Discord client
// -----------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages,
  ],

  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction,
  ],
});

// -----------------------------
// Ready
// -----------------------------
client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Allowed Guild: ${ALLOWED_GUILD_ID}`);
  console.log(`Friendly Hoster Role: ${HOST_ROLE_ID}`);
  console.log(
    `Voice features: ${
      ENABLE_VOICE
        ? 'ENABLED (host must support UDP)'
        : 'DISABLED'
    }`
  );
});

// -----------------------------
// Welcome
// -----------------------------
client.on('guildMemberAdd', async (member) => {
  try {
    if (member.guild.id !== ALLOWED_GUILD_ID) return;

    const welcomeChannel =
      member.guild.channels.cache.get(WELCOME_CHANNEL_ID);

    await welcomeChannel
      ?.send(`👋 Welcome to **erts United**, ${member}!`);

    await member
      .send(
        `👋 Welcome to **${member.guild.name}**!`
      )
      .catch(() => {});
  } catch {
    // Ignore errors
  }
});

// -----------------------------
// Farewell
// -----------------------------
client.on('guildMemberRemove', async (member) => {
  try {
    if (member.guild.id !== ALLOWED_GUILD_ID) return;

    const farewellChannel =
      member.guild.channels.cache.get(FAREWELL_CHANNEL_ID);

    await farewellChannel
      ?.send(
        `👋 Goodbye, **${member.user.tag}**!`
      );

    await member
      .send(
        `😢 Sorry to see you leave **${member.guild.name}**.`
      )
      .catch(() => {});
  } catch {
    // Ignore errors
  }
});

// -----------------------------
// Message handler
// -----------------------------
client.on('messageCreate', async (message) => {
  try {
    if (message.author?.bot) return;

    const commandAttempt =
      isPrefixedCommand(message);

    // -------------------------
    // Outside server protection
    // -------------------------
    if (
      commandAttempt &&
      !isAllowedGuild(message)
    ) {
      try {
        await message.reply(OUTSIDE_REPLY);
      } catch {
        try {
          await message.channel.send(OUTSIDE_REPLY);
        } catch {
          // Ignore
        }
      }

      return;
    }

    if (!isAllowedGuild(message)) return;

    // -------------------------
    // React to @everyone / @here
    // -------------------------
    if (
      message.mentions?.everyone ||
      message.content.includes('@here')
    ) {
      await message.react('✅').catch(() => {});
    }

    // -------------------------
    // Profanity filter
    // -------------------------
    if (message.content) {
      const lowered =
        message.content.toLowerCase();

      const foundSwear = SWEARS.some((word) => {
        const regex = new RegExp(
          `\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
          'i'
        );

        return regex.test(lowered);
      });

      if (foundSwear) {
        await message.delete().catch(() => {});

        const count =
          (textWarnings.get(message.author.id) || 0) + 1;

        textWarnings.set(
          message.author.id,
          count
        );

        try {
          await message.author.send(
            `⚠️ Your message in **${message.guild.name}** was removed for language:\n> ${message.content}\nThis is your **${count} warning**.`
          );
        } catch {
          // Ignore DM errors
        }

        safeGetLogChannel(message.guild)
          ?.send(
            `🧹 **Text profanity** — ${message.author.tag}\nMessage:\n\`\`\`\n${message.content}\n\`\`\`\nWarning #${count}`
          )
          .catch(() => {});

        const member = message.member;

        if (
          member &&
          member.voice?.channel &&
          member.manageable
        ) {
          try {
            await member.voice.setMute(
              true,
              'Auto-moderation: swearing'
            );

            safeGetLogChannel(message.guild)
              ?.send(
                `🔇 Auto VC mute applied to **${member.user.tag}** for 10s.`
              )
              .catch(() => {});

            setTimeout(async () => {
              try {
                if (member.voice?.channel) {
                  await member.voice.setMute(
                    false,
                    'Auto-moderation expired'
                  );
                }
              } catch {
                // Ignore
              }
            }, 10_000);
          } catch {
            // Ignore
          }
        }

        return;
      }
    }

    if (!commandAttempt) return;

    const raw = message.content
      .slice(PREFIX.length)
      .trim();

    if (!raw) return;

    const parts = raw.split(/\s+/);
    const cmd = parts.shift().toLowerCase();
    const args = parts;

    // -------------------------
    // HELP
    // -------------------------
    if (cmd === 'help') {
      const help = new EmbedBuilder()
        .setColor('#00AAFF')
        .setTitle(
          '📖 erts United Friendly Bot — Help'
        )
        .setDescription(
          'Commands available for erts United members'
        )
        .addFields(
          {
            name: '⚽ Friendlies',
            value:
              '`!hostfriendly [pos|number]` — post lineup (GK, CB, CB2, CM, LW, RW, ST). React to claim.',
          },
          {
            name: '🛠 Moderation',
            value:
              '`!ban @user`, `!unban <id>`, `!kick @user`, `!timeout @user <s>`, `!vmute @user`',
          },
          {
            name: '🎵 Music',
            value:
              '`!joinvc`, `!leavevc`, `!play <YouTubeURL>`, `!skip`, `!stop`',
          },
          {
            name: '👥 Activity',
            value:
              '`!activitycheck <goal>` — posts an activity check.',
          },
          {
            name: '✉️ DM Tools',
            value:
              '`!dmrole <roleId> <message>`, `!dmall <message>` (Admins only)',
          },
          {
            name: '📢 Utility',
            value:
              '`!message <text>` — bot posts a neat embed announcement\n`!hosttraining` — host posts a training signup link\n`!purge <1-100>` — bulk delete messages',
          }
        );

      return message.channel
        .send({ embeds: [help] })
        .catch(() => {});
    }

    // -------------------------
    // PURGE
    // -------------------------
    if (cmd === 'purge') {
      if (
        !message.member.permissions.has(
          PermissionsBitField.Flags.ManageMessages
        )
      ) {
        return message
          .reply(
            '❌ You do not have permission to purge messages.'
          )
          .catch(() => {});
      }

      const amount = parseInt(args[0], 10);

      if (
        Number.isNaN(amount) ||
        amount < 1 ||
        amount > 100
      ) {
        return message
          .reply(
            '⚠️ Please enter a number between 1 and 100.'
          )
          .catch(() => {});
      }

      try {
        const deleted =
          await message.channel.bulkDelete(
            amount,
            true
          );

        const confirm =
          await message.channel
            .send(
              `✅ Deleted **${deleted.size}** messages.`
            )
            .catch(() => null);

        if (confirm) {
          setTimeout(
            () =>
              confirm.delete().catch(() => {}),
            5000
          );
        }
      } catch (err) {
        console.error(
          'Bulk delete error:',
          err
        );

        return message
          .reply(
            '❌ I cannot delete messages older than 14 days or an error occurred.'
          )
          .catch(() => {});
      }

      return;
    }

    // -------------------------
    // BAN
    // -------------------------
    if (cmd === 'ban') {
      if (
        !message.member.permissions.has(
          PermissionsBitField.Flags.BanMembers
        )
      ) {
        return message
          .reply(
            '❌ Missing permission: BanMembers'
          )
          .catch(() => {});
      }

      const target =
        message.mentions.members.first();

      const reason =
        args.slice(1).join(' ') ||
        'No reason';

      if (!target) {
        return message
          .reply(
            'Usage: `!ban @user [reason]`'
          )
          .catch(() => {});
      }

      try {
        await target.ban({ reason });

        await message.channel.send(
          `🔨 Banned ${target.user.tag}`
        );

        safeGetLogChannel(message.guild)
          ?.send(
            `🔨 Ban: ${message.author.tag} -> ${target.user.tag} — ${reason}`
          )
          .catch(() => {});
      } catch (e) {
        await message
          .reply(`Failed: ${e.message}`)
          .catch(() => {});
      }

      return;
    }

    // -------------------------
    // UNBAN
    // -------------------------
    if (cmd === 'unban') {
      if (
        !message.member.permissions.has(
          PermissionsBitField.Flags.BanMembers
        )
      ) {
        return message
          .reply(
            '❌ Missing permission: BanMembers'
          )
          .catch(() => {});
      }

      const id = args[0];

      if (!id) {
        return message
          .reply(
            'Usage: `!unban <userId>`'
          )
          .catch(() => {});
      }

      try {
        await message.guild.bans.remove(id);

        await message.channel.send(
          `✅ Unbanned ${id}`
        );

        safeGetLogChannel(message.guild)
          ?.send(
            `✅ Unban: ${message.author.tag} -> ${id}`
          )
          .catch(() => {});
      } catch (e) {
        await message
          .reply(`Failed: ${e.message}`)
          .catch(() => {});
      }

      return;
    }

    // -------------------------
    // KICK
    // -------------------------
    if (cmd === 'kick') {
      if (
        !message.member.permissions.has(
          PermissionsBitField.Flags.KickMembers
        )
      ) {
        return message
          .reply(
            '❌ Missing permission: KickMembers'
          )
          .catch(() => {});
      }

      const target =
        message.mentions.members.first();

      const reason =
        args.slice(1).join(' ') ||
        'No reason';

      if (!target) {
        return message
          .reply(
            'Usage: `!kick @user [reason]`'
          )
          .catch(() => {});
      }

      try {
        await target.kick(reason);

        await message.channel.send(
          `👢 Kicked ${target.user.tag}`
        );

        safeGetLogChannel(message.guild)
          ?.send(
            `👢 Kick: ${message.author.tag} -> ${target.user.tag} — ${reason}`
          )
          .catch(() => {});
      } catch (e) {
        await message
          .reply(`Failed: ${e.message}`)
          .catch(() => {});
      }

      return;
    }

    // -------------------------
    // TIMEOUT
    // -------------------------
    if (cmd === 'timeout') {
      if (
        !message.member.permissions.has(
          PermissionsBitField.Flags.ModerateMembers
        )
      ) {
        return message
          .reply(
            '❌ Missing permission: ModerateMembers'
          )
          .catch(() => {});
      }

      const target =
        message.mentions.members.first();

      const seconds = parseInt(
        args[1] || args[0],
        10
      );

      if (
        !target ||
        Number.isNaN(seconds) ||
        seconds <= 0
      ) {
        return message
          .reply(
            'Usage: `!timeout @user <seconds>`'
          )
          .catch(() => {});
      }

      try {
        await target.timeout(
          seconds * 1000,
          `By ${message.author.tag}`
        );

        await message.channel.send(
          `⏲️ Timed out ${target.user.tag} for ${seconds}s`
        );

        safeGetLogChannel(message.guild)
          ?.send(
            `⏲️ Timeout: ${message.author.tag} -> ${target.user.tag} (${seconds}s)`
          )
          .catch(() => {});
      } catch (e) {
        await message
          .reply(`Failed: ${e.message}`)
          .catch(() => {});
      }

      return;
    }

    // -------------------------
    // VMUTE
    // -------------------------
    if (cmd === 'vmute') {
      if (
        !message.member.permissions.has(
          PermissionsBitField.Flags.ModerateMembers
        )
      ) {
        return message
          .reply(
            '❌ Missing permission: ModerateMembers'
          )
          .catch(() => {});
      }

      const target =
        message.mentions.members.first();

      if (!target) {
        return message
          .reply(
            'Usage: `!vmute @user`'
          )
          .catch(() => {});
      }

      if (!target.voice?.channel) {
        return message
          .reply('User not in VC.')
          .catch(() => {});
      }

      try {
        await target.voice.setMute(
          true,
          `Manual VMute by ${message.author.tag}`
        );

        await message.channel.send(
          `🔇 Voice-muted ${target.user.tag}`
        );

        safeGetLogChannel(message.guild)
          ?.send(
            `🔇 VMute: ${message.author.tag} -> ${target.user.tag}`
          )
          .catch(() => {});
      } catch (e) {
        await message
          .reply(`Failed: ${e.message}`)
          .catch(() => {});
      }

      return;
    }

    // -------------------------
    // DM ROLE
    // -------------------------
    if (cmd === 'dmrole') {
      if (
        !message.member.permissions.has(
          PermissionsBitField.Flags.Administrator
        )
      ) {
        return message
          .reply('Admins only.')
          .catch(() => {});
      }

      const roleId = args.shift();
      const text = args.join(' ');

      if (!roleId || !text) {
        return message
          .reply(
            'Usage: `!dmrole <roleId> <message>`'
          )
          .catch(() => {});
      }

      const role =
        message.guild.roles.cache.get(roleId);

      if (!role) {
        return message
          .reply('Role not found.')
          .catch(() => {});
      }

      const members =
        await message.guild.members.fetch();

      let count = 0;

      for (
        const member of members.filter(
          (m) =>
            m.roles.cache.has(role.id) &&
            !m.user.bot
        ).values()
      ) {
        member
          .send(
            `${text}\n\n*DM sent by ${message.author.tag}*`
          )
          .catch(() => {});

        count++;

        await sleep(500);
      }

      await message.channel.send(
        `📩 DMed ${count} members with role <@&${role.id}>.`
      );

      return;
    }

    // -------------------------
    // DM ALL
    // -------------------------
    if (cmd === 'dmall') {
      if (
        !message.member.permissions.has(
          PermissionsBitField.Flags.Administrator
        )
      ) {
        return message
          .reply('Admins only.')
          .catch(() => {});
      }

      const text = args.join(' ');

      if (!text) {
        return message
          .reply(
            'Usage: `!dmall <message>`'
          )
          .catch(() => {});
      }

      const members =
        await message.guild.members.fetch();

      let count = 0;

      for (const member of members.values()) {
        if (member.user.bot) continue;

        member
          .send(
            `${text}\n\n*DM sent by ${message.author.tag}*`
          )
          .catch(() => {});

        count++;

        await sleep(500);
      }

      await message.channel.send(
        `📩 DMed ${count} members.`
      );

      return;
    }

    // -------------------------
    // ACTIVITY CHECK
    // -------------------------
    if (cmd === 'activitycheck') {
      const goal = Math.max(
        1,
        parseInt(args[0], 10) || 40
      );

      const embed = new EmbedBuilder()
        .setColor(0x2b6cb0)
        .setTitle('📊 Activity Check')
        .setDescription(
          `React with ✅ to check in!\nGoal: **${goal}** members.`
        );

      const sent =
        await message.channel
          .send({
            content: '@here',
            embeds: [embed],
          })
          .catch(() => null);

      if (sent) {
        await sent.react('✅').catch(() => {});
      }

      return;
    }

    // -------------------------
    // JOIN VC
    // -------------------------
    if (cmd === 'joinvc') {
      if (!ENABLE_VOICE) {
        return message
          .reply(
            '⚠️ Voice disabled on this host.'
          )
          .catch(() => {});
      }

      const vc =
        message.member.voice.channel;

      if (!vc) {
        return message
          .reply(
            'Join a voice channel first.'
          )
          .catch(() => {});
      }

      joinVoiceChannel({
        channelId: vc.id,
        guildId: vc.guild.id,
        adapterCreator:
          vc.guild.voiceAdapterCreator,
      });

      return message.channel
        .send('✅ Joined VC.')
        .catch(() => {});
    }

    // -------------------------
    // LEAVE VC
    // -------------------------
    if (cmd === 'leavevc') {
      const conn =
        getVoiceConnection(
          message.guild.id
        );

      if (!conn) {
        return message
          .reply('Not connected.')
          .catch(() => {});
      }

      conn.destroy();

      return message.channel
        .send('👋 Left VC.')
        .catch(() => {});
    }

    // -------------------------
    // PLAY
    // -------------------------
    if (cmd === 'play') {
      if (!ENABLE_VOICE) {
        return message
          .reply(
            '⚠️ Voice disabled on this host.'
          )
          .catch(() => {});
      }

      const url = args[0];

      if (
        !url ||
        !ytdl.validateURL(url)
      ) {
        return message
          .reply(
            'Usage: `!play <YouTubeURL>`'
          )
          .catch(() => {});
      }

      const vc =
        message.member.voice.channel;

      if (!vc) {
        return message
          .reply(
            'Join a voice channel first.'
          )
          .catch(() => {});
      }

      const queue =
        musicQueues.get(
          message.guild.id
        ) || [];

      const info =
        await ytdl
          .getInfo(url)
          .catch(() => null);

      const title =
        info?.videoDetails?.title || url;

      queue.push({
        title,
        url,
      });

      musicQueues.set(
        message.guild.id,
        queue
      );

      await message.channel
        .send(
          `➕ Queued **${title}**`
        )
        .catch(() => {});

      let conn =
        getVoiceConnection(
          message.guild.id
        );

      if (!conn) {
        conn = joinVoiceChannel({
          channelId: vc.id,
          guildId: vc.guild.id,
          adapterCreator:
            vc.guild.voiceAdapterCreator,
        });
      }

      let player =
        audioPlayers.get(
          message.guild.id
        );

      if (!player) {
        player =
          createAudioPlayer({
            behaviors: {
              noSubscriber:
                NoSubscriberBehavior.Pause,
            },
          });

        audioPlayers.set(
          message.guild.id,
          player
        );

        conn.subscribe(player);

        player.on(
          AudioPlayerStatus.Idle,
          async () => {
            const cur =
              musicQueues.get(
                message.guild.id
              ) || [];

            cur.shift();

            musicQueues.set(
              message.guild.id,
              cur
            );

            if (cur[0]) {
              await playTrack(
                message.guild.id,
                cur[0].url,
                message.channel
              );
            } else {
              await message.channel
                .send(
                  '⏹️ Queue finished.'
                )
                .catch(() => {});
            }
          }
        );

        player.on(
          'error',
          (e) => {
            message.channel
              .send(
                `Player error: ${e.message}`
              )
              .catch(() => {});
          }
        );
      }

      const currentQueue =
        musicQueues.get(
          message.guild.id
        ) || [];

      if (currentQueue.length === 1) {
        await playTrack(
          message.guild.id,
          url,
          message.channel
        );
      }

      return;
    }

    // -------------------------
    // SKIP
    // -------------------------
    if (cmd === 'skip') {
      const player =
        audioPlayers.get(
          message.guild.id
        );

      if (!player) {
        return message
          .reply('Nothing playing.')
          .catch(() => {});
      }

      player.stop(true);

      return message.channel
        .send('⏭️ Skipped.')
        .catch(() => {});
    }

    // -------------------------
    // STOP
    // -------------------------
    if (cmd === 'stop') {
      musicQueues.set(
        message.guild.id,
        []
      );

      audioPlayers
        .get(message.guild.id)
        ?.stop(true);

      getVoiceConnection(
        message.guild.id
      )?.destroy();

      return message.channel
        .send(
          '⏹️ Stopped & cleared queue.'
        )
        .catch(() => {});
    }

    // -------------------------
    // HOST FRIENDLY
    // -------------------------
    if (cmd === 'hostfriendly') {
      if (
        !message.member.roles.cache.has(
          HOST_ROLE_ID
        )
      ) {
        return message
          .reply(
            '❌ You are not allowed to host friendlies.'
          )
          .catch(() => {});
      }

      hostfriendlyCounts.set(
        message.guild.id,
        (hostfriendlyCounts.get(
          message.guild.id
        ) || 0) + 1
      );

      const positions = [
        'GK',
        'CB',
        'CB2',
        'CM',
        'LW',
        'RW',
        'ST',
      ];

      const numbers = [
        '1️⃣',
        '2️⃣',
        '3️⃣',
        '4️⃣',
        '5️⃣',
        '6️⃣',
        '7️⃣',
      ];

      const taken = Array(
        positions.length
      ).fill(null);

      const lineup = {};

      if (args[0]) {
        let idx = -1;

        const a =
          args[0].toLowerCase();

        if (
          !Number.isNaN(
            Number(a)
          )
        ) {
          idx =
            parseInt(a, 10) - 1;
        } else {
          idx =
            positions.findIndex(
              (p) =>
                p.toLowerCase() === a
            );
        }

        if (
          idx >= 0 &&
          idx < positions.length &&
          !taken[idx]
        ) {
          taken[idx] =
            message.author.id;

          lineup[
            message.author.id
          ] = idx;
        }
      }

      const sent =
        await message.channel
          .send({
            content: '@here',
            embeds: [
              lineupEmbed({
                positions,
                numbers,
                taken,
                lineup,
              }),
            ],
          })
          .catch(() => null);

      if (!sent) {
        return message
          .reply(
            'Failed to post lineup.'
          )
          .catch(() => {});
      }

      for (const emoji of numbers) {
        await sent.react(emoji).catch(() => {});
      }

      const state = {
        messageId: sent.id,
        channelId: sent.channel.id,
        positions,
        numbers,
        taken,
        lineup,
      };

      lineups.set(
        message.guild.id,
        state
      );

      const collector =
        sent.createReactionCollector({
          filter: (reaction, user) =>
            numbers.includes(
              reaction.emoji.name
            ) && !user.bot,

          time: 30 * 60 * 1000,
        });

      collector.on(
        'collect',
        async (reaction, user) => {
          try {
            const current =
              lineups.get(
                message.guild.id
              );

            if (!current) return;

            const posIndex =
              current.numbers.indexOf(
                reaction.emoji.name
              );

            if (
              current.lineup[user.id] !==
              undefined
            ) {
              reaction.users
                .remove(user.id)
                .catch(() => {});

              await message.channel
                .send(
                  `<@${user.id}> ❌ You are already in the lineup!`
                )
                .catch(() => {});

              return;
            }

            if (
              current.taken[posIndex]
            ) {
              reaction.users
                .remove(user.id)
                .catch(() => {});

              await message.channel
                .send(
                  `<@${user.id}> ❌ Position taken.`
                )
                .catch(() => {});

              return;
            }

            current.taken[posIndex] =
              user.id;

            current.lineup[user.id] =
              posIndex;

            await user
              .send(
                `✅ Position confirmed: **${current.positions[posIndex]}**`
              )
              .catch(() => {});

            await message.channel
              .send(
                `✅ ${current.positions[posIndex]} confirmed for <@${user.id}>`
              )
              .catch(() => {});

            const channel =
              await message.guild.channels
                .fetch(
                  current.channelId
                )
                .catch(() => null);

            if (!channel) return;

            const msgToEdit =
              await channel.messages
                .fetch(
                  current.messageId
                )
                .catch(() => null);

            if (!msgToEdit) return;

            await msgToEdit
              .edit({
                embeds: [
                  lineupEmbed(current),
                ],
              })
              .catch(() => {});
          } catch (e) {
            console.error(
              'Lineup reaction handling error:',
              e
            );
          }
        }
      );

      return;
    }

    // -------------------------
    // EDIT LINEUP
    // -------------------------
    if (cmd === 'editlineup') {
      if (
        !message.member.roles.cache.has(
          HOST_ROLE_ID
        )
      ) {
        return message
          .reply(
            'Only the friendly host can edit the lineup.'
          )
          .catch(() => {});
      }

      const state =
        lineups.get(
          message.guild.id
        );

      if (!state) {
        return message
          .reply(
            'No active lineup.'
          )
          .catch(() => {});
      }

      const posArg =
        args[0]?.toLowerCase();

      const user =
        message.mentions.users.first();

      if (!posArg || !user) {
        return message
          .reply(
            'Usage: `!editlineup <pos> @user`'
          )
          .catch(() => {});
      }

      let idx = -1;

      if (
        !Number.isNaN(
          Number(posArg)
        )
      ) {
        idx =
          parseInt(
            posArg,
            10
          ) - 1;
      } else {
        idx =
          state.positions.findIndex(
            (p) =>
              p.toLowerCase() ===
              posArg
          );
      }

      if (
        idx < 0 ||
        idx >= state.positions.length
      ) {
        return message
          .reply(
            'Invalid position.'
          )
          .catch(() => {});
      }

      if (state.taken[idx]) {
        const previous =
          state.taken[idx];

        delete state.lineup[
          previous
        ];
      }

      if (
        state.lineup[user.id] !==
        undefined
      ) {
        const old =
          state.lineup[user.id];

        state.taken[old] = null;
      }

      state.taken[idx] =
        user.id;

      state.lineup[user.id] =
        idx;

      const channel =
        await message.guild.channels
          .fetch(state.channelId)
          .catch(() => null);

      if (!channel) {
        return message
          .reply(
            'Failed to fetch lineup channel.'
          )
          .catch(() => {});
      }

      const msgToEdit =
        await channel.messages
          .fetch(state.messageId)
          .catch(() => null);

      if (!msgToEdit) {
        return message
          .reply(
            'Failed to fetch lineup message.'
          )
          .catch(() => {});
      }

      await msgToEdit
        .edit({
          embeds: [
            lineupEmbed(state),
          ],
        })
        .catch(() => {});

      return message.channel
        .send(
          `✏️ ${state.positions[idx]} updated → <@${user.id}>`
        )
        .catch(() => {});
    }

    // -------------------------
    // RESET LINEUP
    // -------------------------
    if (cmd === 'resetlineup') {
      if (
        !message.member.roles.cache.has(
          HOST_ROLE_ID
        )
      ) {
        return message
          .reply(
            'Only the friendly host can reset.'
          )
          .catch(() => {});
      }

      lineups.delete(
        message.guild.id
      );

      return message.channel
        .send(
          '♻️ Lineup reset.'
        )
        .catch(() => {});
    }

    // -------------------------
    // HOST TRAINING
    // -------------------------
    if (cmd === 'hosttraining') {
      if (
        !message.member.roles.cache.has(
          HOST_ROLE_ID
        ) &&
        !message.member.permissions.has(
          PermissionsBitField.Flags.Administrator
        )
      ) {
        return message
          .reply(
            '❌ You are not allowed to host trainings.'
          )
          .catch(() => {});
      }

      await message
        .reply(
          '✅ Send the training link below. You have 60 seconds.'
        )
        .catch(() => {});

      const filter = (m) =>
        m.author.id ===
        message.author.id;

      const collector =
        message.channel.createMessageCollector({
          filter,
          max: 1,
          time: 60_000,
        });

      collector.on(
        'collect',
        async (collected) => {
          const link =
            collected.content.trim();

          if (
            !link.startsWith(
              'http'
            )
          ) {
            await message
              .reply(
                '❌ That is not a valid link. Training cancelled.'
              )
              .catch(() => {});

            return;
          }

          const embed =
            new EmbedBuilder()
              .setColor('Blue')
              .setTitle(
                '📘 erts United Training Signup'
              )
              .setDescription(
                `React ✅ to receive the training link.\nHosted by <@${message.author.id}>`
              )
              .setTimestamp();

          const signupMsg =
            await message.channel
              .send({
                embeds: [embed],
              })
              .catch(() => null);

          if (!signupMsg) {
            return message
              .reply(
                'Failed to post signup.'
              )
              .catch(() => {});
          }

          await signupMsg
            .react('✅')
            .catch(() => {});

          const reactionFilter = (
            reaction,
            user
          ) =>
            reaction.emoji.name ===
              '✅' &&
            !user.bot;

          const reactionCollector =
            signupMsg.createReactionCollector({
              filter: reactionFilter,
            });

          reactionCollector.on(
            'collect',
            async (_reaction, user) => {
              try {
                await user
                  .send(
                    `✅ Here is the training link:\n${link}`
                  )
                  .catch(async () => {
                    await message.channel
                      .send(
                        `⚠️ <@${user.id}> has DMs closed. Could not send link.`
                      )
                      .catch(() => {});
                  });
              } catch {
                // Ignore
              }
            }
          );
        }
      );

      collector.on(
        'end',
        (collected) => {
          if (collected.size === 0) {
            message
              .reply(
                '❌ You never sent a link. Training cancelled.'
              )
              .catch(() => {});
          }
        }
      );

      return;
    }

    // -------------------------
    // MESSAGE ANNOUNCEMENT
    // -------------------------
    if (cmd === 'message') {
      if (
        !message.member.permissions.has(
          PermissionsBitField.Flags.ManageMessages
        )
      ) {
        return message
          .reply(
            '❌ You need Manage Messages permission to use this command.'
          )
          .catch(() => {});
      }

      const content =
        args.join(' ');

      if (!content) {
        return message
          .reply(
            '❌ You need to actually write something.'
          )
          .catch(() => {});
      }

      const embed =
        new EmbedBuilder()
          .setColor('Blue')
          .setTitle(
            '📢 erts United Announcement'
          )
          .setDescription(content)
          .setFooter({
            text: `Sent by ${message.author.tag}`,
          })
          .setTimestamp();

      return message.channel
        .send({
          embeds: [embed],
        })
        .catch(() => {});
    }

    // -------------------------
    // CHECK FRIENDLY
    // -------------------------
    if (cmd === 'checkfriendly') {
      const count =
        hostfriendlyCounts.get(
          message.guild.id
        ) || 0;

      return message.channel
        .send(
          `📋 This server has used \`!hostfriendly\` **${count}** time(s).`
        )
        .catch(() => {});
    }

    // -------------------------
    // Unknown commands ignored
    // -------------------------
  } catch (err) {
    console.error(
      'messageCreate handler error:',
      err
    );
  }
});

// -----------------------------
// Music helper
// -----------------------------
async function playTrack(
  guildId,
  url,
  textChannel
) {
  try {
    const conn =
      getVoiceConnection(guildId);

    if (!conn) {
      await textChannel
        .send(
          '⚠️ Not connected to a VC.'
        )
        .catch(() => {});

      return;
    }

    const stream = ytdl(url, {
      filter: 'audioonly',
      highWaterMark: 1 << 25,
      quality: 'highestaudio',
    });

    const resource =
      createAudioResource(stream);

    let player =
      audioPlayers.get(guildId);

    if (!player) {
      player =
        createAudioPlayer({
          behaviors: {
            noSubscriber:
              NoSubscriberBehavior.Pause,
          },
        });

      audioPlayers.set(
        guildId,
        player
      );

      conn.subscribe(player);
    }

    player.play(resource);

    const info =
      await ytdl
        .getInfo(url)
        .catch(() => null);

    await textChannel
      .send(
        `🎶 Playing **${
          info?.videoDetails?.title ||
          url
        }**`
      )
      .catch(() => {});
  } catch (e) {
    console.error(
      'playTrack error:',
      e
    );

    await textChannel
      .send(
        `Failed to play track: ${e.message}`
      )
      .catch(() => {});
  }
}

// -----------------------------
// Keepalive server
// -----------------------------
const app = express();

app.get('/', (_req, res) => {
  res.send(
    '✅ erts United Bot is alive and running!'
  );
});

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `🌍 Keepalive server listening on port ${PORT}`
    );
  }
);

// -----------------------------
// Process safety
// -----------------------------
process.on(
  'unhandledRejection',
  (reason) => {
    console.error(
      'Unhandled Rejection:',
      reason
    );
  }
);

process.on(
  'uncaughtException',
  (err) => {
    console.error(
      'Uncaught Exception:',
      err
    );
  }
);

// -----------------------------
// Login
// -----------------------------
if (!TOKEN) {
  console.error(
    '❌ Missing TOKEN env var. Set TOKEN in environment.'
  );

  process.exit(1);
}

client
  .login(TOKEN)
  .catch((e) => {
    console.error(
      'Failed to login:',
      e
    );

    process.exit(1);
  });