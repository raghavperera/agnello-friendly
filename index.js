// index.js
// Agnello FC Friendly Bot — FULL single-file build
// Node 18+ / discord.js v14
// -------------------------------------------------

import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  PermissionsBitField,
  Collection,
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
} from '@discordjs/voice';
import ytdl from 'ytdl-core';
import ffmpeg from 'ffmpeg-static';

// -----------------------------
// ENV / CONFIG
// -----------------------------
const TOKEN = process.env.TOKEN; // REQUIRED
const ENABLE_VOICE = process.env.ENABLE_VOICE === 'true'; // set true only on a UDP-capable VPS
const LOG_CHANNEL_ID = '1362214241091981452';

// Friendly host role (can start & edit lineups)
const HOST_ROLE_ID = '1383970211933454378';

// Welcome/Farewell channels
const WELCOME_CHANNEL_ID = '1403929923084882012';
const FAREWELL_CHANNEL_ID = '1403930222222643220';

// Prefix
const PREFIX = '!';

// Basic swear list (you can swap to an external file if you want)
const SWEARS = [
  'fuck','shit','bitch','asshole','cunt','bastard','dick','pussy','slut','whore',
  'wanker','prick','bollocks','motherfucker','mf','faggot','fag','retard','retarded'
];

// -----------------------------
// CLIENT
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
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
});

// In-memory stores
const textWarnings = new Map(); // userId -> count
const musicQueues = new Map();  // guildId -> [{ title, url }]
const audioPlayers = new Map(); // guildId -> AudioPlayer

// Lineup state (one per guild)
const lineups = new Map(); // guildId -> LineupState

/**
 * @typedef {Object} LineupState
 * @property {string} messageId
 * @property {string} channelId
 * @property {string[]} positions
 * @property {string[]} numbers
 * @property {(string|null)[]} taken // index -> userId
 * @property {Object.<string, number>} lineup // userId -> index
 */

// Utility: get log channel
const getLog = (guild) => guild.channels.cache.get(LOG_CHANNEL_ID);

// -----------------------------
// READY
// -----------------------------
client.once('ready', async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Voice features: ${ENABLE_VOICE ? 'ENABLED (UDP host required)' : 'DISABLED (Render-safe)'}`);
});

// -----------------------------
// WELCOME / FAREWELL + DM
// -----------------------------
client.on('guildMemberAdd', async (member) => {
  client.channels.cache.get(WELCOME_CHANNEL_ID)?.send(`👋 Welcome, ${member}!`);
  try {
    await member.send(`👋 Welcome to **${member.guild.name}**! Glad to have you here.`);
  } catch {}
});

client.on('guildMemberRemove', async (member) => {
  client.channels.cache.get(FAREWELL_CHANNEL_ID)?.send(`👋 Goodbye, **${member.user.tag}**!`);
  try {
    await member.send(`😢 Sorry to see you leave **${member.guild.name}**. You're welcome back anytime.`);
  } catch {}
});

// -----------------------------
// AUTO ✅ on @everyone/@here
// -----------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  try {
    if (message.mentions.everyone || message.content.includes('@here')) {
      await message.react('✅');
    }
  } catch {}
});

// -----------------------------
// TEXT PROFANITY FILTER (+warn, DM, log)
// -----------------------------
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const content = (message.content || '').toLowerCase();
  if (!content) return;

  if (SWEARS.some((w) => content.includes(w))) {
    // delete
    await message.delete().catch(() => {});
    // warn count
    const count = (textWarnings.get(message.author.id) || 0) + 1;
    textWarnings.set(message.author.id, count);

    // DM
    try {
      await message.author.send(
        `⚠️ Your message in **${message.guild.name}** was removed for language:\n` +
        `> ${message.content}\n\nThis is your **${count} warning**.`
      );
    } catch {}

    // Log
    getLog(message.guild)?.send(
      `🧹 **Text Profanity** — ${message.author.tag} (ID: ${message.author.id})\n` +
      `Message:\n\`\`\`\n${message.content}\n\`\`\`\n` +
      `Warning #${count}`
    );

    // If user is currently in VC, mute for 10s (works only if bot has perms + UDP host; on Render, mute call still works but joining VC/audio does not)
    const member = message.member;
    if (member?.voice?.channel && member.manageable) {
      try {
        await member.voice.setMute(true, 'Auto-moderation: swearing');
        setTimeout(async () => {
          if (member.voice?.channel) {
            await member.voice.setMute(false, 'Auto-moderation: timeout finished');
          }
        }, 10_000);
        getLog(message.guild)?.send(`🔇 Auto VC mute applied to **${member.user.tag}** for 10s (text profanity).`);
      } catch {}
    }
  }
});

// ============================================================================
// COMMAND HANDLER
// ============================================================================
client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase() || '';

  // ---------------------------
  // Moderation: !ban, !unban, !kick, !timeout, !vmute
  // ---------------------------
  if (command === 'ban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('❌ Missing permission: BanMembers');
    const target = message.mentions.members?.first();
    const reason = args.slice(1).join(' ') || 'No reason';
    if (!target) return message.reply('Usage: `!ban @user [reason]`');
    await target.ban({ reason }).catch((e) => message.reply(`Failed: ${e.message}`));
    message.channel.send(`🔨 Banned **${target.user.tag}** (${target.id}) — ${reason}`);
    getLog(message.guild)?.send(`🔨 **Ban**: ${message.author.tag} banned ${target.user.tag} — ${reason}`);
    return;
  }

  if (command === 'unban') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('❌ Missing permission: BanMembers');
    const userId = args[0];
    if (!userId) return message.reply('Usage: `!unban <userId>`');
    await message.guild.bans.remove(userId).catch((e) => message.reply(`Failed: ${e.message}`));
    message.channel.send(`✅ Unbanned **${userId}**`);
    getLog(message.guild)?.send(`✅ **Unban**: ${message.author.tag} unbanned ${userId}`);
    return;
  }

  if (command === 'kick') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('❌ Missing permission: KickMembers');
    const target = message.mentions.members?.first();
    const reason = args.slice(1).join(' ') || 'No reason';
    if (!target) return message.reply('Usage: `!kick @user [reason]`');
    await target.kick(reason).catch((e) => message.reply(`Failed: ${e.message}`));
    message.channel.send(`👢 Kicked **${target.user.tag}** — ${reason}`);
    getLog(message.guild)?.send(`👢 **Kick**: ${message.author.tag} kicked ${target.user.tag} — ${reason}`);
    return;
  }

  if (command === 'timeout') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('❌ Missing permission: ModerateMembers');
    const target = message.mentions.members?.first();
    const seconds = parseInt(args[1] || args[0], 10);
    if (!target || Number.isNaN(seconds)) return message.reply('Usage: `!timeout @user <seconds>`');
    await target.timeout(seconds * 1000, `By ${message.author.tag}`).catch((e) => message.reply(`Failed: ${e.message}`));
    message.channel.send(`⏲️ Timed out **${target.user.tag}** for **${seconds}s**`);
    getLog(message.guild)?.send(`⏲️ **Timeout**: ${message.author.tag} -> ${target.user.tag} (${seconds}s)`);
    return;
  }

  if (command === 'vmute') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('❌ Missing permission: ModerateMembers');
    const target = message.mentions.members?.first();
    if (!target) return message.reply('Usage: `!vmute @user`');
    if (!target.voice?.channel) return message.reply('User is not in a voice channel.');
    await target.voice.setMute(true, `Manual VMute by ${message.author.tag}`).catch((e) => message.reply(`Failed: ${e.message}`));
    message.channel.send(`🔇 Voice-muted **${target.user.tag}**`);
    getLog(message.guild)?.send(`🔇 **VMute**: ${message.author.tag} muted ${target.user.tag}`);
    return;
  }

  // ---------------------------
  // DM utilities: !dmrole, !dmall
  // ---------------------------
  if (command === 'dmrole') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('❌ Admins only.');
    const roleId = args.shift();
    const text = args.join(' ');
    if (!roleId || !text) return message.reply('Usage: `!dmrole <roleId> <message>`');
    const role = message.guild.roles.cache.get(roleId);
    if (!role) return message.reply('Role not found.');
    const members = await message.guild.members.fetch();
    let count = 0;
    for (const m of members.filter((m) => m.roles.cache.has(role.id) && !m.user.bot).values()) {
      m.send(`${text}\n\n*dm sent by ${message.author.tag}*`).catch(() => {});
      count++;
    }
    message.channel.send(`📩 DMed **${count}** members with role <@&${role.id}>.`);
    return;
  }

  if (command === 'dmall') {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('❌ Admins only.');
    const text = args.join(' ');
    if (!text) return message.reply('Usage: `!dmall <message>`');
    const members = await message.guild.members.fetch();
    let count = 0;
    for (const m of members.values()) {
      if (m.user.bot) continue;
      m.send(`${text}\n\n*dm sent by ${message.author.tag}*`).catch(() => {});
      count++;
    }
    message.channel.send(`📩 DMed **${count}** members.`);
    return;
  }

  // ---------------------------
  // Activity Check: !activitycheck <goal>
  // ---------------------------
  if (command === 'activitycheck') {
    const goal = parseInt(args[0], 10) || 40;
    const embed = new EmbedBuilder()
      .setColor(0x2b6cb0)
      .setTitle('📊 Activity Check')
      .setDescription(`React with ✅ to check in!\nGoal: **${goal}** members.`);

    const msg = await message.channel.send({ content: '@here', embeds: [embed] });
    await msg.react('✅');
    return;
  }

  // ---------------------------
  // Voice channel control (only works on UDP-capable hosts)
  // ---------------------------
  if (command === 'joinvc') {
    if (!ENABLE_VOICE) return message.reply('⚠️ Voice is disabled on this host.');
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('Join a voice channel first.');
    joinVoiceChannel({
      channelId: vc.id,
      guildId: vc.guild.id,
      adapterCreator: vc.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    message.channel.send('✅ Joined voice channel.');
    return;
  }

  if (command === 'leavevc') {
    const conn = getVoiceConnection(message.guild.id);
    if (!conn) return message.reply('Not connected.');
    conn.destroy();
    message.channel.send('👋 Left voice channel.');
    return;
  }

  // ---------------------------
  // Music (basic YouTube) — requires ENABLE_VOICE and UDP host; won’t work on Render
  // ---------------------------
  if (command === 'play') {
    if (!ENABLE_VOICE) return message.reply('⚠️ Voice is disabled on this host.');
    const url = args[0];
    if (!url || !ytdl.validateURL(url)) return message.reply('Usage: `!play <YouTubeURL>`');
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('Join a voice channel first.');

    // queue
    const q = musicQueues.get(message.guild.id) || [];
    const info = await ytdl.getInfo(url).catch(() => null);
    const title = info?.videoDetails?.title || url;
    q.push({ title, url });
    musicQueues.set(message.guild.id, q);
    message.channel.send(`➕ Queued **${title}**`);

    // ensure connection
    let conn = getVoiceConnection(message.guild.id);
    if (!conn) {
      conn = joinVoiceChannel({
        channelId: vc.id,
        guildId: vc.guild.id,
        adapterCreator: vc.guild.voiceAdapterCreator,
      });
    }

    // create/get player
    let player = audioPlayers.get(message.guild.id);
    if (!player) {
      player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
      audioPlayers.set(message.guild.id, player);
      conn.subscribe(player);

      player.on(AudioPlayerStatus.Idle, () => {
        // play next
        const currentQ = musicQueues.get(message.guild.id) || [];
        currentQ.shift();
        musicQueues.set(message.guild.id, currentQ);
        if (currentQ[0]) {
          playTrack(message.guild.id, currentQ[0].url, message.channel).catch(() => {});
        } else {
          message.channel.send('⏹️ Queue finished.');
        }
      });

      player.on('error', (e) => {
        message.channel.send(`⚠️ Player error: ${e.message}`);
      });
    }

    const currentQ = musicQueues.get(message.guild.id) || [];
    if (currentQ.length === 1) {
      await playTrack(message.guild.id, url, message.channel);
    }
    return;
  }

  if (command === 'skip') {
    const player = audioPlayers.get(message.guild.id);
    if (!player) return message.reply('Nothing is playing.');
    player.stop(true);
    message.channel.send('⏭️ Skipped.');
    return;
  }

  if (command === 'stop') {
    musicQueues.set(message.guild.id, []);
    const player = audioPlayers.get(message.guild.id);
    player?.stop(true);
    const conn = getVoiceConnection(message.guild.id);
    conn?.destroy();
    message.channel.send('⏹️ Stopped and cleared queue.');
    return;
  }

  // ---------------------------
  // Hostfriendly lineup system (named positions + numbers, DM, pre-claim, edit, reset)
  // ---------------------------
  if (command === 'hostfriendly') {
    if (!message.member.roles.cache.has(HOST_ROLE_ID)) {
      await message.reply('❌ You are not allowed to host friendlies.');
      return;
    }

    const positions = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
    const numbers = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
    const taken = Array(positions.length).fill(null); // index -> userId
    const lineup = {}; // userId -> index

    // Pre-claim by arg: number or name
    if (args[0]) {
      let idx = -1;
      const a = args[0].toLowerCase();
      if (!Number.isNaN(Number(a))) idx = parseInt(a, 10) - 1;
      else idx = positions.findIndex(p => p.toLowerCase() === a);
      if (idx >= 0 && idx < positions.length && !taken[idx]) {
        taken[idx] = message.author.id;
        lineup[message.author.id] = idx;
      }
    }

    const buildEmbed = () => {
      const lines = positions.map((pos, i) => {
        const uid = taken[i];
        return `${numbers[i]} ➜ **${pos}**\n${uid ? `<@${uid}>` : '_-_'}`;
      }).join('\n\n');

      const finalList = positions.map((pos, i) => `${pos}: ${taken[i] ? `<@${taken[i]}>` : '_-_'}`).join('\n');

      return new EmbedBuilder()
        .setColor(0x00a86b)
        .setTitle('AGNELLO FC 7v7 FRIENDLY')
        .setDescription(
          lines +
          '\n\nReact to claim a position. Only **1** position per user.\n' +
          'Host may edit with `!editlineup <pos> @user` or reset with `!resetlineup`.\n\n' +
          '✅ **Final Lineup:**\n' + finalList
        );
    };

    const msg = await message.channel.send({ content: '@here', embeds: [buildEmbed()] });
    for (const e of numbers) await msg.react(e);

    // Save state
    lineups.set(message.guild.id, {
      messageId: msg.id,
      channelId: msg.channel.id,
      positions, numbers, taken, lineup,
    });

    // Collector
    const collector = msg.createReactionCollector({
      filter: (reaction, user) => numbers.includes(reaction.emoji.name) && !user.bot,
    });

    collector.on('collect', async (reaction, user) => {
      const state = lineups.get(message.guild.id);
      if (!state) return;
      const posIndex = state.numbers.indexOf(reaction.emoji.name);

      // already in lineup
      if (state.lineup[user.id] !== undefined) {
        await reaction.users.remove(user.id).catch(() => {});
        await message.channel.send(`<@${user.id}> ❌ You are already in the lineup!`);
        return;
      }

      // position taken
      if (state.taken[posIndex]) {
        await reaction.users.remove(user.id).catch(() => {});
        await message.channel.send(`<@${user.id}> ❌ That position is already taken.`);
        return;
      }

      // assign
      state.taken[posIndex] = user.id;
      state.lineup[user.id] = posIndex;

      // DM + notify
      try { await user.send(`✅ Position confirmed: **${state.positions[posIndex]}**`); } catch {}
      await message.channel.send(`✅ ${state.positions[posIndex]} confirmed for <@${user.id}>`);

      // update embed
      const channel = await message.guild.channels.fetch(state.channelId);
      const msgToEdit = await channel.messages.fetch(state.messageId);
      await msgToEdit.edit({ embeds: [buildEmbedFromState(state)] }).catch(() => {});
    });

    function buildEmbedFromState(state) {
      const lines = state.positions.map((pos, i) => {
        const uid = state.taken[i];
        return `${state.numbers[i]} ➜ **${pos}**\n${uid ? `<@${uid}>` : '_-_'}`;
      }).join('\n\n');
      const finalList = state.positions.map((pos, i) => `${pos}: ${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n');
      return new EmbedBuilder()
        .setColor(0x00a86b)
        .setTitle('AGNELLO FC 7v7 FRIENDLY')
        .setDescription(
          lines +
          '\n\nReact to claim a position. Only **1** position per user.\n' +
          'Host may edit with `!editlineup <pos> @user` or reset with `!resetlineup`.\n\n' +
          '✅ **Final Lineup:**\n' + finalList
        );
    }

    return;
  }

  if (command === 'editlineup') {
    if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('❌ Only the friendly host can edit the lineup.');
    const state = lineups.get(message.guild.id);
    if (!state) return message.reply('❌ No active lineup found.');

    const posArg = args[0]?.toLowerCase();
    const user = message.mentions.users.first();
    if (!posArg || !user) return message.reply('Usage: `!editlineup <pos> <@user>` (pos can be number or name, e.g. `cm`)');

    let idx = -1;
    if (!Number.isNaN(Number(posArg))) idx = parseInt(posArg, 10) - 1;
    else idx = state.positions.findIndex((p) => p.toLowerCase() === posArg);
    if (idx < 0 || idx >= state.positions.length) return message.reply('❌ Invalid position.');

    // free any user currently holding it
    if (state.taken[idx]) {
      const prevId = state.taken[idx];
      delete state.lineup[prevId];
    }

    // if the new user was already in lineup elsewhere, free that too
    if (state.lineup[user.id] !== undefined) {
      const oldIdx = state.lineup[user.id];
      state.taken[oldIdx] = null;
    }

    state.taken[idx] = user.id;
    state.lineup[user.id] = idx;

    // update embed
    const channel = await message.guild.channels.fetch(state.channelId);
    const msgToEdit = await channel.messages.fetch(state.messageId);
    await msgToEdit.edit({ embeds: [buildEmbedFromState(state)] }).catch(() => {});
    await message.channel.send(`✏️ ${state.positions[idx]} updated → <@${user.id}>`);
    return;

    function buildEmbedFromState(state) {
      const lines = state.positions.map((pos, i) => {
        const uid = state.taken[i];
        return `${state.numbers[i]} ➜ **${pos}**\n${uid ? `<@${uid}>` : '_-_'}`;
      }).join('\n\n');
      const finalList = state.positions.map((pos, i) => `${pos}: ${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n');
      return new EmbedBuilder()
        .setColor(0x00a86b)
        .setTitle('AGNELLO FC 7v7 FRIENDLY')
        .setDescription(
          lines +
          '\n\nReact to claim a position. Only **1** position per user.\n' +
          'Host may edit with `!editlineup <pos> @user` or reset with `!resetlineup`.\n\n' +
          '✅ **Final Lineup:**\n' + finalList
        );
    }
  }

  if (command === 'resetlineup') {
    if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('❌ Only the host can reset.');
    lineups.delete(message.guild.id);
    message.channel.send('♻️ Lineup reset.');
    return;
  }
});

// ============================================================================
// Helpers
// ============================================================================
async function playTrack(guildId, url, textChannel) {
  const conn = getVoiceConnection(guildId);
  if (!conn) {
    await textChannel.send('⚠️ Not connected to a voice channel.');
    return;
  }
  // ytdl -> pcm
  const stream = ytdl(url, {
    filter: 'audioonly',
    highWaterMark: 1 << 25,
    quality: 'highestaudio',
  });

  // ffmpeg-static is referenced so ffmpeg exists; discord.js/voice handles resource without manual args
  const res = createAudioResource(stream);
  let player = audioPlayers.get(guildId);
  if (!player) {
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    audioPlayers.set(guildId, player);
    conn.subscribe(player);
  }
  player.play(res);
  const info = await ytdl.getInfo(url).catch(() => null);
  await textChannel.send(`🎶 Playing **${info?.videoDetails?.title || url}**`);
}

// -----------------------------
// LOGIN
// -----------------------------
if (!TOKEN) {
  console.error('❌ Missing TOKEN env var.');
  process.exit(1);
}
client.login(TOKEN);
