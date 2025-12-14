// index.js
// Agnello FC — Single-file bot
// Node 18+ / ESM / discord.js v14
// -------------------------------------------------

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
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
import ffmpegPath from 'ffmpeg-static';

// -----------------------------
// Configuration (edit IDs as needed)
// -----------------------------
const TOKEN = process.env.TOKEN;
const ENABLE_VOICE = process.env.ENABLE_VOICE === 'true'; // only use on UDP-capable VPS
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '1362214241091981452';
const HOST_ROLE_ID = process.env.HOST_ROLE_ID || '1383970211933454378';
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1403929923084882012';
const FAREWELL_CHANNEL_ID = process.env.FAREWELL_CHANNEL_ID || '1403930222222643220';
const PREFIX = process.env.PREFIX || '!';
const ALLOWED_GUILD = process.env.ALLOWED_GUILD || '1357085245983162708'; // Agnello FC server ID, enforced
const ECON_FILE = path.resolve('./economy.json');
const HOST_COUNTS_FILE = path.resolve('./host_counts.json');

// -----------------------------
// Small profanity list (editable)
// -----------------------------
const SWEARS = [
  'fuck','shit','bitch','asshole','bastard','damn','crap','idiot','stfu','wtf'
];

// -----------------------------
// Helpers and persistence
// -----------------------------
const safeLog = (...args) => console.log('[BOT]', ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min,max) => Math.floor(Math.random()*(max-min+1))+min;

function readJSON(file, fallback = {}) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    console.error('readJSON error', file, e);
    return fallback;
  }
}
function writeJSON(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('writeJSON error', file, e);
  }
}

// Economy persistence
let ECON = readJSON(ECON_FILE, {});
function saveEconomy() { writeJSON(ECON_FILE, ECON); }
function ensureUser(id) { if (!ECON[id]) ECON[id] = { balance: 10 }; return ECON[id]; }
function getBal(id) { return (ensureUser(id).balance || 0); }
function setBal(id, n) { ensureUser(id); ECON[id].balance = Math.max(0, Math.floor(n)); saveEconomy(); }
function addBal(id, n) { ensureUser(id); ECON[id].balance = Math.max(0, Math.floor((ECON[id].balance || 0) + n)); saveEconomy(); return ECON[id].balance; }
function subBal(id, n) { ensureUser(id); ECON[id].balance = Math.max(0, Math.floor((ECON[id].balance || 0) - n)); saveEconomy(); return ECON[id].balance; }

// Hostfriendly counts persistence
let HOST_COUNTS = readJSON(HOST_COUNTS_FILE, {});
function saveHostCounts() { writeJSON(HOST_COUNTS_FILE, HOST_COUNTS); }
function incrHostCount(userId) { HOST_COUNTS[userId] = (HOST_COUNTS[userId] || 0) + 1; saveHostCounts(); }
function getHostCount(userId) { return HOST_COUNTS[userId] || 0; }

// -----------------------------
// Game & utility functions
// -----------------------------
function parseBet(arg, max) {
  if (!arg) return null;
  arg = String(arg).toLowerCase();
  if (arg === 'all') return max;
  if (arg.endsWith('%')) {
    const p = parseFloat(arg.slice(0, -1));
    if (Number.isNaN(p) || p <= 0) return null;
    return Math.max(1, Math.floor((p / 100) * max));
  }
  const n = parseInt(arg, 10);
  if (Number.isNaN(n) || n <= 0) return null;
  return n;
}
function spinWheel(bet) {
  const wheel = [0,0,0,0,0,1,1,2,2,3,5,10,20,50];
  const pick = wheel[randInt(0, wheel.length-1)];
  return Math.floor(pick * bet);
}
function coinFlip(bet) { return Math.random() < 0.5 ? bet : -bet; }
function slotsResult(bet) {
  const syms = ['🍒','🍋','🔔','⭐','💎'];
  const r1 = syms[randInt(0, syms.length-1)];
  const r2 = syms[randInt(0, syms.length-1)];
  const r3 = syms[randInt(0, syms.length-1)];
  let payout = 0;
  if (r1 === r2 && r2 === r3) {
    payout = (r1 === '💎') ? bet*10 : (r1 === '⭐') ? bet*6 : (r1 === '🔔') ? bet*4 : bet*3;
  } else if (r1 === r2 || r2 === r3 || r1 === r3) {
    payout = Math.floor(bet*1.5);
  } else payout = -bet;
  return { display: `${r1} ${r2} ${r3}`, payout };
}
// simplified blackjack functions (auto-play dealer/player)
function drawCard() {
  const ranks = [['A',11],['2',2],['3',3],['4',4],['5',5],['6',6],['7',7],['8',8],['9',9],['10',10],['J',10],['Q',10],['K',10]];
  const r = ranks[randInt(0, ranks.length-1)]; return { rank: r[0], value: r[1] };
}
function handValue(cards) {
  let total = cards.reduce((s,c)=>s + c.value, 0);
  const aces = cards.filter(c=>c.rank==='A').length;
  for (let i=0;i<aces && total>21;i++) total -= 10;
  return total;
}
function blackjackResolve(bet) {
  const player = [drawCard(), drawCard()];
  const dealer = [drawCard(), drawCard()];
  while (handValue(player) < 17) player.push(drawCard());
  while (handValue(dealer) < 17) dealer.push(drawCard());
  const pv = handValue(player), dv = handValue(dealer);
  let payout = 0, result = 'push';
  if (pv > 21) { result='bust'; payout = -bet; }
  else if (dv > 21) { result='dealer_bust'; payout = bet; }
  else if (pv > dv) { result='win'; payout = bet; }
  else if (pv < dv) { result='lose'; payout = -bet; }
  else result='push';
  return { player, dealer, pv, dv, result, payout };
}
// Poker & crime helper trimmed (kept from earlier)
function buildDeck(){ const suits=['♠','♥','♦','♣']; const ranks=['2','3','4','5','6','7','8','9','10','J','Q','K','A']; const deck=[]; for(const s of suits) for(const r of ranks) deck.push({s,r}); return deck; }
function shuffle(deck){ for(let i=deck.length-1;i>0;i--){ const j=randInt(0,i); [deck[i],deck[j]]=[deck[j],deck[i]];} return deck; }
function rankValue(r){ const order={'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14}; return order[r]; }
function crimeAttempt(){ const r=Math.random(); if(r<0.45) return { success:true, amount: randInt(5,50)}; return { success:false, fine: randInt(10,60)}; }

// -----------------------------
// In-memory stores
// -----------------------------
const textWarnings = new Map();
const musicQueues = new Map();
const audioPlayers = new Map();
const lineups = new Map();

// -----------------------------
// Client setup
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

client.once('ready', () => {
  safeLog(`Logged in as ${client.user.tag}`);
  safeLog(`Allowed guild: ${ALLOWED_GUILD}`);
  safeLog(`Voice ${ENABLE_VOICE ? 'ENABLED' : 'DISABLED (safe host)'}`);
});

// Helper to check allowed guild and reply with single message if not allowed
const repliedNotAllowed = new Set(); // message.author id -> we've already informed them in that guild
async function ensureAllowedGuild(message) {
  // If message is DM or guild mismatch -> reply and return false
  const guildId = message.guild?.id;
  if (!guildId || guildId !== String(ALLOWED_GUILD)) {
    // Send the "sorry" reply (once per author to avoid spam). If guild exists but wrong, still reply.
    const key = `${message.author.id}:${guildId || 'DM'}`;
    if (!repliedNotAllowed.has(key)) {
      try { await message.reply('Sorry! This is not Agnello FC.'); } catch(){}
      repliedNotAllowed.add(key);
      // clear after a while so owners can test again if needed
      setTimeout(()=> repliedNotAllowed.delete(key), 60_000);
    }
    return false;
  }
  return true;
}

// -----------------------------
// Guild join/leave (welcome/farewell) only for allowed guild
// -----------------------------
client.on('guildMemberAdd', async (member) => {
  try {
    if (String(member.guild.id) !== String(ALLOWED_GUILD)) return;
    const ch = member.guild.channels.cache.get(WELCOME_CHANNEL_ID);
    if (ch) await ch.send(`👋 Welcome, ${member}!`);
    try { await member.send(`👋 Welcome to **${member.guild.name}**!`); } catch {}
  } catch (e) { console.error('guildMemberAdd error', e); }
});
client.on('guildMemberRemove', async (member) => {
  try {
    if (String(member.guild.id) !== String(ALLOWED_GUILD)) return;
    const ch = member.guild.channels.cache.get(FAREWELL_CHANNEL_ID);
    if (ch) await ch.send(`👋 Goodbye, **${member.user.tag}**!`);
    try { await member.send(`😢 Sorry to see you leave **${member.guild.name}**.`); } catch {}
  } catch (e) { console.error('guildMemberRemove error', e); }
});

// -----------------------------
// Main message handler
// -----------------------------
client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return; // ignore bots

    // Always only operate in the allowed guild
    const inAllowedGuild = message.guild && String(message.guild.id) === String(ALLOWED_GUILD);
    if (!inAllowedGuild) {
      // If DM or in another guild, politely reply once per author/guild
      await ensureAllowedGuild(message);
      return;
    }

    // Auto-react to @everyone/@here
    if (message.guild && (message.mentions?.everyone || message.content.includes('@here'))) {
      try { await message.react('✅'); } catch {}
    }

    // Profanity filter (text)
    if (message.guild && message.content) {
      const lowered = message.content.toLowerCase();
      if (SWEARS.some(w => lowered.includes(w))) {
        await message.delete().catch(()=>{});
        const cnt = (textWarnings.get(message.author.id) || 0) + 1;
        textWarnings.set(message.author.id, cnt);
        try { await message.author.send(`⚠️ Your message was removed for language.\n> ${message.content}\nThis is warning #${cnt}.`); } catch {}
        const logCh = message.guild.channels.cache.get(LOG_CHANNEL_ID);
        if (logCh) logCh.send(`🧹 Text profanity: ${message.author.tag}\nMessage: ${message.content}\nWarning #${cnt}`).catch(()=>{});
        // if in VC try mute for 10s
        const member = message.member;
        if (member && member.voice?.channel && member.manageable) {
          try {
            await member.voice.setMute(true, 'Auto-moderation: swearing');
            if (logCh) logCh.send(`🔇 Auto VC mute applied to ${member.user.tag} for 10s`).catch(()=>{});
            setTimeout(async () => {
              try { if (member.voice?.channel) await member.voice.setMute(false, 'Auto-moderation expired'); } catch {}
            }, 10_000);
          } catch {}
        }
        return;
      }
    }

    // Only handle commands with prefix
    if (!message.content.startsWith(PREFIX)) return;
    const raw = message.content.slice(PREFIX.length).trim();
    if (!raw) return;
    const parts = raw.split(/\s+/);
    const cmd = parts.shift().toLowerCase();
    const args = parts;

    // ---------- PURGE ----------
    if (cmd === 'purge') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return message.reply('❌ You do not have permission to purge messages.');
      const amount = parseInt(args[0],10);
      if (isNaN(amount) || amount < 1 || amount > 100) return message.reply('⚠️ Please enter a number between 1 and 100.');
      try {
        const deleted = await message.channel.bulkDelete(amount, true);
        const confirmation = await message.channel.send(`✅ Deleted **${deleted.size}** messages.`);
        setTimeout(()=> confirmation.delete().catch(()=>{}), 5000);
        return;
      } catch (e) {
        console.error('purge error', e);
        return message.reply('❌ I can not delete messages older than 14 days or an error occurred.');
      }
    }

    // ---------- HOSTTRAINING ----------
    if (cmd === 'hosttraining') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply('❌ You are not allowed to host trainings.');
      }
      await message.reply('✅ Send the training link below. You have 60 seconds.');
      const filter = m => m.author.id === message.author.id;
      const collector = message.channel.createMessageCollector({ filter, max: 1, time: 60_000 });
      collector.on('collect', async (collected) => {
        const link = collected.content.trim();
        if (!link.startsWith('http')) {
          return message.reply('❌ That does not look like a valid link. Training cancelled.');
        }
        const embed = new EmbedBuilder()
          .setColor('Blue')
          .setTitle('📘 Training Signup')
          .setDescription(`React ✅ to receive the training link.\nHosted by <@${message.author.id}>`)
          .setTimestamp();
        const signup = await message.channel.send({ embeds: [embed] });
        await signup.react('✅');
        const rCollector = signup.createReactionCollector({
          filter: (r, u) => r.emoji.name === '✅' && !u.bot,
        });
        rCollector.on('collect', async (reaction, user) => {
          try {
            await user.send(`✅ Training link from ${message.author.tag}:\n${link}`);
          } catch {
            await message.channel.send(`⚠️ <@${user.id}> has DMs closed. Could not send link.`);
          }
        });
      });
      collector.on('end', (collected) => {
        if (collected.size === 0) message.reply('❌ You never sent a link. Training cancelled.');
      });
      return;
    }

    // ---------- MESSAGE (neat embed message) ----------
    if (cmd === 'message') {
      const content = args.join(' ');
      if (!content) return message.reply("❌ You need to actually write something.");
      const embed = new EmbedBuilder()
        .setColor('Blue')
        .setTitle('📢 Announcement')
        .setDescription(content)
        .setFooter({ text: `Sent by ${message.author.tag}` })
        .setTimestamp();
      return message.channel.send({ embeds: [embed] });
    }

    // ---------- HOSTFRIENDLY ----------
    if (cmd === 'hostfriendly') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply('❌ You are not allowed to host friendlies.');
      }

      // increment host count for this user
      incrHostCount(message.author.id);

      const positions = ['GK','CB','CB2','CM','LW','RW','ST'];
      const numbers = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
      const taken = Array(positions.length).fill(null);
      const lineup = {};

      // pre-claim by arg
      if (args[0]) {
        let idx = -1;
        const a = args[0].toLowerCase();
        if (!Number.isNaN(Number(a))) idx = parseInt(a,10)-1;
        else idx = positions.findIndex(p => p.toLowerCase() === a);
        if (idx >= 0 && idx < positions.length && !taken[idx]) {
          taken[idx] = message.author.id;
          lineup[message.author.id] = idx;
        }
      }

      function buildEmbed(state) {
        const lines = state.positions.map((pos,i) => `${state.numbers[i]} ➜ **${pos}**\n${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n\n');
        const final = state.positions.map((pos,i) => `${pos}: ${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n');
        return new EmbedBuilder()
          .setColor(0x00a86b)
          .setTitle('AGNELLO FC 7v7 FRIENDLY')
          .setDescription(lines + '\n\nReact to claim a position. Only **1** position per user.\nHost may edit with `!editlineup` or reset with `!resetlineup`.\n\n✅ **Final Lineup:**\n' + final);
      }

      const sent = await message.channel.send({ content: '@here', embeds: [buildEmbed({positions,numbers,taken,lineup})] });
      for (const e of numbers) await sent.react(e).catch(()=>{});
      lineups.set(message.guild.id, { messageId: sent.id, channelId: sent.channel.id, positions, numbers, taken, lineup });

      const collector = sent.createReactionCollector({ filter: (r,u) => numbers.includes(r.emoji.name) && !u.bot });
      collector.on('collect', async (reaction, user) => {
        const state = lineups.get(message.guild.id);
        if (!state) return;
        const posIndex = state.numbers.indexOf(reaction.emoji.name);
        if (state.lineup[user.id] !== undefined) { reaction.users.remove(user.id).catch(()=>{}); return message.channel.send(`<@${user.id}> ❌ You are already in the lineup!`); }
        if (state.taken[posIndex]) { reaction.users.remove(user.id).catch(()=>{}); return message.channel.send(`<@${user.id}> ❌ That position is already taken.`); }
        state.taken[posIndex] = user.id;
        state.lineup[user.id] = posIndex;
        try { await user.send(`✅ Position confirmed: **${state.positions[posIndex]}**`); } catch {}
        message.channel.send(`✅ ${state.positions[posIndex]} confirmed for <@${user.id}>`);
        const ch = await message.guild.channels.fetch(state.channelId).catch(()=>null);
        if (!ch) return;
        const msgToEdit = await ch.messages.fetch(state.messageId).catch(()=>null);
        if (!msgToEdit) return;
        await msgToEdit.edit({ embeds: [buildEmbed(state)] }).catch(()=>{});
      });

      return;
    }

    // ---------- CHECKFRIENDLY (new) ----------
    if (cmd === 'checkfriendly') {
      // usage: !checkfriendly -> top 10 hosts, or !checkfriendly @user -> show for that user
      if (args.length === 0) {
        // top 10
        const entries = Object.entries(HOST_COUNTS).sort((a,b)=>b[1]-a[1]).slice(0,10);
        if (entries.length === 0) return message.reply('No hostfriendly runs recorded yet.');
        const lines = await Promise.all(entries.map(async ([uid,count], i) => {
          const user = await client.users.fetch(uid).catch(()=>({ tag: `Unknown (${uid})` }));
          return `**${i+1}.** ${user.tag || user.username || `Unknown (${uid})`} — ${count} times`;
        }));
        const embed = new EmbedBuilder().setTitle('Hostfriendly top hosts').setDescription(lines.join('\n')).setColor('Blue');
        return message.channel.send({ embeds: [embed] });
      } else {
        const mention = message.mentions.users.first();
        if (!mention) return message.reply('Usage: `!checkfriendly` or `!checkfriendly @user`');
        const count = getHostCount(mention.id);
        return message.reply(`${mention.tag} has hosted friendlies **${count}** time(s).`);
      }
    }

    // ---------- editlineup / resetlineup ----------
    if (cmd === 'editlineup') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('Only host or admins can edit the lineup.');
      const state = lineups.get(message.guild.id);
      if (!state) return message.reply('No active lineup found.');
      const posArg = args[0]?.toLowerCase();
      const user = message.mentions.users.first();
      if (!posArg || !user) return message.reply('Usage: `!editlineup <pos|number> @user`');
      let idx = -1;
      if (!Number.isNaN(Number(posArg))) idx = parseInt(posArg,10)-1;
      else idx = state.positions.findIndex(p => p.toLowerCase() === posArg);
      if (idx < 0 || idx >= state.positions.length) return message.reply('Invalid position.');
      if (state.taken[idx]) { const prev = state.taken[idx]; delete state.lineup[prev]; }
      if (state.lineup[user.id] !== undefined) { const old = state.lineup[user.id]; state.taken[old] = null; }
      state.taken[idx] = user.id; state.lineup[user.id] = idx;
      const ch = await message.guild.channels.fetch(state.channelId).catch(()=>null);
      if (!ch) return message.reply('Failed to fetch lineup channel.');
      const msgToEdit = await ch.messages.fetch(state.messageId).catch(()=>null);
      if (!msgToEdit) return message.reply('Failed to fetch lineup message.');
      const lines = state.positions.map((pos,i)=> `${state.numbers[i]} ➜ **${pos}**\n${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n\n');
      const final = state.positions.map((pos,i)=> `${pos}: ${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n');
      const newEmbed = new EmbedBuilder().setColor(0x00a86b).setTitle('AGNELLO FC 7v7 FRIENDLY').setDescription(lines + '\n\n✅ **Final Lineup:**\n' + final);
      await msgToEdit.edit({ embeds: [newEmbed] }).catch(()=>{});
      return message.channel.send(`✏️ ${state.positions[idx]} updated → <@${user.id}>`);
    }

    if (cmd === 'resetlineup') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('Only host or admins can reset the lineup.');
      lineups.delete(message.guild.id);
      return message.channel.send('♻️ Lineup reset.');
    }

    // ---------- Moderation ----------
    if (cmd === 'ban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('Missing permission: BanMembers');
      const target = message.mentions.members.first();
      const reason = args.slice(1).join(' ') || 'No reason';
      if (!target) return message.reply('Usage: `!ban @user [reason]`');
      await target.ban({ reason }).catch(e => message.reply(`Failed: ${e.message}`));
      message.channel.send(`🔨 Banned ${target.user.tag}`);
      const logCh = message.guild.channels.cache.get(LOG_CHANNEL_ID); if (logCh) logCh.send(`🔨 Ban: ${message.author.tag} -> ${target.user.tag} — ${reason}`).catch(()=>{});
      return;
    }

    if (cmd === 'unban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('Missing permission: BanMembers');
      const id = args[0];
      if (!id) return message.reply('Usage: `!unban <userId>`');
      await message.guild.bans.remove(id).catch(e => message.reply(`Failed: ${e.message}`));
      message.channel.send(`✅ Unbanned ${id}`);
      const logCh = message.guild.channels.cache.get(LOG_CHANNEL_ID); if (logCh) logCh.send(`✅ Unban: ${message.author.tag} -> ${id}`).catch(()=>{});
      return;
    }

    if (cmd === 'kick') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('Missing permission: KickMembers');
      const target = message.mentions.members.first();
      const reason = args.slice(1).join(' ') || 'No reason';
      if (!target) return message.reply('Usage: `!kick @user [reason]`');
      await target.kick(reason).catch(e => message.reply(`Failed: ${e.message}`));
      message.channel.send(`👢 Kicked ${target.user.tag}`);
      const logCh = message.guild.channels.cache.get(LOG_CHANNEL_ID); if (logCh) logCh.send(`👢 Kick: ${message.author.tag} -> ${target.user.tag} — ${reason}`).catch(()=>{});
      return;
    }

    if (cmd === 'timeout') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('Missing permission: ModerateMembers');
      const target = message.mentions.members.first();
      const seconds = parseInt(args[1] || args[0], 10);
      if (!target || Number.isNaN(seconds)) return message.reply('Usage: `!timeout @user <seconds>`');
      await target.timeout(seconds*1000, `By ${message.author.tag}`).catch(e => message.reply(`Failed: ${e.message}`));
      message.channel.send(`⏲️ Timed out ${target.user.tag} for ${seconds}s`);
      const logCh = message.guild.channels.cache.get(LOG_CHANNEL_ID); if (logCh) logCh.send(`⏲️ Timeout: ${message.author.tag} -> ${target.user.tag} (${seconds}s)`).catch(()=>{});
      return;
    }

    if (cmd === 'vmute') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('Missing permission: ModerateMembers');
      const target = message.mentions.members.first();
      if (!target) return message.reply('Usage: `!vmute @user`');
      if (!target.voice?.channel) return message.reply('User not in VC.');
      await target.voice.setMute(true, `Manual VMute by ${message.author.tag}`).catch(e => message.reply(`Failed: ${e.message}`));
      message.channel.send(`🔇 Voice-muted ${target.user.tag}`);
      const logCh = message.guild.channels.cache.get(LOG_CHANNEL_ID); if (logCh) logCh.send(`🔇 VMute: ${message.author.tag} -> ${target.user.tag}`).catch(()=>{});
      return;
    }

    // ---------- DM Utilities ----------
    if (cmd === 'dmrole') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('Admins only.');
      const roleId = args.shift();
      const text = args.join(' ');
      if (!roleId || !text) return message.reply('Usage: `!dmrole <roleId> <message>`');
      const role = message.guild.roles.cache.get(roleId);
      if (!role) return message.reply('Role not found.');
      const members = await message.guild.members.fetch();
      let count = 0;
      for (const m of members.filter(m => m.roles.cache.has(role.id) && !m.user.bot).values()) {
        m.send(`${text}\n\n*dm sent by ${message.author.tag}*`).catch(()=>{});
        count++;
      }
      message.channel.send(`📩 DMed ${count} members with role <@&${role.id}>.`);
      return;
    }
    if (cmd === 'dmall') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('Admins only.');
      const text = args.join(' ');
      if (!text) return message.reply('Usage: `!dmall <message>`');
      const members = await message.guild.members.fetch();
      let count=0;
      for (const m of members.values()) {
        if (m.user.bot) continue;
        m.send(`${text}\n\n*dm sent by ${message.author.tag}*`).catch(()=>{});
        count++;
      }
      message.channel.send(`📩 DMed ${count} members.`);
      return;
    }

    // ---------- Activity check ----------
    if (cmd === 'activitycheck') {
      const goal = Math.max(1, parseInt(args[0],10) || 40);
      const emb = new EmbedBuilder().setColor(0x2b6cb0).setTitle('📊 Activity Check').setDescription(`React with ✅ to check in!\nGoal: **${goal}** members.`);
      const sent = await message.channel.send({ content: '@here', embeds: [emb] });
      await sent.react('✅').catch(()=>{});
      return;
    }

    // ---------- Music / Voice ----------
    if (cmd === 'joinvc') {
      if (!ENABLE_VOICE) return message.reply('Voice disabled on this host.');
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a voice channel first.');
      joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
      return message.channel.send('✅ Joined VC.');
    }
    if (cmd === 'leavevc') {
      const conn = getVoiceConnection(message.guild.id);
      if (!conn) return message.reply('Not connected.');
      conn.destroy();
      return message.channel.send('👋 Left VC.');
    }

    if (cmd === 'play') {
      if (!ENABLE_VOICE) return message.reply('Voice disabled on this host.');
      const url = args[0];
      if (!url || !ytdl.validateURL(url)) return message.reply('Usage: `!play <YouTubeURL>`');
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a voice channel first.');
      const q = musicQueues.get(message.guild.id) || [];
      const info = await ytdl.getInfo(url).catch(()=>null);
      const title = info?.videoDetails?.title || url;
      q.push({ title, url });
      musicQueues.set(message.guild.id, q);
      message.channel.send(`➕ Queued **${title}**`);
      let conn = getVoiceConnection(message.guild.id);
      if (!conn) conn = joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
      let player = audioPlayers.get(message.guild.id);
      if (!player) {
        player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
        audioPlayers.set(message.guild.id, player);
        conn.subscribe(player);
        player.on(AudioPlayerStatus.Idle, async () => {
          const cur = musicQueues.get(message.guild.id) || [];
          cur.shift();
          musicQueues.set(message.guild.id, cur);
          if (cur[0]) await playTrack(message.guild.id, cur[0].url, message.channel);
          else message.channel.send('⏹️ Queue finished.');
        });
        player.on('error', e => message.channel.send(`Player error: ${e.message}`).catch(()=>{}));
      }
      const curQ = musicQueues.get(message.guild.id) || [];
      if (curQ.length === 1) await playTrack(message.guild.id, url, message.channel);
      return;
    }
    if (cmd === 'skip') {
      const player = audioPlayers.get(message.guild.id);
      if (!player) return message.reply('Nothing playing.');
      player.stop(true);
      return message.channel.send('⏭️ Skipped.');
    }
    if (cmd === 'stop') {
      musicQueues.set(message.guild.id, []);
      audioPlayers.get(message.guild.id)?.stop(true);
      getVoiceConnection(message.guild.id)?.destroy();
      return message.channel.send('⏹️ Stopped & cleared queue.');
    }

    // ---------- Economy & Games ----------
    ensureUser(message.author.id);
    if (cmd === 'start') return message.reply(`You have ${getBal(message.author.id)} Robux (new users start with 10).`);
    if (cmd === 'bal' || cmd === 'balance') return message.reply(`${message.author}, your balance: **${getBal(message.author.id)} Robux**`);

    if (cmd === 'give') {
      const target = message.mentions.users.first();
      const amtArg = args[1] || args[0];
      const amt = parseInt(amtArg,10);
      if (!target || Number.isNaN(amt) || amt <= 0) return message.reply('Usage: `!give @user <amount>`');
      if (getBal(message.author.id) < amt) return message.reply('Insufficient funds.');
      subBal(message.author.id, amt);
      addBal(target.id, amt);
      return message.reply(`✅ Sent ${amt} Robux to ${target.tag}. New balance: ${getBal(message.author.id)} Robux`);
    }

    if (cmd === 'spin') {
      const bet = parseBet(args[0], getBal(message.author.id));
      if (!bet) return message.reply('Usage: `!spin <amount|all|<percent>%>`');
      if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.');
      subBal(message.author.id, bet);
      const win = spinWheel(bet);
      if (win > 0) { addBal(message.author.id, win); return message.reply(`🎡 You spun and won **${win} Robux**! New balance: ${getBal(message.author.id)}`); }
      return message.reply(`🎡 Bad luck — you lost ${bet} Robux. New balance: ${getBal(message.author.id)}`);
    }

    if (cmd === 'coin') {
      const bet = parseBet(args[0], getBal(message.author.id));
      if (!bet) return message.reply('Usage: `!coin <amount|all|<percent>%>`');
      if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.');
      const res = coinFlip(bet);
      if (res > 0) { addBal(message.author.id, res); return message.reply(`🪙 You won ${res} Robux! New balance: ${getBal(message.author.id)}`); }
      subBal(message.author.id, bet); return message.reply(`🪙 You lost ${bet} Robux. New balance: ${getBal(message.author.id)}`);
    }

    if (cmd === 'slots') {
      const bet = parseBet(args[0], getBal(message.author.id));
      if (!bet) return message.reply('Usage: `!slots <amount|all|<percent>%>`');
      if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.');
      subBal(message.author.id, bet);
      const { display, payout } = slotsResult(bet);
      if (payout > 0) addBal(message.author.id, payout);
      return message.reply(`🎰 ${display}\n${payout>0?`You won ${payout} Robux!`:`You lost ${bet} Robux.`}\nNew balance: ${getBal(message.author.id)}`);
    }

    if (cmd === 'blackjack' || cmd === 'bj') {
      const bet = parseBet(args[0], getBal(message.author.id));
      if (!bet) return message.reply('Usage: `!blackjack <amount|all|<percent>%>`');
      if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.');
      subBal(message.author.id, bet);
      const res = blackjackResolve(bet);
      if (res.payout > 0) addBal(message.author.id, res.payout);
      const ph = res.player.map(c=>c.rank).join(' ');
      const dh = res.dealer.map(c=>c.rank).join(' ');
      const resultText = res.result === 'push' ? 'Push — bet returned.' : (res.payout>0?`You win ${res.payout} Robux!`:`You lose ${-res.payout} Robux.`);
      return message.reply(`🃏 Blackjack\nYour hand: ${ph} (${res.pv})\nDealer: ${dh} (${res.dv})\n${resultText}\nNew balance: ${getBal(message.author.id)}`);
    }

    if (cmd === 'poker') {
      return message.reply('Poker command present but UI is simplified in this build.');
    }

    if (cmd === 'crime') {
      const r = crimeAttempt();
      if (r.success) { addBal(message.author.id, r.amount); const logCh = message.guild.channels.cache.get(LOG_CHANNEL_ID); if (logCh) logCh.send(`🕵️‍♂️ Crime success: ${message.author.tag} got ${r.amount}`).catch(()=>{}); return message.reply(`💰 Crime succeeded! You stole **${r.amount} Robux**. New balance: ${getBal(message.author.id)}`); }
      const loss = Math.min(getBal(message.author.id), r.fine);
      subBal(message.author.id, loss);
      const logCh = message.guild.channels.cache.get(LOG_CHANNEL_ID); if (logCh) logCh.send(`🚔 Crime failed: ${message.author.tag} fined ${loss}`).catch(()=>{});
      return message.reply(`🚨 You got caught! You paid **${loss} Robux** in fines. New balance: ${getBal(message.author.id)}`);
    }

    // unknown command -> ignore silently
  } catch (err) {
    console.error('messageCreate handler error:', err);
  }
});

// -----------------------------
// Audio play helper
// -----------------------------
async function playTrack(guildId, url, textChannel) {
  try {
    const conn = getVoiceConnection(guildId);
    if (!conn) { await textChannel.send('⚠️ Not connected to a VC.'); return; }
    const stream = ytdl(url, { filter: 'audioonly', highWaterMark: 1<<25, quality: 'highestaudio' });
    const res = createAudioResource(stream);
    let player = audioPlayers.get(guildId);
    if (!player) {
      player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
      audioPlayers.set(guildId, player);
      conn.subscribe(player);
    }
    player.play(res);
    const info = await ytdl.getInfo(url).catch(()=>null);
    await textChannel.send(`🎶 Playing **${info?.videoDetails?.title || url}**`).catch(()=>{});
  } catch (e) {
    console.error('playTrack error', e);
    await textChannel.send(`Failed to play track: ${e.message}`).catch(()=>{});
  }
}

// -----------------------------
// Keepalive web server
// -----------------------------
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('✅ Agnello FC Bot is alive and running!'));
app.listen(PORT, '0.0.0.0', () => safeLog(`Keepalive server listening on http://0.0.0.0:${PORT}`));

// -----------------------------
// Process event handlers
// -----------------------------
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

// -----------------------------
// Boot
// -----------------------------
if (!TOKEN) {
  console.error('❌ Missing TOKEN env var. Set TOKEN in environment.');
  process.exit(1);
}
client.login(TOKEN).catch(e => { console.error('Failed to login:', e); process.exit(1); });
