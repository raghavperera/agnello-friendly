// index.js
// Agnello FC Friendly Bot — Refactored, fixed & extended
// Node 18+ / ESM / discord.js v14

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import OpenAI from 'openai';
import ytdl from 'ytdl-core';
import ffmpegPath from 'ffmpeg-static';
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
// Configuration (edit IDs or use env)
// -----------------------------
const TOKEN = process.env.TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const ENABLE_VOICE = process.env.ENABLE_VOICE === 'true';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '1362214241091981452';
const HOST_ROLE_ID = process.env.HOST_ROLE_ID || '1383970211933454378';
const WELCOME_CHANNEL_ID = process.env.WELCOME_CHANNEL_ID || '1403929923084882012';
const FAREWELL_CHANNEL_ID = process.env.FAREWELL_CHANNEL_ID || '1403930222222643220';
const PREFIX = process.env.PREFIX || '!';
const ECON_FILE = path.join(process.cwd(), 'economy.json');
const FCOUNTS_FILE = path.join(process.cwd(), 'friendly_counts.json');

// -----------------------------
// Profanity list
// -----------------------------
const SWEARS = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'damn', 'crap', 'freak',
  'sucks', 'idiot', 'stfu', 'wtf'
];

// -----------------------------
// Utilities
// -----------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function safeGetLogChannel(guild) {
  if (!guild) return null;
  return guild.channels.cache.get(LOG_CHANNEL_ID) || null;
}

// -----------------------------
// OpenAI client (optional)
// -----------------------------
let openai = null;
if (OPENAI_API_KEY) openai = new OpenAI({ apiKey: OPENAI_API_KEY });
else console.warn('⚠️ OPENAI_API_KEY not set — AI mention responses will be disabled.');

// -----------------------------
// Economy persistence (simple file)
// -----------------------------
let ECON = {};
try {
  if (!fs.existsSync(ECON_FILE)) fs.writeFileSync(ECON_FILE, JSON.stringify({}), 'utf8');
  const raw = fs.readFileSync(ECON_FILE, 'utf8') || '{}';
  ECON = JSON.parse(raw);
} catch (e) {
  console.error('Failed to load economy file:', e);
  ECON = {};
}
function saveEconomy() {
  try { fs.writeFileSync(ECON_FILE, JSON.stringify(ECON, null, 2), 'utf8'); }
  catch (e) { console.error('Failed to save economy file:', e); }
}
function ensureUser(id) { if (!ECON[id]) ECON[id] = { balance: 10 }; return ECON[id]; }
function getBal(id) { return (ensureUser(id).balance || 0); }
function setBal(id, n) { ensureUser(id); ECON[id].balance = Math.max(0, Math.floor(n)); saveEconomy(); }
function addBal(id, n) { ensureUser(id); ECON[id].balance = Math.max(0, Math.floor(ECON[id].balance + n)); saveEconomy(); return ECON[id].balance; }
function subBal(id, n) { ensureUser(id); ECON[id].balance = Math.max(0, Math.floor(ECON[id].balance - n)); saveEconomy(); return ECON[id].balance; }

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

// -----------------------------
// Friendly counts persistence (new feature: !checkfriendly)
// structure: { [guildId]: { [userId]: count } }
// -----------------------------
let FRIENDLY_COUNTS = {};
try {
  if (!fs.existsSync(FCOUNTS_FILE)) fs.writeFileSync(FCOUNTS_FILE, JSON.stringify({}), 'utf8');
  FRIENDLY_COUNTS = JSON.parse(fs.readFileSync(FCOUNTS_FILE, 'utf8') || '{}');
} catch (e) {
  console.error('Failed to load friendly counts file:', e);
  FRIENDLY_COUNTS = {};
}
function saveFriendlyCounts() {
  try { fs.writeFileSync(FCOUNTS_FILE, JSON.stringify(FRIENDLY_COUNTS, null, 2), 'utf8'); }
  catch (e) { console.error('Failed to save friendly counts file:', e); }
}
function incrementFriendlyCount(guildId, userId) {
  if (!guildId || !userId) return;
  FRIENDLY_COUNTS[guildId] = FRIENDLY_COUNTS[guildId] || {};
  FRIENDLY_COUNTS[guildId][userId] = (FRIENDLY_COUNTS[guildId][userId] || 0) + 1;
  saveFriendlyCounts();
}
function getFriendlyCountForUser(guildId, userId) {
  return (FRIENDLY_COUNTS[guildId] && FRIENDLY_COUNTS[guildId][userId]) || 0;
}
function getFriendlyCountsForGuild(guildId) {
  return FRIENDLY_COUNTS[guildId] || {};
}

// -----------------------------
// Games: spin, coin, slots, blackjack, poker, crime
// (left mostly unchanged)
// -----------------------------
function spinWheel(bet) {
  const wheel = [0,0,0,0,0,1,1,2,2,3,5,10,20,50];
  const pick = wheel[randInt(0,wheel.length-1)];
  return Math.floor(pick * bet);
}
function coinFlip(bet) { return Math.random() < 0.5 ? bet : -bet; }
function slotsResult(bet) {
  const syms = ['🍒','🍋','🔔','⭐','💎'];
  const r1 = syms[randInt(0,syms.length-1)];
  const r2 = syms[randInt(0,syms.length-1)];
  const r3 = syms[randInt(0,syms.length-1)];
  let payout = 0;
  if (r1 === r2 && r2 === r3) {
    payout = (r1 === '💎') ? bet*10 : (r1 === '⭐') ? bet*6 : (r1 === '🔔') ? bet*4 : bet*3;
  } else if (r1 === r2 || r2 === r3 || r1 === r3) {
    payout = Math.floor(bet*1.5);
  } else {
    payout = -bet;
  }
  return { display: `${r1} ${r2} ${r3}`, payout };
}
function drawCard() {
  const ranks = [['A',11],['2',2],['3',3],['4',4],['5',5],['6',6],['7',7],['8',8],['9',9],['10',10],['J',10],['Q',10],['K',10]];
  const r = ranks[randInt(0,ranks.length-1)];
  return { rank: r[0], value: r[1] };
}
function handValue(cards) {
  let total = cards.reduce((s,c)=>s + c.value, 0);
  const aces = cards.filter(c => c.rank === 'A').length;
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
function buildDeck() {
  const suits = ['♠','♥','♦','♣'];
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ s, r });
  return deck;
}
function shuffle(deck) {
  for (let i = deck.length-1; i>0; i--) {
    const j = randInt(0,i);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function rankValue(r) {
  const order = {'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14};
  return order[r];
}
function isStraight(vals) {
  vals.sort((a,b)=>a-b);
  let seq = true;
  for (let i=1;i<vals.length;i++) if (vals[i] !== vals[i-1]+1) { seq = false; break; }
  if (seq) return true;
  if (vals.includes(14)) {
    const alt = vals.map(v => v===14?1:v).sort((a,b)=>a-b);
    let ok = true;
    for (let i=1;i<alt.length;i++) if (alt[i] !== alt[i-1]+1) { ok=false; break; }
    return ok;
  }
  return false;
}
function evaluateHand(cards) {
  const vals = cards.map(c => rankValue(c.r));
  const suits = cards.map(c => c.s);
  const counts = {};
  for (const v of vals) counts[v] = (counts[v]||0)+1;
  const countsSorted = Object.values(counts).sort((a,b)=>b-a);
  const flush = suits.every(s => s===suits[0]);
  const straight = isStraight(vals.slice());
  if (straight && flush) return { rank:8, name:'Straight Flush', t: Math.max(...vals) };
  if (countsSorted[0] === 4) return { rank:7, name:'Four of a Kind', t: parseInt(Object.keys(counts).find(k=>counts[k]===4)) };
  if (countsSorted[0] === 3 && countsSorted[1] === 2) return { rank:6, name:'Full House', t: parseInt(Object.keys(counts).find(k=>counts[k]===3)) };
  if (flush) return { rank:5, name:'Flush', t: Math.max(...vals) };
  if (straight) return { rank:4, name:'Straight', t: Math.max(...vals) };
  if (countsSorted[0] === 3) return { rank:3, name:'Three of a Kind', t: parseInt(Object.keys(counts).find(k=>counts[k]===3)) };
  if (countsSorted[0] === 2 && countsSorted[1] === 2) {
    const pairs = Object.keys(counts).filter(k=>counts[k]===2).map(x=>parseInt(x)).sort((a,b)=>b-a);
    return { rank:2, name:'Two Pair', t: pairs[0]*100 + pairs[1] };
  }
  if (countsSorted[0] === 2) return { rank:1, name:'One Pair', t: parseInt(Object.keys(counts).find(k=>counts[k]===2)) };
  return { rank:0, name:'High Card', t: Math.max(...vals) };
}
function compareHands(a,b) { if (a.rank !== b.rank) return a.rank - b.rank; return a.t - b.t; }
function pokerResolve(bet) {
  const deck = shuffle(buildDeck());
  const player = deck.splice(0,5);
  const dealer = deck.splice(0,5);
  const pr = evaluateHand(player), dr = evaluateHand(dealer);
  const cmp = compareHands(pr, dr);
  let payout = 0;
  if (cmp > 0) payout = bet; else if (cmp < 0) payout = -bet; else payout = 0;
  return { player, dealer, pr, dr, payout };
}
function crimeAttempt() {
  const r = Math.random();
  if (r < 0.45) return { success: true, amount: randInt(5,50) };
  return { success: false, fine: randInt(10,60) };
}

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
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Voice features: ${ENABLE_VOICE ? 'ENABLED' : 'DISABLED'}`);
});

// Welcome / Farewell
client.on('guildMemberAdd', async (member) => {
  try { await client.channels.cache.get(WELCOME_CHANNEL_ID)?.send(`👋 Welcome, ${member}!`); } catch {}
  try { await member.send(`👋 Welcome to **${member.guild.name}**!`).catch(()=>{}); } catch {}
});
client.on('guildMemberRemove', async (member) => {
  try { await client.channels.cache.get(FAREWELL_CHANNEL_ID)?.send(`👋 Goodbye, **${member.user.tag}**!`); } catch {}
  try { await member.send(`😢 Sorry to see you leave **${member.guild.name}**.`).catch(()=>{}); } catch {}
});

// -----------------------------
// Message handler (the missing wrapper that broke everything)
// -----------------------------
client.on('messageCreate', async (message) => {
  try {
    // ignore bots
    if (message.author.bot) return;

    // AI mention response (if enabled) - no prefix
    if (message.mentions.has(client.user) && openai) {
      try {
        await message.channel.sendTyping();
        const userPrompt = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim() || 'Hi!';
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: 'You are Agnello FC Friendly Bot, a helpful, friendly Discord bot for managing friendlies, moderation, and chatting casually.' },
            { role: 'user', content: userPrompt },
          ],
        });
        const reply = completion.choices?.[0]?.message?.content?.trim() || "🤖 I don’t know what to say!";
        await message.reply(reply).catch(()=>{});
      } catch (err) {
        console.error('OpenAI reply error:', err);
        try { await message.reply('⚠️ Sorry, I had trouble coming up with a reply.').catch(()=>{}); } catch {}
      }
      return; // mention handled
    }

    // @everyone / @here quick react
    if (message.guild && (message.mentions?.everyone || message.content.includes('@here'))) {
      try { await message.react('✅').catch(()=>{}); } catch {}
    }

    // Profanity filter (delete + warn + optional VC mute)
    if (message.guild && message.content) {
      const lowered = message.content.toLowerCase();
      if (SWEARS.some((w) => lowered.includes(w))) {
        await message.delete().catch(()=>{});
        const cnt = (textWarnings.get(message.author.id) || 0) + 1;
        textWarnings.set(message.author.id, cnt);
        try { await message.author.send(`⚠️ Your message was removed for language.\n> ${message.content}\nThis is warning #${cnt}.`).catch(()=>{}); } catch {}
        safeGetLogChannel(message.guild)?.send(`🧹 Text profanity: ${message.author.tag}\nMessage: ${message.content}\nWarning #${cnt}`).catch(()=>{});
        const member = message.member;
        if (member && member.voice?.channel && member.manageable) {
          try {
            await member.voice.setMute(true, 'Auto-moderation: swearing');
            safeGetLogChannel(message.guild)?.send(`🔇 Auto VC mute applied to ${member.user.tag} for 10s`).catch(()=>{});
            setTimeout(async () => {
              try { if (member.voice?.channel) await member.voice.setMute(false, 'Auto-moderation expired'); } catch {}
            }, 10_000);
          } catch {}
        }
        return;
      }
    }

    // Commands only for guilds and prefix
    if (!message.content.startsWith(PREFIX) || !message.guild) return;
    const raw = message.content.slice(PREFIX.length).trim();
    if (!raw) return;
    const parts = raw.split(/\s+/);
    const cmd = parts.shift().toLowerCase();
    const args = parts;

    // ---------- PURGE ----------
    if (cmd === 'purge') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return message.reply('❌ You do not have permission to purge messages.').catch(()=>{});
      }
      const amount = parseInt(args[0], 10);
      if (isNaN(amount) || amount < 1 || amount > 100) {
        return message.reply('⚠️ Please enter a number between 1 and 100.').catch(()=>{});
      }
      try {
        const deleted = await message.channel.bulkDelete(amount, true);
        const confirmation = await message.channel.send(`✅ Deleted **${deleted.size}** messages.`).catch(()=>null);
        if (confirmation) setTimeout(() => confirmation.delete().catch(()=>{}), 5000);
      } catch (err) {
        console.error('Bulk delete error:', err);
        return message.reply('❌ I can not delete messages older than 14 days or an error occurred.').catch(()=>{});
      }
      return;
    }

    // ---------- hosttraining (creates signup message; reacts receive a DM link) ----------
    if (cmd === 'hosttraining') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID) && !message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        return message.reply('❌ You are not allowed to host trainings.').catch(()=>{});
      }

      await message.reply('✅ Send the training link below. You have 60 seconds.').catch(()=>{});

      const filter = (m) => m.author.id === message.author.id;
      const collector = message.channel.createMessageCollector({ filter, max: 1, time: 60_000 });

      collector.on('collect', async (collected) => {
        const link = collected.content.trim();
        if (!link.startsWith('http')) {
          return message.reply("❌ That doesn't look like a valid link. Training cancelled.").catch(()=>{});
        }

        const embed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle('📘 Training Signup')
          .setDescription(`React ✅ to receive the training link.\nHosted by <@${message.author.id}>`)
          .setTimestamp();

        const signupMsg = await message.channel.send({ embeds: [embed] }).catch(()=>null);
        if (!signupMsg) return message.reply('Failed to post training signup.').catch(()=>{});
        await signupMsg.react('✅').catch(()=>{});

        // increment hostfriendly count because hosting training also counts as hosting a host activity? 
        // User asked to track times people used !hostfriendly; increment only when !hostfriendly runs.
        // We will not auto-increment here; keep it separate. (But leaving placeholder if you want otherwise.)

        const rFilter = (reaction, user) => reaction.emoji.name === '✅' && !user.bot;
        const rCollector = signupMsg.createReactionCollector({ filter: rFilter });

        rCollector.on('collect', async (reaction, user) => {
          try {
            await user.send(`✅ Here is the training link:\n${link}`).catch(()=>{ throw new Error('DM closed'); });
          } catch {
            message.channel.send(`⚠️ <@${user.id}> has DMs closed. Could not send the link.`).catch(()=>{});
          }
        });
      });

      collector.on('end', (collected) => {
        if ((collected && collected.size === 0) || !collected) {
          message.reply('❌ You never sent a link. Training cancelled.').catch(()=>{});
        }
      });

      return;
    }

    // ---------- message (quick embed announcement) ----------
    if (cmd === 'message') {
      const content = args.join(' ');
      if (!content) return message.reply("❌ You need to actually write something.").catch(()=>{});
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('📢 Announcement')
        .setDescription(content)
        .setFooter({ text: `Sent by ${message.author.tag}` })
        .setTimestamp();
      return message.channel.send({ embeds: [embed] }).catch(()=>{});
    }

    // ---------- hostfriendly (lineup) ----------
    if (cmd === 'hostfriendly') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('❌ You are not allowed to host friendlies.').catch(()=>{});
      const positions = ['GK','CB','CB2','CM','LW','RW','ST'];
      const numbers = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
      const taken = Array(positions.length).fill(null);
      const lineup = {};

      // preclaim
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

      const buildEmbed = (state) => {
        const lines = state.positions.map((pos,i) => `${state.numbers[i]} ➜ **${pos}**\n${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n\n');
        const final = state.positions.map((pos,i) => `${pos}: ${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n');
        return new EmbedBuilder().setColor(0x00a86b).setTitle('AGNELLO FC 7v7 FRIENDLY').setDescription(lines + '\n\nReact to claim. Host can edit with `!editlineup` or `!resetlineup`.\n\n✅ **Final Lineup:**\n' + final);
      };

      const sent = await message.channel.send({ content: '@here', embeds: [buildEmbed({positions,numbers,taken,lineup})] }).catch(()=>null);
      if (!sent) return message.reply('Failed to post lineup.').catch(()=>{});

      for (const e of numbers) await sent.react(e).catch(()=>{});

      lineups.set(message.guild.id, { messageId: sent.id, channelId: sent.channel.id, positions, numbers, taken, lineup });

      // increment hostfriendly usage persistence (counts)
      incrementFriendlyCount(message.guild.id, message.author.id);

      const collector = sent.createReactionCollector({ filter: (r,u) => numbers.includes(r.emoji.name) && !u.bot });
      collector.on('collect', async (reaction, user) => {
        try {
          const state = lineups.get(message.guild.id);
          if (!state) return;
          const posIndex = state.numbers.indexOf(reaction.emoji.name);
          if (state.lineup[user.id] !== undefined) {
            reaction.users.remove(user.id).catch(()=>{});
            return message.channel.send(`<@${user.id}> ❌ You are already in the lineup!`).catch(()=>{});
          }
          if (state.taken[posIndex]) {
            reaction.users.remove(user.id).catch(()=>{});
            return message.channel.send(`<@${user.id}> ❌ Position taken.`).catch(()=>{});
          }
          state.taken[posIndex] = user.id;
          state.lineup[user.id] = posIndex;
          try { await user.send(`✅ Position confirmed: **${state.positions[posIndex]}**`).catch(()=>{}); } catch {}
          message.channel.send(`✅ ${state.positions[posIndex]} confirmed for <@${user.id}>`).catch(()=>{});
          const ch = await message.guild.channels.fetch(state.channelId).catch(()=>null);
          if (!ch) return;
          const msgToEdit = await ch.messages.fetch(state.messageId).catch(()=>null);
          if (!msgToEdit) return;
          await msgToEdit.edit({ embeds: [buildEmbed(state)] }).catch(()=>{});
        } catch (e) {
          console.error('Lineup reaction handling error:', e);
        }
      });

      return;
    }

    // ---------- editlineup ----------
    if (cmd === 'editlineup') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('Only host can edit lineup.').catch(()=>{});
      const state = lineups.get(message.guild.id);
      if (!state) return message.reply('No active lineup.').catch(()=>{});
      const posArg = args[0]?.toLowerCase();
      const user = message.mentions.users.first();
      if (!posArg || !user) return message.reply('Usage: `!editlineup <pos> @user`').catch(()=>{});
      let idx = -1;
      if (!Number.isNaN(Number(posArg))) idx = parseInt(posArg,10)-1;
      else idx = state.positions.findIndex(p => p.toLowerCase() === posArg);
      if (idx < 0 || idx >= state.positions.length) return message.reply('Invalid position.').catch(()=>{});
      if (state.taken[idx]) { const prev = state.taken[idx]; delete state.lineup[prev]; }
      if (state.lineup[user.id] !== undefined) { const old = state.lineup[user.id]; state.taken[old] = null; }
      state.taken[idx] = user.id; state.lineup[user.id] = idx;
      const ch = await message.guild.channels.fetch(state.channelId).catch(()=>null);
      if (!ch) return message.reply('Failed to fetch lineup message channel.').catch(()=>{});
      const msgToEdit = await ch.messages.fetch(state.messageId).catch(()=>null);
      if (!msgToEdit) return message.reply('Failed to fetch lineup message.').catch(()=>{});
      const newEmbed = (function build(s){ const lines = s.positions.map((pos,i)=> `${s.numbers[i]} ➜ **${pos}**\n${s.taken[i] ? `<@${s.taken[i]}>` : '_-_'}`).join('\n\n'); const final = s.positions.map((pos,i)=> `${pos}: ${s.taken[i] ? `<@${s.taken[i]}>` : '_-_'}`).join('\n'); return new EmbedBuilder().setColor(0x00a86b).setTitle('AGNELLO FC 7v7 FRIENDLY').setDescription(lines + '\n\n✅ **Final Lineup:**\n' + final); })(state);
      await msgToEdit.edit({ embeds: [newEmbed] }).catch(()=>{});
      return message.channel.send(`✏️ ${state.positions[idx]} updated → <@${user.id}>`).catch(()=>{});
    }

    // ---------- resetlineup ----------
    if (cmd === 'resetlineup') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('Only host can reset.').catch(()=>{});
      lineups.delete(message.guild.id);
      return message.channel.send('♻️ Lineup reset.').catch(()=>{});
    }

    // ---------- checkfriendly (new) ----------
    if (cmd === 'checkfriendly') {
      // usage: !checkfriendly [@user]
      const targetMention = message.mentions.users.first();
      if (targetMention) {
        const cnt = getFriendlyCountForUser(message.guild.id, targetMention.id);
        return message.channel.send(`${targetMention.tag} has hosted friendlies **${cnt}** time(s) in this server.`).catch(()=>{});
      }

      // show leaderboard for this guild
      const counts = getFriendlyCountsForGuild(message.guild.id);
      const entries = Object.entries(counts);
      if (entries.length === 0) {
        return message.channel.send('No hostfriendly uses recorded in this server yet.').catch(()=>{});
      }
      // sort desc
      entries.sort((a,b) => b[1] - a[1]);
      // fetch member tags (best-effort)
      const top = entries.slice(0, 10);
      const lines = await Promise.all(top.map(async ([userId, c], idx) => {
        let tag = userId;
        try {
          const member = await message.guild.members.fetch(userId).catch(()=>null);
          if (member) tag = member.user.tag;
          else {
            const user = await client.users.fetch(userId).catch(()=>null);
            if (user) tag = user.tag;
          }
        } catch {}
        return `${idx+1}. **${tag}** — ${c}`;
      }));
      const embed = new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('🏆 Hostfriendly leaderboard')
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'Use !checkfriendly @user for a specific user' });
      return message.channel.send({ embeds: [embed] }).catch(()=>{});
    }

    // ---------- HELP ----------
    if (cmd === 'help') {
      const helpEmbed = new EmbedBuilder()
        .setColor(0x00AAFF)
        .setTitle('📖 Agnello FC Friendly Bot — Help Menu')
        .setDescription('Commands and features')
        .addFields(
          { name: '⚽ Friendlies', value: '`!hostfriendly [pos|number]` — post a lineup (GK,CB,CB2,CM,LW,RW,ST). React to claim.' },
          { name: '🛠 Moderation', value: '`!ban @user`, `!unban <id>`, `!kick @user`, `!timeout @user <s>`, `!vmute @user`' },
          { name: '🎵 Music', value: '`!joinvc`, `!leavevc`, `!play <YouTubeURL>`, `!skip`, `!stop` (voice host required)' },
          { name: '👥 Activity', value: '`!activitycheck <goal>` — reacts with ✅' },
          { name: '✉️ DM Tools', value: '`!dmrole <roleId> <message>`, `!dmall <message>` (Admins only)' },
          { name: '💰 Economy & Games', value: '`!bal`, `!give @user <amt>`, `!spin`, `!coin`, `!slots`, `!blackjack`, `!poker`, `!crime`' },
        )
        .setFooter({ text: 'Agnello FC Bot — Built for 7v7 Friendlies ⚽' });
      return message.channel.send({ embeds: [helpEmbed] }).catch(()=>{});
    }

    // ---------------- Moderation commands ----------------
    if (cmd === 'ban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('❌ Missing permission: BanMembers').catch(()=>{});
      const t = message.mentions.members.first();
      const reason = args.slice(1).join(' ') || 'No reason';
      if (!t) return message.reply('Usage: `!ban @user [reason]`').catch(()=>{});
      await t.ban({ reason }).catch(e => message.reply(`Failed: ${e.message}`).catch(()=>{}));
      message.channel.send(`🔨 Banned ${t.user.tag}`).catch(()=>{});
      safeGetLogChannel(message.guild)?.send(`🔨 Ban: ${message.author.tag} -> ${t.user.tag} — ${reason}`).catch(()=>{});
      return;
    }

    if (cmd === 'unban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('❌ Missing permission: BanMembers').catch(()=>{});
      const id = args[0];
      if (!id) return message.reply('Usage: `!unban <userId>`').catch(()=>{});
      await message.guild.bans.remove(id).catch(e => message.reply(`Failed: ${e.message}`).catch(()=>{}));
      message.channel.send(`✅ Unbanned ${id}`).catch(()=>{});
      safeGetLogChannel(message.guild)?.send(`✅ Unban: ${message.author.tag} -> ${id}`).catch(()=>{});
      return;
    }

    if (cmd === 'kick') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('❌ Missing permission: KickMembers').catch(()=>{});
      const t = message.mentions.members.first();
      const reason = args.slice(1).join(' ') || 'No reason';
      if (!t) return message.reply('Usage: `!kick @user [reason]`').catch(()=>{});
      await t.kick(reason).catch(e => message.reply(`Failed: ${e.message}`).catch(()=>{}));
      message.channel.send(`👢 Kicked ${t.user.tag}`).catch(()=>{});
      safeGetLogChannel(message.guild)?.send(`👢 Kick: ${message.author.tag} -> ${t.user.tag} — ${reason}`).catch(()=>{});
      return;
    }

    if (cmd === 'timeout') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('❌ Missing permission: ModerateMembers').catch(()=>{});
      const t = message.mentions.members.first();
      const seconds = parseInt(args[1] || args[0], 10);
      if (!t || Number.isNaN(seconds)) return message.reply('Usage: `!timeout @user <seconds>`').catch(()=>{});
      await t.timeout(seconds * 1000, `By ${message.author.tag}`).catch(e => message.reply(`Failed: ${e.message}`).catch(()=>{}));
      message.channel.send(`⏲️ Timed out ${t.user.tag} for ${seconds}s`).catch(()=>{});
      safeGetLogChannel(message.guild)?.send(`⏲️ Timeout: ${message.author.tag} -> ${t.user.tag} (${seconds}s)`).catch(()=>{});
      return;
    }

    if (cmd === 'vmute') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('❌ Missing permission: ModerateMembers').catch(()=>{});
      const t = message.mentions.members.first();
      if (!t) return message.reply('Usage: `!vmute @user`').catch(()=>{});
      if (!t.voice?.channel) return message.reply('User not in VC.').catch(()=>{});
      await t.voice.setMute(true, `Manual VMute by ${message.author.tag}`).catch(e => message.reply(`Failed: ${e.message}`).catch(()=>{}));
      message.channel.send(`🔇 Voice-muted ${t.user.tag}`).catch(()=>{});
      safeGetLogChannel(message.guild)?.send(`🔇 VMute: ${message.author.tag} -> ${t.user.tag}`).catch(()=>{});
      return;
    }

    // ---------------- DM utilities ----------------
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
        m.send(`${text}\n\n*dm sent by ${message.author.tag}*`).catch(()=>{});
        count++;
      }
      message.channel.send(`📩 DMed ${count} members with role <@&${role.id}>.`).catch(()=>{});
      return;
    }

    if (cmd === 'dmall') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('Admins only.').catch(()=>{});
      const text = args.join(' ');
      if (!text) return message.reply('Usage: `!dmall <message>`').catch(()=>{});
      const members = await message.guild.members.fetch();
      let count = 0;
      for (const m of members.values()) {
        if (m.user.bot) continue;
        m.send(`${text}\n\n*dm sent by ${message.author.tag}*`).catch(()=>{});
        count++;
      }
      message.channel.send(`📩 DMed ${count} members.`).catch(()=>{});
      return;
    }

    // ---------- activitycheck ----------
    if (cmd === 'activitycheck') {
      const goal = Math.max(1, parseInt(args[0],10) || 40);
      const emb = new EmbedBuilder().setColor(0x2b6cb0).setTitle('📊 Activity Check').setDescription(`React with ✅ to check in!\nGoal: **${goal}** members.`);
      const m = await message.channel.send({ content: '@here', embeds: [emb] }).catch(()=>null);
      if (m) await m.react('✅').catch(()=>{});
      return;
    }

    // ---------- voice join/leave (music) ----------
    if (cmd === 'joinvc') {
      if (!ENABLE_VOICE) return message.reply('⚠️ Voice disabled on this host.').catch(()=>{});
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a voice channel first.').catch(()=>{});
      joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
      return message.channel.send('✅ Joined VC.').catch(()=>{});
    }
    if (cmd === 'leavevc') {
      const conn = getVoiceConnection(message.guild.id);
      if (!conn) return message.reply('Not connected.').catch(()=>{});
      conn.destroy();
      return message.channel.send('👋 Left VC.').catch(()=>{});
    }

    if (cmd === 'play') {
      if (!ENABLE_VOICE) return message.reply('⚠️ Voice disabled on this host.').catch(()=>{});
      const url = args[0];
      if (!url || !ytdl.validateURL(url)) return message.reply('Usage: `!play <YouTubeURL>`').catch(()=>{});
      const vc = message.member.voice.channel;
      if (!vc) return message.reply('Join a voice channel first.').catch(()=>{});

      const q = musicQueues.get(message.guild.id) || [];
      const info = await ytdl.getInfo(url).catch(()=>null);
      const title = info?.videoDetails?.title || url;
      q.push({ title, url });
      musicQueues.set(message.guild.id, q);
      message.channel.send(`➕ Queued **${title}**`).catch(()=>{});

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
          else message.channel.send('⏹️ Queue finished.').catch(()=>{});
        });
        player.on('error', e => message.channel.send(`Player error: ${e.message}`).catch(()=>{}));
      }

      const curQ = musicQueues.get(message.guild.id) || [];
      if (curQ.length === 1) await playTrack(message.guild.id, url, message.channel);
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

    // ---------- Economy & games ----------
    ensureUser(message.author.id);

    if (cmd === 'start') return message.reply(`You have ${getBal(message.author.id)} Robux (new users start with 10).`).catch(()=>{});
    if (cmd === 'bal' || cmd === 'balance') return message.reply(`${message.author}, your balance: **${getBal(message.author.id)} Robux**`).catch(()=>{});

    if (cmd === 'give') {
      const target = message.mentions.users.first();
      const amtArg = args[1] || args[0];
      const amt = parseInt(amtArg,10);
      if (!target || Number.isNaN(amt) || amt <= 0) return message.reply('Usage: `!give @user <amount>`').catch(()=>{});
      if (getBal(message.author.id) < amt) return message.reply('Insufficient funds.').catch(()=>{});
      subBal(message.author.id, amt);
      addBal(target.id, amt);
      return message.reply(`✅ Sent ${amt} Robux to ${target.tag}. New balance: ${getBal(message.author.id)} Robux`).catch(()=>{});
    }

    if (cmd === 'spin') {
      const bet = parseBet(args[0], getBal(message.author.id));
      if (!bet) return message.reply('Usage: `!spin <amount|all|<percent>%>`').catch(()=>{});
      if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.').catch(()=>{});
      subBal(message.author.id, bet);
      const win = spinWheel(bet);
      if (win > 0) { addBal(message.author.id, win); return message.reply(`🎡 You spun and won **${win} Robux**! New balance: ${getBal(message.author.id)}`).catch(()=>{}); }
      return message.reply(`🎡 Bad luck — you lost ${bet} Robux. New balance: ${getBal(message.author.id)}`).catch(()=>{});
    }

    if (cmd === 'coin') {
      const bet = parseBet(args[0], getBal(message.author.id));
      if (!bet) return message.reply('Usage: `!coin <amount|all|<percent>%>`').catch(()=>{});
      if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.').catch(()=>{});
      const res = coinFlip(bet);
      if (res > 0) { addBal(message.author.id, res); return message.reply(`🪙 You won ${res} Robux! New balance: ${getBal(message.author.id)}`).catch(()=>{}); }
      subBal(message.author.id, bet); return message.reply(`🪙 You lost ${bet} Robux. New balance: ${getBal(message.author.id)}`).catch(()=>{});
    }

    if (cmd === 'slots') {
      const bet = parseBet(args[0], getBal(message.author.id));
      if (!bet) return message.reply('Usage: `!slots <amount|all|<percent>%>`').catch(()=>{});
      if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.').catch(()=>{});
      subBal(message.author.id, bet);
      const { display, payout } = slotsResult(bet);
      if (payout > 0) addBal(message.author.id, payout);
      return message.reply(`🎰 ${display}\n${payout>0?`You won ${payout} Robux!`:`You lost ${bet} Robux.`}\nNew balance: ${getBal(message.author.id)}`).catch(()=>{});
    }

    if (cmd === 'blackjack' || cmd === 'bj') {
      const bet = parseBet(args[0], getBal(message.author.id));
      if (!bet) return message.reply('Usage: `!blackjack <amount|all|<percent>%>`').catch(()=>{});
      if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.').catch(()=>{});
      subBal(message.author.id, bet);
      const res = blackjackResolve(bet);
      if (res.payout > 0) addBal(message.author.id, res.payout);
      const ph = res.player.map(c=>c.rank).join(' ');
      const dh = res.dealer.map(c=>c.rank).join(' ');
      const resultText = res.result === 'push' ? 'Push — bet returned.' : (res.payout>0?`You win ${res.payout} Robux!`:`You lose ${-res.payout} Robux.`);
      return message.reply(`🃏 Blackjack\nYour hand: ${ph} (${res.pv})\nDealer: ${dh} (${res.dv})\n${resultText}\nNew balance: ${getBal(message.author.id)}`).catch(()=>{});
    }

    if (cmd === 'poker') {
      const bet = parseBet(args[0], getBal(message.author.id));
      if (!bet) return message.reply('Usage: `!poker <amount|all|<percent>%>`').catch(()=>{});
      if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.').catch(()=>{});
      subBal(message.author.id, bet);
      const res = pokerResolve(bet);
      if (res.payout > 0) addBal(message.author.id, res.payout);
      const ph = res.player.map(c=>`${c.r}${c.s}`).join(' ');
      const dh = res.dealer.map(c=>`${c.r}${c.s}`).join(' ');
      const outcome = res.payout>0?`You won ${res.payout} Robux!`:(res.payout<0?`You lost ${-res.payout} Robux.`:'Push.');
      return message.reply(`🂡 Poker (5-card)\nYour hand: ${ph} — ${res.pr.name}\nDealer: ${dh} — ${res.dr.name}\n${outcome}\nNew balance: ${getBal(message.author.id)}`).catch(()=>{});
    }

    if (cmd === 'crime') {
      const r = crimeAttempt();
      if (r.success) { addBal(message.author.id, r.amount); safeGetLogChannel(message.guild)?.send(`🕵️‍♂️ Crime success: ${message.author.tag} got ${r.amount}`).catch(()=>{}); return message.reply(`💰 Crime succeeded! You stole **${r.amount} Robux**. New balance: ${getBal(message.author.id)}`).catch(()=>{}); }
      const loss = Math.min(getBal(message.author.id), r.fine);
      subBal(message.author.id, loss);
      safeGetLogChannel(message.guild)?.send(`🚔 Crime failed: ${message.author.tag} fined ${loss}`).catch(()=>{});
      return message.reply(`🚨 You got caught! You paid **${loss} Robux** in fines. New balance: ${getBal(message.author.id)}`).catch(()=>{});
    }

    // unknown command -> ignore silently
  } catch (err) {
    console.error('messageCreate handler error:', err);
  }
});

// -----------------------------
// Audio helper
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
    console.error('playTrack error:', e);
    await textChannel.send(`Failed to play track: ${e.message}`).catch(()=>{});
  }
}

// -----------------------------
// Keepalive server
// -----------------------------
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req,res) => res.send('✅ Agnello FC Bot is alive and running!'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌍 Keepalive server listening on http://0.0.0.0:${PORT}`));

// -----------------------------
// Process events & login
// -----------------------------
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

if (!TOKEN) {
  console.error('❌ Missing TOKEN env var. Set TOKEN in environment.');
  process.exit(1);
}
client.login(TOKEN).catch(e => { console.error('Failed to login:', e); process.exit(1); });
