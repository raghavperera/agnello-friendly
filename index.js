// index.js
// Agnello FC Friendly Bot — v14, ESM
// Node 18+
// Requirements: set env vars TOKEN, CLIENT_ID, GUILD_ID
// Optional: HOST_ROLE_ID (defaults to the Friendly Hoster role you provided)
// Note: enable Server Members Intent and Message Content Intent in the Discord dev portal.

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
  SlashCommandBuilder,
  ButtonBuilder,
  ActionRowBuilder,
  ButtonStyle
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- config ----------
const TOKEN = process.env.TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const HOST_ROLE_ID = process.env.HOST_ROLE_ID || '1402167943747342348'; // override if needed
const PREFIX = '!';
const LOG_CHANNEL_ID = '1362214241091981452'; // logging channel per request
const KEEPALIVE_PORT = process.env.PORT || 10000;

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing env vars. Set TOKEN, CLIENT_ID, GUILD_ID.');
  process.exit(1);
}

// ---------- simple JSON persistence helpers ----------
function loadJson(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
      return fallback;
    }
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error('loadJson error', file, e);
    return fallback;
  }
}
function saveJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch (e) { console.error('saveJson error', e); }
}
const ECON_FILE = path.join(__dirname, 'economy.json');
const FCOUNTS_FILE = path.join(__dirname, 'friendly_counts.json');
let ECON = loadJson(ECON_FILE, {});
let FRIENDLY_COUNTS = loadJson(FCOUNTS_FILE, {});

// economy helpers
function ensureUser(id) { if (!ECON[id]) ECON[id] = { balance: 10 }; saveJson(ECON_FILE, ECON); return ECON[id]; }
function getBal(id) { return (ensureUser(id).balance || 0); }
function addBal(id, n) { ensureUser(id); ECON[id].balance = Math.max(0, Math.floor((ECON[id].balance || 0) + n)); saveJson(ECON_FILE, ECON); return ECON[id].balance; }
function subBal(id, n) { ensureUser(id); ECON[id].balance = Math.max(0, Math.floor((ECON[id].balance || 0) - n)); saveJson(ECON_FILE, ECON); return ECON[id].balance; }

// friendly counts
function incrementFriendlyCount(gId, uId) {
  FRIENDLY_COUNTS[gId] = FRIENDLY_COUNTS[gId] || {};
  FRIENDLY_COUNTS[gId][uId] = (FRIENDLY_COUNTS[gId][uId] || 0) + 1;
  saveJson(FCOUNTS_FILE, FRIENDLY_COUNTS);
}
function getFriendlyCountForUser(gId, uId) { return (FRIENDLY_COUNTS[gId] && FRIENDLY_COUNTS[gId][uId]) || 0; }
function getFriendlyCountsForGuild(gId) { return FRIENDLY_COUNTS[gId] || {}; }

// ---------- utilities ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const POSITIONS = ['GK','CB','CB2','CM','LW','RW','ST'];
const EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];

// ---------- in-memory stores ----------
const lineups = new Map(); // guildId => state
const musicQueues = new Map(); // guildId => [{ title, url }]
const audioPlayers = new Map(); // guildId => audio player object
const textWarnings = new Map();

// ---------- client ----------
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

// ---------- logger helper ----------
async function safeLog(guild, content) {
  try {
    if (!guild) return;
    const ch = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (ch) await ch.send({ content }).catch(()=>{});
  } catch {}
}

// ---------- keepalive web server (useful on hosts like Render) ----------
const app = express();
app.get('/', (_,res) => res.send('Agnello FC Bot alive'));
app.listen(KEEPALIVE_PORT, () => console.log(`Keepalive listening on ${KEEPALIVE_PORT}`));

// ---------- ready & slash register ----------
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try { await registerSlashCommands(); console.log('Slash commands registered'); } catch (e) { console.warn('Slash register failed', e); }
});

// ---------- slash command registration (guild scope for fast updates) ----------
async function registerSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  const commands = [
    new SlashCommandBuilder().setName('hostfriendly').setDescription('Post a hostfriendly lineup').addStringOption(opt => opt.setName('position').setDescription('Optional preclaim position')),
    new SlashCommandBuilder().setName('play').setDescription('Play a track (YouTube or Spotify URL or search)').addStringOption(opt => opt.setName('query').setDescription('URL or search term').setRequired(true)),
    new SlashCommandBuilder().setName('activitycheck').setDescription('Create activity check').addIntegerOption(opt=>opt.setName('goal').setDescription('Target number')),
    new SlashCommandBuilder().setName('editlineup').setDescription('Edit a lineup slot').addStringOption(opt=>opt.setName('pos').setDescription('pos name or number').setRequired(true)).addUserOption(opt=>opt.setName('user').setDescription('user to set').setRequired(true))
  ].map(c => c.toJSON());
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
}

// ---------- slash interaction handling ----------
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'hostfriendly') {
      const pos = interaction.options.getString('position');
      // check role
      const hasRole = interaction.member.roles.cache.has(HOST_ROLE_ID) || interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
      if (!hasRole) return interaction.reply({ content: 'No permission', ephemeral: true });
      await interaction.reply({ content: 'Posting hostfriendly...', ephemeral: true });
      // craft a message-like object for reuse
      const pseudo = {
        author: interaction.user,
        guild: interaction.guild,
        member: interaction.member,
        channel: interaction.channel,
        channelId: interaction.channelId,
        content: `${PREFIX}hostfriendly ${pos || ''}`,
        reply: (c) => interaction.followUp({ content: typeof c === 'string' ? c : c.content, ephemeral: true })
      };
      await handleHostFriendly(pseudo, pos ? [pos] : []);
      return;
    }

    if (interaction.commandName === 'play') {
      const q = interaction.options.getString('query');
      // if user is in voice channel, queue in that guild
      const member = interaction.member;
      const pseudo = {
        author: interaction.user,
        guild: interaction.guild,
        member,
        channel: interaction.channel,
        channelId: interaction.channelId,
        content: `${PREFIX}play ${q}`,
        reply: (c) => interaction.reply({ content: typeof c === 'string' ? c : c.content, ephemeral: true })
      };
      await interaction.reply({ content: `Queued: ${q}`, ephemeral: true }).catch(()=>{});
      // call same handler as prefix
      await handlePlayCommand(pseudo, q);
      return;
    }

    if (interaction.commandName === 'activitycheck') {
      const goal = interaction.options.getInteger('goal') || 40;
      const emb = new EmbedBuilder().setColor(0x2b6cb0).setTitle('📊 Activity Check').setDescription(`React with ✅ to check in!\nGoal: **${goal}** members.`);
      const m = await interaction.channel.send({ content: '@here', embeds: [emb] }).catch(()=>null);
      if (m) await m.react('✅').catch(()=>{});
      return interaction.reply({ content: 'Activity check posted', ephemeral: true });
    }

    if (interaction.commandName === 'editlineup') {
      const posArg = interaction.options.getString('pos');
      const user = interaction.options.getUser('user');
      if (!interaction.member.roles.cache.has(HOST_ROLE_ID)) return interaction.reply({ content: 'Only host may edit', ephemeral: true });
      const ok = editLineup(interaction.guild.id, posArg, user.id);
      return interaction.reply({ content: ok ? 'Lineup updated' : 'Failed to update', ephemeral: true });
    }
  } catch (e) {
    console.error('Slash handle error', e);
  }
});

// ---------- Prefix command handling ----------
client.on(Events.MessageCreate, async message => {
  if (message.author.bot || !message.guild || !message.content) return;

  // react to @everyone/@here
  if ((message.mentions.everyone || message.content.includes('@here')) && !message.author.bot) {
    try { await message.react('✅'); } catch {}
  }

  // profanity filter
  const lowered = message.content.toLowerCase();
  const SWEARS = ['fuck','shit','bitch','asshole','bastard','damn','crap','idiot','stfu','wtf','sucks'];
  if (SWEARS.some(w => lowered.includes(w))) {
    try {
      await message.delete().catch(()=>{});
      const cnt = (textWarnings.get(message.author.id) || 0) + 1;
      textWarnings.set(message.author.id, cnt);
      await message.author.send(`Your message in ${message.guild.name} was removed for language. Warning #${cnt}`).catch(()=>{});
      await safeLog(message.guild, `Profanity: ${message.author.tag} — ${message.content}`);
      // small optional VC mute if in voice
      const member = message.member;
      if (member && member.voice?.channel && member.manageable) {
        await member.voice.setMute(true, 'Auto-moderation: swearing').catch(()=>{});
        setTimeout(()=>member.voice?.setMute(false, 'Auto moderation expired').catch(()=>{}), 10_000);
      }
    } catch {}
    return;
  }

  if (!message.content.startsWith(PREFIX)) return;
  const raw = message.content.slice(PREFIX.length).trim();
  if (!raw) return;
  const parts = raw.split(/\s+/);
  const cmd = parts.shift().toLowerCase();
  const args = parts;

  try {
    // hostfriendly
    if (cmd === 'hostfriendly') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply('❌ You are not allowed to host friendlies.');
      }
      await handleHostFriendly(message, args);
      return;
    }

    // editlineup
    if (cmd === 'editlineup') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('Only host may edit.');
      const posArg = args[0];
      const mention = message.mentions.users.first();
      if (!posArg || !mention) return message.reply('Usage: !editlineup <pos> @user');
      const ok = editLineup(message.guild.id, posArg, mention.id);
      return message.reply(ok ? 'Edited lineup.' : 'Failed to edit.');
    }

    // resetlineup
    if (cmd === 'resetlineup') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('Only host may reset.');
      lineups.delete(message.guild.id);
      return message.channel.send('Lineup reset.');
    }

    // checkfriendly
    if (cmd === 'checkfriendly') {
      const mention = message.mentions.users.first();
      if (mention) {
        const cnt = getFriendlyCountForUser(message.guild.id, mention.id);
        return message.channel.send(`${mention.tag} has hosted friendlies ${cnt} time(s).`);
      }
      const counts = getFriendlyCountsForGuild(message.guild.id);
      const entries = Object.entries(counts);
      if (!entries.length) return message.channel.send('No records yet.');
      entries.sort((a,b)=>b[1]-a[1]);
      const lines = entries.slice(0,10).map(([id,c],i)=> `${i+1}. <@${id}> — ${c}`);
      return message.channel.send({ embeds: [ new EmbedBuilder().setTitle('Hostfriendly leaderboard').setDescription(lines.join('\n')) ] });
    }

    // message (announcement)
    if (cmd === 'message') {
      if (!args.length) return message.reply('Provide message text.');
      const embed = new EmbedBuilder().setColor(0x2ecc71).setTitle('Announcement').setDescription(args.join(' ')).setFooter({ text: `Sent by ${message.author.tag}`});
      return message.channel.send({ embeds: [embed] });
    }

    // dmrole
    if (cmd === 'dmrole') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('Admins only.');
      const roleId = args.shift();
      const text = args.join(' ');
      if (!roleId || !text) return message.reply('Usage: !dmrole <roleId> <message>');
      const role = message.guild.roles.cache.get(roleId);
      if (!role) return message.reply('Role not found.');
      const members = await message.guild.members.fetch();
      let count = 0;
      for (const m of members.filter(m => m.roles.cache.has(role.id) && !m.user.bot).values()) {
        m.send(text).catch(()=>{});
        count++;
      }
      return message.channel.send(`DMed ${count} members with role <@&${role.id}>.`);
    }

    // dmall
    if (cmd === 'dmall') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('Admins only.');
      const text = args.join(' ');
      if (!text) return message.reply('Usage: !dmall <message>');
      const members = await message.guild.members.fetch();
      let count = 0;
      for (const m of members.values()) {
        if (m.user.bot) continue;
        m.send(text).catch(()=>{});
        count++;
      }
      return message.channel.send(`DMed ${count} members.`);
    }

    // dm
    if (cmd === 'dm') {
      const u = message.mentions.users.first();
      const text = args.slice(1).join(' ');
      if (!u || !text) return message.reply('Usage: !dm @user <message>');
      u.send(text).catch(()=>{});
      return message.channel.send(`DM sent to ${u.tag}`);
    }

    // activitycheck
    if (cmd === 'activitycheck') {
      const goal = Math.max(1, parseInt(args[0],10) || 40);
      const emb = new EmbedBuilder().setColor(0x2b6cb0).setTitle('Activity Check').setDescription(`React with ✅ to check in!\nGoal: **${goal}** members.`);
      const m = await message.channel.send({ content: '@here', embeds: [emb] }).catch(()=>null);
      if (m) await m.react('✅').catch(()=>{});
      return;
    }

    // moderation: ban,kick,timeout
    if (cmd === 'ban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('Missing permission.');
      const target = message.mentions.members.first();
      const reason = args.slice(1).join(' ') || 'No reason';
      if (!target) return message.reply('Usage: !ban @user [reason]');
      await target.ban({ reason }).catch(e => message.reply(`Failed: ${e.message}`));
      await safeLog(message.guild, `Ban: ${message.author.tag} -> ${target.user.tag} — ${reason}`);
      return message.channel.send(`Banned ${target.user.tag}`);
    }
    if (cmd === 'kick') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('Missing permission.');
      const target = message.mentions.members.first();
      const reason = args.slice(1).join(' ') || 'No reason';
      if (!target) return message.reply('Usage: !kick @user [reason]');
      await target.kick(reason).catch(e => message.reply(`Failed: ${e.message}`));
      await safeLog(message.guild, `Kick: ${message.author.tag} -> ${target.user.tag} — ${reason}`);
      return message.channel.send(`Kicked ${target.user.tag}`);
    }
    if (cmd === 'timeout') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('Missing permission.');
      const target = message.mentions.members.first();
      const seconds = parseInt(args[1] || args[0], 10);
      if (!target || Number.isNaN(seconds)) return message.reply('Usage: !timeout @user <seconds>');
      await target.timeout(seconds * 1000, `By ${message.author.tag}`).catch(e => message.reply(`Failed: ${e.message}`));
      await safeLog(message.guild, `Timeout: ${message.author.tag} -> ${target.user.tag} (${seconds}s)`);
      return message.channel.send(`Timed out ${target.user.tag} for ${seconds}s`);
    }

    // music commands
    if (cmd === 'joinvc') {
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a voice channel first.');
      const conn = joinVoiceChannel({ channelId: vc.id, guildId: message.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
      try { await entersState(conn, VoiceConnectionStatus.Ready, 15_000); return message.channel.send('Joined VC.'); } catch (e) { return message.reply('Failed to join VC.'); }
    }
    if (cmd === 'leavevc') {
      const conn = getVoiceConnection(message.guild.id);
      if (!conn) return message.reply('Not connected.');
      conn.destroy();
      return message.channel.send('Left VC.');
    }
    if (cmd === 'play') {
      const query = args.join(' ');
      await handlePlayCommand(message, query);
      return;
    }
    if (cmd === 'skip') {
      const player = audioPlayers.get(message.guild.id);
      if (!player) return message.reply('Nothing playing.');
      player.stop(true);
      return message.channel.send('Skipped.');
    }
    if (cmd === 'stop') {
      musicQueues.set(message.guild.id, []);
      audioPlayers.get(message.guild.id)?.stop(true);
      getVoiceConnection(message.guild.id)?.destroy();
      return message.channel.send('Stopped & cleared queue.');
    }
    if (cmd === 'queue') {
      const q = musicQueues.get(message.guild.id) || [];
      if (!q.length) return message.channel.send('Queue empty.');
      return message.channel.send(q.map((s,i)=>`${i+1}. ${s.title}`).join('\n'));
    }
    if (cmd === 'loop') {
      const q = musicQueues.get(message.guild.id) || [];
      q._loop = !q._loop;
      musicQueues.set(message.guild.id, q);
      return message.channel.send(`Loop is now ${q._loop ? 'on' : 'off'}`);
    }

    // economy & simple games minimal (kept)
    ensureUser(message.author.id);
    if (cmd === 'start') return message.reply(`You have ${getBal(message.author.id)} Robux.`);
    if (cmd === 'bal' || cmd === 'balance') return message.reply(`${message.author}, your balance: **${getBal(message.author.id)} Robux**`);
    if (cmd === 'give') {
      const target = message.mentions.users.first();
      const amt = parseInt(args[1] || args[0], 10);
      if (!target || Number.isNaN(amt) || amt <= 0) return message.reply('Usage: !give @user <amount>');
      if (getBal(message.author.id) < amt) return message.reply('Insufficient funds.');
      subBal(message.author.id, amt);
      addBal(target.id, amt);
      return message.reply(`Sent ${amt} Robux to ${target.tag}.`);
    }

  } catch (err) {
    console.error('Prefix command error', err);
  }
});

// ---------- handlePlayCommand (shared by slash & prefix) ----------
async function handlePlayCommand(messageLike, query) {
  try {
    if (!query) return messageLike.reply?.('Usage: play <url or search>') || null;
    // find voice channel
    const member = messageLike.member;
    if (!member || !member.voice?.channel) {
      return messageLike.reply?.('Join a voice channel first.') || null;
    }
    const vc = member.voice.channel;
    // resolve: spotify link or youtube url or search
    let resolvedUrl = null;
    let title = query;
    // try spotify
    try {
      if (play.spotify_validate(query) === 'track' || /open\.spotify\.com/.test(query)) {
        // get spotify info then search youtube for it
        const s = await play.spotify(query).catch(()=>null);
        if (s && s.name) {
          const search = `${s.name} ${s.artists?.map(a=>a.name).join(' ') || ''}`;
          const r = await play.search(search, { limit: 1 }).catch(()=>null);
          if (r && r.length) { resolvedUrl = r[0].url; title = `${s.name} — ${s.artists?.map(a=>a.name).join(', ') || ''}`; }
        }
      }
    } catch (e) {
      // ignore spotify failures, fallback to other methods
    }
    // if not spotify resolved, check if yt url or other url
    if (!resolvedUrl) {
      if (/^https?:\/\/(www\.)?youtube\.com|youtu\.be/.test(query)) {
        resolvedUrl = query;
        try { const info = await play.video_info(query).catch(()=>null); if (info && info.title) title = info.title; } catch {}
      } else if (/^https?:\/\//.test(query)) {
        // unknown URL; try play-dl info
        try {
          const info = await play.video_info(query).catch(()=>null);
          if (info) { resolvedUrl = info.url || query; title = info.title || query; }
          else resolvedUrl = query;
        } catch { resolvedUrl = query; }
      } else {
        // search YouTube via play-dl
        const s = await play.search(query, { source: { youtube: 'ytsearch' }, limit: 1 }).catch(()=>null);
        if (s && s.length) { resolvedUrl = s[0].url; title = s[0].title || query; }
      }
    }
    if (!resolvedUrl) return messageLike.reply?.('Could not find that track') || null;

    // push to queue
    const guildId = messageLike.guild.id;
    const q = musicQueues.get(guildId) || [];
    q.push({ title, url: resolvedUrl });
    musicQueues.set(guildId, q);
    await (messageLike.channel?.send ? messageLike.channel.send(`Queued: **${title}**`) : null).catch(()=>{});

    // connect
    let conn = getVoiceConnection(guildId);
    if (!conn) {
      conn = joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
      try { await entersState(conn, VoiceConnectionStatus.Ready, 15_000); } catch {}
    }
    // ensure player
    let player = audioPlayers.get(guildId);
    if (!player) {
      player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
      audioPlayers.set(guildId, player);
      conn.subscribe(player);
      player.on(AudioPlayerStatus.Idle, async () => {
        const cur = musicQueues.get(guildId) || [];
        // loop support
        if (!cur._loop) cur.shift();
        musicQueues.set(guildId, cur);
        if (cur[0]) {
          await playTrack(guildId, cur[0].url, messageLike.channel);
        } else {
          try { await messageLike.channel?.send('Queue finished.').catch(()=>{}); } catch {}
        }
      });
      player.on('error', e => console.error('Audio player error', e));
    }
    // if first in queue, play immediately
    if (q.length === 1) await playTrack(guildId, resolvedUrl, messageLike.channel);
    return;
  } catch (e) {
    console.error('handlePlayCommand error', e);
    try { messageLike.reply?.('Error while queuing track.').catch(()=>{}); } catch {}
  }
}

// ---------- playTrack ----------
async function playTrack(guildId, url, textChannel) {
  try {
    const conn = getVoiceConnection(guildId);
    if (!conn) { await textChannel.send('Not connected to a VC.'); return; }
    // play-dl stream
    // ensure ffmpeg and opus are present on host
    const stream = await play.stream(url, { discordPlayerCompatibility: true }).catch(async (err) => {
      // fallback search for query
      const s = await play.search(url, { limit: 1 }).catch(()=>null);
      if (s && s[0]) return await play.stream(s[0].url);
      throw err;
    });
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    const player = audioPlayers.get(guildId);
    if (!player) {
      const p = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
      audioPlayers.set(guildId, p);
      conn.subscribe(p);
      p.play(resource);
    } else {
      player.play(resource);
    }
    const title = stream.title || url;
    await textChannel.send(`Now playing: **${title}**`).catch(()=>{});
  } catch (e) {
    console.error('playTrack error', e);
    await textChannel.send(`Failed to play: ${e?.message || String(e)}`).catch(()=>{});
  }
}

// ---------- auto join voice when someone joins (small server behavior) ----------
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  try {
    // join when a non-bot user joins a channel and the bot is not in it
    if (!oldState.channel && newState.channel && !newState.member.user.bot) {
      const guildId = newState.guild.id;
      const conn = getVoiceConnection(guildId);
      if (conn && conn.joinConfig.channelId === newState.channelId) return;
      try {
        const jc = joinVoiceChannel({
          channelId: newState.channelId,
          guildId: newState.guild.id,
          adapterCreator: newState.guild.voiceAdapterCreator,
          selfMute: false,
          selfDeaf: false
        });
        await entersState(jc, VoiceConnectionStatus.Ready, 10_000).catch(()=>{});
        await safeLog(newState.guild, `Auto-joined ${newState.channel.name} for ${newState.member.user.tag}`);
      } catch (e) {
        // ignore
      }
    }
  } catch (e) { console.error('VoiceStateUpdate error', e); }
});

// ---------- hostfriendly handler ----------
async function handleHostFriendly(messageLike, args) {
  const guild = messageLike.guild;
  const guildId = guild.id;
  // create new state
  const positions = POSITIONS.slice();
  const numbers = EMOJIS.slice();
  const taken = Array(positions.length).fill(null);
  const lineup = {}; // userId -> index
  const hostId = messageLike.author.id;

  // preclaim if provided
  if (args && args[0]) {
    const a = String(args[0]).toLowerCase();
    let idx = -1;
    if (!Number.isNaN(Number(a))) idx = parseInt(a, 10) - 1;
    else idx = positions.findIndex(p => p.toLowerCase() === a);
    if (idx >= 0 && idx < positions.length) {
      taken[idx] = hostId;
      lineup[hostId] = idx;
    }
  }

  // build embed
  const buildEmbed = (state) => {
    const lines = state.positions.map((p,i) => `${state.numbers[i]} → **${p}**\n${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n\n');
    const final = state.positions.map((p,i) => `${p}: ${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n');
    return new EmbedBuilder().setColor(0x00a86b).setTitle('AGNELLO FC 7v7 FRIENDLY').setDescription(lines + '\n\nReact to claim. Host can !editlineup or !resetlineup.\n\n✅ **Final Lineup:**\n' + final);
  };

  // send message
  const sendChannel = messageLike.channel;
  let posted;
  try {
    posted = await sendChannel.send({ content: '@here', embeds: [buildEmbed({positions,numbers,taken,lineup})] });
  } catch (e) {
    // fallback to system channel
    const ch = await guild.channels.fetch(guild.systemChannelId).catch(()=>null);
    if (!ch) return;
    posted = await ch.send({ content: '@here', embeds: [buildEmbed({positions,numbers,taken,lineup})] });
  }

  // react with 1-7
  for (const em of numbers) await posted.react(em).catch(()=>{});

  // store state
  const state = {
    messageId: posted.id,
    channelId: posted.channelId || posted.channel.id,
    positions,
    numbers,
    taken,
    lineup,
    collecting: true,
    hostId
  };
  lineups.set(guildId, state);
  incrementFriendlyCount(guildId, hostId);

  // reaction collector
  const collector = posted.createReactionCollector({ time: 600000 });
  collector.on('collect', async (reaction, user) => {
    try {
      if (user.bot) return reaction.users.remove(user.id).catch(()=>{});
      const idx = state.numbers.indexOf(reaction.emoji.name);
      if (idx === -1) return reaction.users.remove(user.id).catch(()=>{});
      if (state.taken[idx]) { return reaction.users.remove(user.id).catch(()=>{}); }
      if (state.lineup[user.id] !== undefined) { return reaction.users.remove(user.id).catch(()=>{}); }
      // claim slot
      state.taken[idx] = user.id;
      state.lineup[user.id] = idx;
      await user.send(`✅ Confirmed: ${state.positions[idx]}`).catch(()=>{});
      // edit posted embed
      try { await posted.edit({ embeds: [buildEmbed(state)] }).catch(()=>{}); } catch {}
      // announce
      const ch = await guild.channels.fetch(state.channelId).catch(()=>null);
      if (ch) ch.send(`✅ ${state.positions[idx]} claimed by <@${user.id}>`).catch(()=>{});
      // check full
      if (state.taken.every(x => x)) collector.stop('filled');
    } catch (e) { console.error('collector collect error', e); }
  });

  collector.on('end', async (_, reason) => {
    state.collecting = false;
    lineups.set(guildId, state);
    if (reason !== 'filled') {
      const ch = await guild.channels.fetch(state.channelId).catch(()=>null);
      if (ch) ch.send('❌ Friendly cancelled.').catch(()=>{});
      lineups.delete(guildId);
      return;
    }
    // final lineup posted
    const finalText = state.positions.map((p,i) => `${p}: <@${state.taken[i]}>`).join('\n');
    const ch = await guild.channels.fetch(state.channelId).catch(()=>null);
    if (ch) await ch.send(`**FINAL LINEUP:**\n${finalText}`).catch(()=>{});
    // DM host for ROBLOX link
    const host = await client.users.fetch(state.hostId).catch(()=>null);
    if (!host) {
      if (ch) ch.send(`Host <@${state.hostId}>, please DM the ROBLOX link to someone.`).catch(()=>{});
      return;
    }
    try {
      await host.send('Lineup is full. Please reply to this DM with the ROBLOX link (starting with https://). You have 5 minutes.').catch(()=>{});
      const dmChannel = await host.createDM();
      const dmCollector = dmChannel.createMessageCollector({ filter: m => m.author.id === state.hostId, time: 5*60*1000, max: 1 });
      dmCollector.on('collect', async m => {
        const link = m.content.trim();
        if (!/^https?:\/\//.test(link)) return host.send('That does not look like a valid link. Cancelled.').catch(()=>{});
        // send to all players
        for (const uid of state.taken) {
          client.users.send(uid, `Here is the ROBLOX link from <@${state.hostId}>:\n${link}`).catch(()=>{});
        }
        host.send('Link sent to final lineup.').catch(()=>{});
      });
      dmCollector.on('end', (_, r) => { if (r === 'time') host.send('Timed out waiting for the link.').catch(()=>{}); });
    } catch (e) {
      if (ch) ch.send(`Host please post the link or DM it to the players.`).catch(()=>{});
    }
  });
}

// ---------- editLineup helper ----------
function editLineup(guildId, posArg, userId) {
  const state = lineups.get(guildId);
  if (!state) return false;
  const a = String(posArg).toLowerCase();
  let idx = -1;
  if (!Number.isNaN(Number(a))) idx = parseInt(a,10)-1;
  else idx = state.positions.findIndex(p => p.toLowerCase() === a);
  if (idx < 0 || idx >= state.positions.length) return false;
  // clear previous occupant of new slot
  const prev = state.taken[idx];
  if (prev) delete state.lineup[prev];
  // free old slot of new user
  if (state.lineup[userId] !== undefined) {
    const old = state.lineup[userId];
    state.taken[old] = null;
  }
  // place user
  state.taken[idx] = userId;
  state.lineup[userId] = idx;
  // update stored message
  (async () => {
    try {
      const ch = await client.channels.fetch(state.channelId).catch(()=>null);
      if (!ch) return;
      const msg = await ch.messages.fetch(state.messageId).catch(()=>null);
      if (!msg) return;
      await msg.edit({ embeds: [ new EmbedBuilder().setColor(0x00a86b).setTitle('AGNELLO FC 7v7 FRIENDLY (Updated)')
        .setDescription(state.positions.map((pos,i)=> `${state.numbers[i]} → **${pos}**\n${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n\n')) ] }).catch(()=>{});
    } catch (e) { console.error('editLineup update error', e); }
  })();
  return true;
}

// ---------- start login ----------
process.on('unhandledRejection', e => console.error('UnhandledRejection', e));
process.on('uncaughtException', e => console.error('UncaughtException', e));

client.login(TOKEN).catch(err => {
  console.error('Failed to login:', err);
  process.exit(1);
});
