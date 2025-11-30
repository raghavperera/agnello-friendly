/**
 * index.js
 * Agnello FC Friendly Bot — v14, ESM
 *
 * Features:
 * - Prefix commands (!) and Slash commands (/)
 * - !hostfriendly and /hostfriendly (7 positions). Reaction-claim workflow.
 * - After lineup filled: asks host for a ROBLOX link; DMs that link to all final players.
 * - !editlineup, !resetlineup
 * - DM tools: !dmrole, !dmall, !dm @user
 * - !activitycheck <goal>
 * - Moderation: !ban, !kick, !timeout
 * - Welcome and goodbye DMs
 * - Music: joinvc, leavevc, play, skip, stop, queue, loop (play-dl supports YouTube & Spotify)
 * - Auto voice join: bot will join a VC when someone joins (simple behavior)
 * - Logging to a channel (ID configured below)
 *
 * IMPORTANT:
 * - Set env vars: TOKEN, CLIENT_ID, GUILD_ID
 * - Enable privileged intents (Server Members Intent) in Discord Developer Portal
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import { fileURLToPath } from 'url';
import {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  PermissionsBitField,
  EmbedBuilder,
  Events,
  REST,
  Routes,
  SlashCommandBuilder
} from 'discord.js';
import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState
} from '@discordjs/voice';
import play from 'play-dl';
import ffmpegPath from 'ffmpeg-static';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ----- Config -----
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing required env vars. Set TOKEN, CLIENT_ID and GUILD_ID.');
  process.exit(1);
}

const PREFIX = '!';
const LOG_CHANNEL_ID = '1362214241091981452'; // per your request
const HOST_ROLE_ID = process.env.HOST_ROLE_ID || '1402167943747342348'; // use provided or env
const KEEPALIVE_PORT = process.env.PORT || 10000;

// ----- Persistence files (simple JSON) -----
const ECON_FILE = path.join(__dirname, 'economy.json');
const FCOUNTS_FILE = path.join(__dirname, 'friendly_counts.json');

function loadJsonOrDefault(file, def = {}) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(def, null, 2));
    const raw = fs.readFileSync(file, 'utf8') || '{}';
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to load', file, e);
    return def;
  }
}
function saveJson(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch(e) { console.error('Save error', e); }
}

// economy simple
let ECON = loadJsonOrDefault(ECON_FILE, {});
function ensureUser(id) { if (!ECON[id]) ECON[id] = { balance: 10 }; return ECON[id]; }
function getBal(id) { return (ensureUser(id).balance || 0); }
function addBal(id, n) { ensureUser(id); ECON[id].balance = Math.max(0, Math.floor((ECON[id].balance || 0) + n)); saveJson(ECON_FILE, ECON); return ECON[id].balance; }
function subBal(id, n) { ensureUser(id); ECON[id].balance = Math.max(0, Math.floor((ECON[id].balance || 0) - n)); saveJson(ECON_FILE, ECON); return ECON[id].balance; }

// friendly counts
let FRIENDLY_COUNTS = loadJsonOrDefault(FCOUNTS_FILE, {});
function incrementFriendlyCount(guildId, userId) {
  FRIENDLY_COUNTS[guildId] = FRIENDLY_COUNTS[guildId] || {};
  FRIENDLY_COUNTS[guildId][userId] = (FRIENDLY_COUNTS[guildId][userId] || 0) + 1;
  saveJson(FCOUNTS_FILE, FRIENDLY_COUNTS);
}
function getFriendlyCountForUser(guildId, userId) {
  return (FRIENDLY_COUNTS[guildId] && FRIENDLY_COUNTS[guildId][userId]) || 0;
}
function getFriendlyCountsForGuild(guildId) {
  return FRIENDLY_COUNTS[guildId] || {};
}

// ----- Utilities -----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

// ----- In-memory stores -----
const lineups = new Map(); // guildId => lineup state
const musicQueues = new Map(); // guildId => array of { title, url }
const audioPlayers = new Map(); // guildId => audio player
const dmRoleCache = new Set(); // avoid repeat DMing same user via dmrole
const textWarnings = new Map(); // simple profanity warnings counting

// ----- Client -----
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // privileged: enable in dev portal
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // privileged
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerSlashCommands();
    console.log('Slash commands registered.');
  } catch (e) {
    console.warn('Failed to register slash commands:', e);
  }
});

// ----- Simple logger helper (logs to configured channel if available) -----
function safeGetLogChannel(guild) {
  try {
    return guild?.channels.cache.get(LOG_CHANNEL_ID) || null;
  } catch (e) {
    return null;
  }
}
async function logToChannel(guild, text) {
  try {
    const ch = safeGetLogChannel(guild);
    if (ch) await ch.send(text).catch(()=>{});
  } catch {}
}

// ----- Welcome / Goodbye DMs -----
client.on(Events.GuildMemberAdd, async (member) => {
  try {
    await member.send(`Welcome to ${member.guild.name}, ${member.user.username}!`).catch(()=>{});
    await logToChannel(member.guild, `👋 Welcomed ${member.user.tag}`);
  } catch {}
});
client.on(Events.GuildMemberRemove, async (member) => {
  try {
    await logToChannel(member.guild, `👋 Left: ${member.user.tag}`);
    await member.user.send(`Sorry to see you go from ${member.guild.name}.`).catch(()=>{});
  } catch {}
});

// ----- Profanity simple filter -----
const SWEARS = ['fuck','shit','bitch','asshole','bastard','damn','crap','idiot','stfu','wtf','sucks'];
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.guild && message.content) {
    const lowered = message.content.toLowerCase();
    if (SWEARS.some(w => lowered.includes(w))) {
      try {
        await message.delete().catch(()=>{});
        const cnt = (textWarnings.get(message.author.id) || 0) + 1;
        textWarnings.set(message.author.id, cnt);
        await message.author.send(`⚠️ Your message was removed for language in ${message.guild.name}.\nThis is warning #${cnt}`).catch(()=>{});
        await logToChannel(message.guild, `🧹 Profanity: ${message.author.tag} — ${message.content}`);
        // optional small VC mute as previous behavior (10s)
        const member = message.member;
        if (member && member.voice?.channel && member.manageable) {
          try {
            await member.voice.setMute(true, 'Auto-moderation: swearing');
            await sleep(10000);
            if (member.voice?.channel) await member.voice.setMute(false, 'Auto-moderation expired');
          } catch {}
        }
      } catch {}
      return;
    }
  }
});

// ----- Prefix & Command Dispatcher -----
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.guild || !message.content) return;

  // react to @everyone/@here
  if ((message.mentions.everyone || message.content.includes('@here')) && !message.author.bot) {
    try { await message.react('✅'); } catch {}
  }

  if (!message.content.startsWith(PREFIX)) return;
  const raw = message.content.slice(PREFIX.length).trim();
  if (!raw) return;
  const parts = raw.split(/\s+/);
  const cmd = parts.shift().toLowerCase();
  const args = parts;

  try {
    // ---------- hostfriendly ----------
    if (cmd === 'hostfriendly') {
      // Permission: role or admin
      if (!message.member.roles.cache.has(HOST_ROLE_ID) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply('❌ You are not allowed to host friendlies.').catch(()=>{});
      }
      await handleHostFriendlyCommand(message, args);
      return;
    }

    // ---------- editlineup ----------
    if (cmd === 'editlineup') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('Only host can edit lineup.').catch(()=>{});
      const guildState = lineups.get(message.guild.id);
      if (!guildState) return message.reply('No active lineup.').catch(()=>{});
      const posArg = args[0];
      const mention = message.mentions.users.first();
      if (!posArg || !mention) return message.reply('Usage: `!editlineup <pos> @user`').catch(()=>{});
      editLineup(message.guild.id, posArg, mention.id);
      return message.reply(`✏️ Edited lineup: ${posArg} → <@${mention.id}>`).catch(()=>{});
    }

    // ---------- resetlineup ----------
    if (cmd === 'resetlineup') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('Only host can reset lineup.').catch(()=>{});
      lineups.delete(message.guild.id);
      return message.channel.send('♻️ Lineup reset.').catch(()=>{});
    }

    // ---------- checkfriendly ----------
    if (cmd === 'checkfriendly') {
      const mention = message.mentions.users.first();
      if (mention) {
        const cnt = getFriendlyCountForUser(message.guild.id, mention.id);
        return message.channel.send(`${mention.tag} has hosted friendlies ${cnt} time(s) in this server.`).catch(()=>{});
      }
      const counts = getFriendlyCountsForGuild(message.guild.id);
      const entries = Object.entries(counts);
      if (!entries.length) return message.channel.send('No hostfriendly records yet.').catch(()=>{});
      entries.sort((a,b) => b[1] - a[1]);
      const top = entries.slice(0,10);
      const lines = await Promise.all(top.map(async ([uid,c],i)=> {
        let tag = uid;
        try {
          const m = await message.guild.members.fetch(uid).catch(()=>null);
          if (m) tag = m.user.tag;
          else {
            const u = await client.users.fetch(uid).catch(()=>null);
            if (u) tag = u.tag;
          }
        } catch {}
        return `${i+1}. **${tag}** — ${c}`;
      }));
      const embed = new EmbedBuilder().setColor(0x9b59b6).setTitle('🏆 Hostfriendly leaderboard').setDescription(lines.join('\n'));
      return message.channel.send({ embeds: [embed] }).catch(()=>{});
    }

    // ---------- message (announcement) ----------
    if (cmd === 'message') {
      const content = args.join(' ');
      if (!content) return message.reply('Provide message text.').catch(()=>{});
      const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle('📢 Announcement').setDescription(content).setFooter({ text: `Sent by ${message.author.tag}`});
      return message.channel.send({ embeds: [embed] }).catch(()=>{});
    }

    // ---------- DMs ----------
    if (cmd === 'dmrole') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('Admins only.').catch(()=>{});
      const roleId = args.shift();
      const text = args.join(' ');
      if (!roleId || !text) return message.reply('Usage: `!dmrole <roleId> <message>`').catch(()=>{});
      const role = message.guild.roles.cache.get(roleId);
      if (!role) return message.reply('Role not found.').catch(()=>{});
      const members = await message.guild.members.fetch();
      let count = 0;
      for (const m of members.filter(m => m.roles.cache.has(role.id) && !m.user.bot).values()) {
        m.send(text).catch(()=>{});
        count++;
      }
      return message.channel.send(`📩 DMed ${count} members with role <@&${role.id}>.`).catch(()=>{});
    }

    if (cmd === 'dmall') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('Admins only.').catch(()=>{});
      const text = args.join(' ');
      if (!text) return message.reply('Usage: `!dmall <message>`').catch(()=>{});
      const members = await message.guild.members.fetch();
      let count = 0;
      for (const m of members.values()) {
        if (m.user.bot) continue;
        m.send(text).catch(()=>{});
        count++;
      }
      return message.channel.send(`📩 DMed ${count} members.`).catch(()=>{});
    }

    if (cmd === 'dm') {
      const user = message.mentions.users.first();
      const text = args.slice(1).join(' ');
      if (!user || !text) return message.reply('Usage: `!dm @user <message>`').catch(()=>{});
      user.send(text).catch(()=>{});
      return message.channel.send(`✅ DM sent to ${user.tag}`).catch(()=>{});
    }

    // ---------- activitycheck ----------
    if (cmd === 'activitycheck') {
      const goal = Math.max(1, parseInt(args[0],10) || 40);
      const emb = new EmbedBuilder().setColor(0x2b6cb0).setTitle('📊 Activity Check').setDescription(`React with ✅ to check in!\nGoal: **${goal}** members.`);
      const m = await message.channel.send({ content: '@here', embeds: [emb] }).catch(()=>null);
      if (m) await m.react('✅').catch(()=>{});
      return;
    }

    // ---------- Moderation ----------
    if (cmd === 'ban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('Missing BanMembers').catch(()=>{});
      const target = message.mentions.members.first();
      const reason = args.slice(1).join(' ') || 'No reason';
      if (!target) return message.reply('Usage: `!ban @user [reason]`').catch(()=>{});
      await target.ban({ reason }).catch(e => message.reply(`Failed: ${e.message}`).catch(()=>{}));
      await logToChannel(message.guild, `🚫 Ban: ${message.author.tag} -> ${target.user.tag} — ${reason}`);
      return message.channel.send(`🔨 Banned ${target.user.tag}`).catch(()=>{});
    }

    if (cmd === 'kick') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('Missing KickMembers').catch(()=>{});
      const target = message.mentions.members.first();
      const reason = args.slice(1).join(' ') || 'No reason';
      if (!target) return message.reply('Usage: `!kick @user [reason]`').catch(()=>{});
      await target.kick(reason).catch(e => message.reply(`Failed: ${e.message}`).catch(()=>{}));
      await logToChannel(message.guild, `👢 Kick: ${message.author.tag} -> ${target.user.tag} — ${reason}`);
      return message.channel.send(`👢 Kicked ${target.user.tag}`).catch(()=>{});
    }

    if (cmd === 'timeout') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('Missing ModerateMembers').catch(()=>{});
      const target = message.mentions.members.first();
      const seconds = parseInt(args[1] || args[0], 10);
      if (!target || Number.isNaN(seconds)) return message.reply('Usage: `!timeout @user <seconds>`').catch(()=>{});
      await target.timeout(seconds * 1000, `By ${message.author.tag}`).catch(e => message.reply(`Failed: ${e.message}`).catch(()=>{}));
      await logToChannel(message.guild, `⏲️ Timeout: ${message.author.tag} -> ${target.user.tag} (${seconds}s)`);
      return message.channel.send(`⏲️ Timed out ${target.user.tag} for ${seconds}s`).catch(()=>{});
    }

    // ---------- music: joinvc, leavevc, play, skip, stop, queue, loop ----------
    if (cmd === 'joinvc') {
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a voice channel first.').catch(()=>{});
      try {
        const conn = joinVoiceChannel({ channelId: vc.id, guildId: message.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
        await entersState(conn, VoiceConnectionStatus.Ready, 15_000).catch(()=>{});
        return message.channel.send('✅ Joined VC.').catch(()=>{});
      } catch (e) { return message.reply('Failed to join VC.').catch(()=>{}); }
    }
    if (cmd === 'leavevc') {
      const conn = getVoiceConnection(message.guild.id);
      if (conn) { conn.destroy(); return message.channel.send('👋 Left VC.').catch(()=>{}); }
      return message.reply('Not connected.').catch(()=>{});
    }

    if (cmd === 'play') {
      const url = args[0];
      if (!url) return message.reply('Usage: `!play <url or search term>`').catch(()=>{});
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a voice channel first.').catch(()=>{});
      let q = musicQueues.get(message.guild.id) || [];
      // resolve info using play-dl
      let info;
      try {
        if (play.is_expired()) await play.refreshToken(); // safe
        if (play.yt_validate(url) === 'video' || play.spotify_validate(url) || /^https?:\/\//.test(url)) {
          info = await play.video_info(url).catch(()=>null) || await play.search(url, { source: { youtube: 'ytsearch' } }).catch(()=>null);
        } else {
          // search
          const s = await play.search(url, { limit: 1 });
          info = s?.[0] || null;
        }
      } catch (e) {
        console.error('play lookup error', e);
      }
      // normalize
      let title = url;
      let resolvedUrl = url;
      if (info) {
        if (info.url) resolvedUrl = info.url;
        if (info.title) title = info.title;
        else if (info.video_details && info.video_details.title) title = info.video_details.title;
      }
      q.push({ title, url: resolvedUrl });
      musicQueues.set(message.guild.id, q);
      await message.channel.send(`➕ Queued **${title}**`).catch(()=>{});

      // connect if not
      let conn = getVoiceConnection(message.guild.id);
      if (!conn) {
        conn = joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
      }
      // create player if needed
      let player = audioPlayers.get(message.guild.id);
      if (!player) {
        player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
        audioPlayers.set(message.guild.id, player);
        conn.subscribe(player);
        player.on(AudioPlayerStatus.Idle, async () => {
          const cur = musicQueues.get(message.guild.id) || [];
          cur.shift();
          musicQueues.set(message.guild.id, cur);
          if (cur[0]) {
            await playTrack(message.guild.id, cur[0].url, message.channel);
          } else {
            message.channel.send('⏹️ Queue finished.').catch(()=>{});
          }
        });
        player.on('error', e => {
          console.error('Player error', e);
        });
      }

      // if first in queue, play now
      const curQ = musicQueues.get(message.guild.id) || [];
      if (curQ.length === 1) await playTrack(message.guild.id, curQ[0].url, message.channel);
      return;
    }

    if (cmd === 'skip') {
      const player = audioPlayers.get(message.guild.id);
      if (!player) return message.reply('Nothing playing.').catch(()=>{});
      player.stop(true);
      return message.channel.send('⏭️ Skipped.').catch(()=>{});
    }
    if (cmd === 'stop') {
      musicQueues.set(message.guild.id, []);
      audioPlayers.get(message.guild.id)?.stop(true);
      getVoiceConnection(message.guild.id)?.destroy();
      return message.channel.send('⏹️ Stopped & cleared queue.').catch(()=>{});
    }
    if (cmd === 'queue') {
      const q = musicQueues.get(message.guild.id) || [];
      if (!q.length) return message.channel.send('Queue empty.').catch(()=>{});
      return message.channel.send(q.map((s,i)=>`${i+1}. ${s.title}`).join('\n')).catch(()=>{});
    }
    if (cmd === 'loop') {
      const q = musicQueues.get(message.guild.id) || [];
      // simple toggle stored on map as boolean property
      const cur = q._loop || false;
      q._loop = !cur;
      musicQueues.set(message.guild.id, q);
      return message.channel.send(`Loop is now ${q._loop ? 'on' : 'off'}`).catch(()=>{});
    }

    // ---------- economy & games minimal ----------
    ensureUser(message.author.id);
    if (cmd === 'start') return message.reply(`You have ${getBal(message.author.id)} Robux.`).catch(()=>{});
    if (cmd === 'bal' || cmd === 'balance') return message.reply(`${message.author}, your balance: **${getBal(message.author.id)} Robux**`).catch(()=>{});
    if (cmd === 'give') {
      const target = message.mentions.users.first();
      const amt = parseInt(args[1] || args[0], 10);
      if (!target || Number.isNaN(amt) || amt <= 0) return message.reply('Usage: `!give @user <amount>`').catch(()=>{});
      if (getBal(message.author.id) < amt) return message.reply('Insufficient funds.').catch(()=>{});
      subBal(message.author.id, amt);
      addBal(target.id, amt);
      return message.reply(`✅ Sent ${amt} Robux to ${target.tag}.`).catch(()=>{});
    }

  } catch (err) {
    console.error('Command error', err);
  }
});

// ----- Slash commands registration -----
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const commands = [
    new SlashCommandBuilder().setName('hostfriendly').setDescription('Post a hostfriendly lineup')
      .addStringOption(opt => opt.setName('position').setDescription('Optional: preclaim a position (GK,CB,CB2,CM,LW,RW,ST)')),
    new SlashCommandBuilder().setName('play').setDescription('Play a track (YouTube/Spotify)').addStringOption(opt => opt.setName('query').setDescription('URL or search term').setRequired(true))
  ].map(c => c.toJSON());
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

// ----- Slash command handling -----
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'hostfriendly') {
      // check permissions
      const pos = interaction.options.getString('position');
      if (!interaction.member.roles.cache.has(HOST_ROLE_ID) && !interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({ content: 'No permission', ephemeral: true });
      }
      // simulate prefix flow by creating a pseudo message object
      const pseudo = {
        author: interaction.user,
        guild: interaction.guild,
        member: interaction.member,
        channel: { send: (c) => interaction.channel.send(c) },
        content: `${PREFIX}hostfriendly ${pos || ''}`
      };
      await interaction.reply({ content: 'Posting hostfriendly...', ephemeral: true });
      // re-use the prefix handler by calling the helper
      await handleHostFriendlyCommand(pseudo, pos ? [pos] : []);
      return;
    }
    if (interaction.commandName === 'play') {
      const query = interaction.options.getString('query');
      // create pseudo message for reuse
      const pseudo = {
        author: interaction.user,
        guild: interaction.guild,
        member: interaction.member,
        channel: interaction.channel,
        content: `${PREFIX}play ${query}`
      };
      await interaction.reply({ content: `Queued: ${query}`, ephemeral: true });
      // call the same handler
      const mEvent = { ...pseudo };
      await client.emit(Events.MessageCreate, mEvent);
      return;
    }
  } catch (e) {
    console.error('Slash handler error', e);
  }
});

// ----- Hostfriendly helpers -----
const POSITIONS = ['GK','CB','CB2','CM','LW','RW','ST'];
const EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];

async function handleHostFriendlyCommand(messageLike, args) {
  const guildId = messageLike.guild.id;
  // if a lineup exists, ignore or reset? we'll create a new lineup
  const positions = POSITIONS.slice();
  const numbers = EMOJIS.slice();
  const taken = Array(positions.length).fill(null);
  const lineup = {}; // userId -> index

  // preclaim
  if (args && args[0]) {
    const a = String(args[0]).toLowerCase();
    let idx = -1;
    if (!Number.isNaN(Number(a))) idx = parseInt(a,10)-1;
    else idx = positions.findIndex(p => p.toLowerCase() === a);
    if (idx >= 0 && idx < positions.length) {
      taken[idx] = messageLike.author.id;
      lineup[messageLike.author.id] = idx;
    }
  }

  const buildEmbed = (state) => {
    const lines = state.positions.map((pos,i) => `${state.numbers[i]} ➜ **${pos}**\n${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n\n');
    const final = state.positions.map((pos,i) => `${pos}: ${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n');
    return new EmbedBuilder().setColor(0x00a86b).setTitle('AGNELLO FC 7v7 FRIENDLY').setDescription(lines + '\n\nReact to claim. Host can edit with `!editlineup` or `!resetlineup`.\n\n✅ **Final Lineup:**\n' + final);
  };

  // send lineup message
  const channel = (messageLike.channel.send) ? messageLike.channel : messageLike.channel;
  const msg = await (messageLike.channel.send ? messageLike.channel.send({ content: '@here', embeds: [buildEmbed({positions,numbers,taken,lineup})] }) : null);
  if (!msg) {
    // in slash flow, messageLike.channel is an APIChannel, we'll fallback:
    const ch = await messageLike.guild.channels.fetch(messageLike.guild.systemChannelId).catch(()=>null);
    if (!ch) return;
    const fallback = await ch.send({ content: '@here', embeds: [buildEmbed({positions,numbers,taken,lineup})] }).catch(()=>null);
    if (!fallback) return;
    // set msg to fallback
    msg = fallback;
  }

  // react 1-7
  for (const e of numbers) await msg.react(e).catch(()=>{});

  // store state
  const state = { messageId: msg.id, channelId: msg.channel.id || (msg.channelId || null), positions, numbers, taken, lineup, collecting: true, hostId: messageLike.author.id, hostChannelId: (messageLike.channel.id || messageLike.channelId) };
  lineups.set(guildId, state);

  // increment host friendly count for host
  incrementFriendlyCount(guildId, messageLike.author.id);

  // collector
  const collector = msg.createReactionCollector({ time: 600000 });
  collector.on('collect', async (reaction, user) => {
    if (user.bot) return reaction.users.remove(user.id).catch(()=>{});
    const pos = state.positions[state.numbers.indexOf(reaction.emoji.name)];
    if (!pos) return reaction.users.remove(user.id).catch(()=>{});
    const posIndex = state.numbers.indexOf(reaction.emoji.name);
    if (state.taken[posIndex]) { return reaction.users.remove(user.id).catch(()=>{}); }
    if (state.lineup[user.id] !== undefined) { return reaction.users.remove(user.id).catch(()=>{}); }
    // claim
    state.taken[posIndex] = user.id;
    state.lineup[user.id] = posIndex;
    try { await user.send(`✅ Confirmed: ${pos} (Hostfriendly)`).catch(()=>{}); } catch {}
    await (msg.edit ? msg.edit({ embeds: [buildEmbed(state)] }) : null).catch(()=>{});
    await messageLike.guild.channels.fetch(state.channelId).then(ch => ch.send(`✅ ${pos} claimed by <@${user.id}>`)).catch(()=>{});
    // if full
    if (state.taken.every(x => x)) {
      collector.stop('filled');
    }
  });

  collector.on('end', async (_, reason) => {
    state.collecting = false;
    if (reason !== 'filled') {
      await messageLike.guild.channels.fetch(state.channelId).then(ch => ch.send('❌ Friendly cancelled.')).catch(()=>{});
      lineups.delete(guildId);
      return;
    }
    // final
    const finalText = state.positions.map((p,i) => `${p}: <@${state.taken[i]}>`).join('\n');
    await messageLike.guild.channels.fetch(state.channelId).then(ch => ch.send(`**FINAL LINEUP:**\n${finalText}`)).catch(()=>{});
    // ask host for roblox link via DM
    const host = await client.users.fetch(state.hostId).catch(()=>null);
    if (!host) {
      // notify in channel
      await messageLike.guild.channels.fetch(state.channelId).then(ch => ch.send(`Host <@${state.hostId}>: please DM me the Roblox link in this channel.`)).catch(()=>{});
      return;
    }
    try {
      await host.send('Friendly lineup is full. Please reply with the ROBLOX link (must start with https://) and I will DM it to the lineup. You have 5 minutes.').catch(()=>{});
      // create a message collector on host's DM
      const dmChannel = await host.createDM();
      const dmColl = dmChannel.createMessageCollector({ filter: m => m.author.id === state.hostId, time: 5*60*1000, max: 1 });
      dmColl.on('collect', async (m) => {
        const link = m.content.trim();
        if (!/^https?:\/\//.test(link)) {
          return host.send('That does not look like a valid link. Please run !hostfriendly again and try.').catch(()=>{});
        }
        // DM all final players
        for (const uid of state.taken) {
          client.users.send(uid, `Here’s the friendly ROBLOX link from <@${state.hostId}>:\n${link}`).catch(()=>{});
        }
        await host.send('Link sent to lineup.').catch(()=>{});
      });
      dmColl.on('end', (_, reason2) => {
        if (reason2 === 'time') {
          host.send('Timed out waiting for the link.').catch(()=>{});
        }
      });
    } catch (e) {
      // fallback notify in channel
      await messageLike.guild.channels.fetch(state.channelId).then(ch => ch.send(`Host <@${state.hostId}>, please post the ROBLOX link here or DM it to someone.`)).catch(()=>{});
    }
  });
}

// helper to edit lineup position via posArg which can be number or position name
function editLineup(guildId, posArg, userId) {
  const state = lineups.get(guildId);
  if (!state) return false;
  const a = String(posArg).toLowerCase();
  let idx = -1;
  if (!Number.isNaN(Number(a))) idx = parseInt(a,10)-1;
  else idx = state.positions.findIndex(p => p.toLowerCase() === a);
  if (idx < 0 || idx >= state.positions.length) return false;
  // remove previous occupant of that pos
  if (state.taken[idx]) {
    delete state.lineup[state.taken[idx]];
  }
  // if user was in another spot, free it
  if (state.lineup[userId] !== undefined) {
    const old = state.lineup[userId];
    state.taken[old] = null;
  }
  state.taken[idx] = userId;
  state.lineup[userId] = idx;
  // edit posted message if possible
  (async () => {
    try {
      const ch = await client.channels.fetch(state.channelId).catch(()=>null);
      if (!ch) return;
      const msg = await ch.messages.fetch(state.messageId).catch(()=>null);
      if (!msg) return;
      const embed = new EmbedBuilder().setColor(0x00a86b).setTitle('AGNELLO FC 7v7 FRIENDLY (Updated)')
        .setDescription(state.positions.map((pos,i)=> `${state.numbers[i]} ➜ **${pos}**\n${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n\n'));
      await msg.edit({ embeds: [embed] }).catch(()=>{});
    } catch {}
  })();
  return true;
}

// ----- Music playback helper -----
async function playTrack(guildId, url, textChannel) {
  try {
    const conn = getVoiceConnection(guildId);
    if (!conn) { await textChannel.send('⚠️ Not connected to a VC.'); return; }
    const stream = await play.stream(url, { discordPlayerCompatibility: true }).catch(async (e) => {
      // fallback: search and play first hit
      const s = await play.search(url, { limit: 1 }).catch(()=>null);
      if (s && s[0]) return await play.stream(s[0].url);
      throw e;
    });
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    let player = audioPlayers.get(guildId);
    if (!player) {
      player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
      audioPlayers.set(guildId, player);
      conn.subscribe(player);
    }
    player.play(resource);
    const infoTitle = stream.title || url;
    await textChannel.send(`🎶 Playing **${infoTitle}**`).catch(()=>{});
  } catch (e) {
    console.error('playTrack error', e);
    await textChannel.send(`Failed to play: ${e.message || String(e)}`).catch(()=>{});
  }
}

// ----- Auto-join voice when someone joins -----
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    // when someone joins a voice channel (oldState.channel was null, newState.channel not null)
    if (!oldState.channel && newState.channel && !newState.member.user.bot) {
      // try to join their channel (if not already there)
      const guildId = newState.guild.id;
      const conn = getVoiceConnection(guildId);
      if (conn && conn.joinConfig.channelId === newState.channelId) return;
      try {
        const joinConn = joinVoiceChannel({
          channelId: newState.channelId,
          guildId: newState.guild.id,
          adapterCreator: newState.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false
        });
        // attempt to reach Ready
        await entersState(joinConn, VoiceConnectionStatus.Ready, 10_000).catch(()=>{});
        await logToChannel(newState.guild, `🔊 Auto-joined voice channel ${newState.channel.name} because ${newState.member.user.tag} joined.`);
      } catch (e) {
        // ignore join failures
      }
    }
  } catch (e) {
    console.error('VoiceStateUpdate error', e);
  }
});

// ----- Simple Register & start keepalive server -----
const app = express();
app.get('/', (_, res) => res.send('Agnello FC Bot is alive'));
app.listen(KEEPALIVE_PORT, () => console.log(`Keepalive server listening on ${KEEPALIVE_PORT}`));

// ----- Error handlers & login -----
process.on('unhandledRejection', (r) => console.error('Unhandled Rejection', r));
process.on('uncaughtException', (err) => console.error('Uncaught Exception', err));

client.login(TOKEN).catch(err => {
  console.error('Failed to login:', err);
  process.exit(1);
});
