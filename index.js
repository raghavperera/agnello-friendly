// index.js
// Agnello FC Friendly Bot — Consolidated & Fixed (purge + AI mention responses merged)
// Node 18+ / ESM / discord.js v14
// -------------------------------------------------

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import express from 'express';
import OpenAI from 'openai';
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
// ENV / CONFIG (edit IDs as needed)
// -----------------------------
const TOKEN = process.env.TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || null;
const ENABLE_VOICE = process.env.ENABLE_VOICE === 'true'; // set true only on UDP-capable VPS
const LOG_CHANNEL_ID = '1362214241091981452'; // logging channel (server-specific)
const HOST_ROLE_ID = '1383970211933454378'; // hostfriendly role
const WELCOME_CHANNEL_ID = '1403929923084882012';
const FAREWELL_CHANNEL_ID = '1403930222222643220';
const PREFIX = '!';

const ECON_FILE = path.join(process.cwd(), 'economy.json'); // economy persistence

// -----------------------------
// Basic Profanity list (non-exhaustive)
// Avoid adding hateful slurs per community rules.
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

function getLogChannel(guild) {
  if (!guild) return null;
  const ch = guild.channels.cache.get(LOG_CHANNEL_ID);
  return ch || null;
}

// -----------------------------
// OpenAI client (optional; only used if OPENAI_API_KEY present)
// -----------------------------
let openai = null;
if (OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: OPENAI_API_KEY });
} else {
  console.warn('⚠️ OPENAI_API_KEY not set — AI mention responses will be disabled.');
}

// -----------------------------
// Economy persistence (simple file)
// -----------------------------
let ECON = {};
try {
  if (!fs.existsSync(ECON_FILE)) fs.writeFileSync(ECON_FILE, JSON.stringify({}), 'utf8');
  ECON = JSON.parse(fs.readFileSync(ECON_FILE, 'utf8') || '{}');
} catch (e) {
  console.error('Failed to load economy file:', e);
  ECON = {};
}
function saveEconomy() {
  try {
    fs.writeFileSync(ECON_FILE, JSON.stringify(ECON, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save economy file:', e);
  }
}
function ensureUser(id) {
  if (!ECON[id]) ECON[id] = { balance: 10 };
  return ECON[id];
}
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
// Games: spin, coin, slots, blackjack, poker, crime
// -----------------------------
function spinWheel(bet) {
  const wheel = [0,0,0,0,0,1,1,2,2,3,5,10,20,50]; // multipliers
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

// Blackjack helpers (auto-play simplified)
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

// Poker: 5-card showdown (basic ranking)
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

// Crime
function crimeAttempt() {
  const r = Math.random();
  if (r < 0.45) return { success: true, amount: randInt(5,50) };
  return { success: false, fine: randInt(10,60) };
}

// -----------------------------
// in-memory stores
// -----------------------------
const textWarnings = new Map(); // userId -> count
const musicQueues = new Map();  // guildId -> [{title,url}]
const audioPlayers = new Map(); // guildId -> AudioPlayer
const lineups = new Map();      // guildId -> lineup state

// -----------------------------
// CLIENT creation
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

// -----------------------------
// READY
// -----------------------------
client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  console.log(`Voice features: ${ENABLE_VOICE ? 'ENABLED (UDP host required)' : 'DISABLED (Render-safe)'}`);
});

// -----------------------------
// Welcome / Farewell
// -----------------------------
client.on('guildMemberAdd', async (member) => {
  try { client.channels.cache.get(WELCOME_CHANNEL_ID)?.send(`👋 Welcome, ${member}!`); } catch {}
  try { await member.send(`👋 Welcome to **${member.guild.name}**!`); } catch {}
});
client.on('guildMemberRemove', async (member) => {
  try { client.channels.cache.get(FAREWELL_CHANNEL_ID)?.send(`👋 Goodbye, **${member.user.tag}**!`); } catch {}
  try { await member.send(`😢 Sorry to see you leave **${member.guild.name}**.`); } catch {}
});

// -----------------------------
// Single messageCreate handler (all commands, auto behavior, purge, AI mention)
// -----------------------------
client.on('messageCreate', async (message) => {
  try {
    // ignore bots
    if (message.author.bot) return;

    // --- AI mention response: if bot is mentioned (no prefix) ---
    if (message.mentions.has(client.user) && openai) {
      try {
        await message.channel.sendTyping();

        // remove mention text from content
        const userPrompt = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();

        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: "You are Agnello FC Friendly Bot, a helpful, funny, and friendly Discord bot for managing friendlies, moderation, and chatting casually." },
            { role: "user", content: userPrompt || "Hi!" },
          ],
        });

        const reply = completion.choices?.[0]?.message?.content?.trim() || "🤖 I don’t know what to say!";
        await message.reply(reply);
      } catch (err) {
        console.error('OpenAI reply error:', err);
        try { await message.reply('⚠️ Sorry, I had trouble coming up with a reply.'); } catch {}
      }
      return; // handle mention only, don't process as command
    }

    // --- Auto react to @everyone / @here ---
    if (message.guild && (message.mentions?.everyone || message.content.includes('@here'))) {
      try { await message.react('✅'); } catch {}
    }

    // --- Profanity filter (text) ---
    if (message.guild && message.content) {
      const lowered = message.content.toLowerCase();
      if (SWEARS.some(w => lowered.includes(w))) {
        // delete message, warn, DM, log
        await message.delete().catch(() => {});
        const cnt = (textWarnings.get(message.author.id) || 0) + 1;
        textWarnings.set(message.author.id, cnt);
        try {
          await message.author.send(`⚠️ Your message was removed for language.\n> ${message.content}\nThis is warning #${cnt}.`);
        } catch {}
        getLogChannel(message.guild)?.send(`🧹 Text profanity: ${message.author.tag}\nMessage: ${message.content}\nWarning #${cnt}`);

        // if member is in VC, attempt to mute for 10s
        const member = message.member;
        if (member && member.voice?.channel && member.manageable) {
          try {
            await member.voice.setMute(true, 'Auto-moderation: swearing');
            getLogChannel(message.guild)?.send(`🔇 Auto VC mute applied to ${member.user.tag} for 10s`);
            setTimeout(async () => {
              try { if (member.voice?.channel) await member.voice.setMute(false, 'Auto-moderation expired'); } catch {}
            }, 10_000);
          } catch {}
        }
      }
    }

    // --- Commands only for guilds (prefix) ---
    if (!message.content.startsWith(PREFIX) || !message.guild) return;
    const raw = message.content.slice(PREFIX.length).trim();
    if (!raw) return;
    const parts = raw.split(/\s+/);
    const cmd = parts.shift().toLowerCase();
    const args = parts;

    // ---------- Purge ----------
    if (cmd === 'purge') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return message.reply('❌ You don’t have permission to purge messages.');
      }
      const amount = parseInt(args[0], 10);
      if (isNaN(amount) || amount < 1 || amount > 100) {
        return message.reply('⚠️ Please enter a number between 1 and 100.');
      }
      await message.channel.bulkDelete(amount, true)
        .then(deleted => {
          message.channel.send(`✅ Deleted **${deleted.size}** messages.`)
            .then(msg => setTimeout(() => msg.delete(), 5000));
        })
        .catch(err => {
          console.error(err);
          message.reply('❌ I can’t delete messages older than 14 days.');
        });
      return;
    }

    // ---------- HELP ----------
    if (cmd === 'help') {
      const helpEmbed = new EmbedBuilder()
        .setColor('#00AAFF')
        .setTitle('📖 Agnello FC Friendly Bot — Help Menu')
        .setDescription('Commands and features:')
        .addFields(
          { name: '⚽ Friendlies', value: '`!hostfriendly [pos|number]` — post a lineup (GK,CB,CB2,CM,LW,RW,ST). React to claim.' },
          { name: '🛠 Moderation', value: '`!ban @user`, `!unban <id>`, `!kick @user`, `!timeout @user <s>`, `!vmute @user`' },
          { name: '🎵 Music', value: '`!joinvc`, `!leavevc`, `!play <YouTubeURL>`, `!skip`, `!stop` (voice host required)' },
          { name: '👥 Activity', value: '`!activitycheck <goal>` — reacts with ✅' },
          { name: '✉️ DM Tools', value: '`!dmrole <roleId> <message>`, `!dmall <message>` (Admins only)' },
          { name: '💰 Economy & Games', value: '`!bal`, `!give @user <amt>`, `!spin`, `!coin`, `!slots`, `!blackjack`, `!poker`, `!crime`' },
        )
        .setFooter({ text: 'Agnello FC Bot — Built for 7v7 Friendlies ⚽' });
      return message.channel.send({ embeds: [helpEmbed] });
    }

    // ---------- Moderation ----------
    if (cmd === 'ban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('❌ Missing permission: BanMembers');
      const t = message.mentions.members.first();
      const reason = args.slice(1).join(' ') || 'No reason';
      if (!t) return message.reply('Usage: `!ban @user [reason]`');
      await t.ban({ reason }).catch(e => message.reply(`Failed: ${e.message}`));
      message.channel.send(`🔨 Banned ${t.user.tag}`);
      getLogChannel(message.guild)?.send(`🔨 Ban: ${message.author.tag} -> ${t.user.tag} — ${reason}`);
      return;
    }

    if (cmd === 'unban') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('❌ Missing permission: BanMembers');
      const id = args[0];
      if (!id) return message.reply('Usage: `!unban <userId>`');
      await message.guild.bans.remove(id).catch(e => message.reply(`Failed: ${e.message}`));
      message.channel.send(`✅ Unbanned ${id}`);
      getLogChannel(message.guild)?.send(`✅ Unban: ${message.author.tag} -> ${id}`);
      return;
    }

    if (cmd === 'kick') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('❌ Missing permission: KickMembers');
      const t = message.mentions.members.first();
      const reason = args.slice(1).join(' ') || 'No reason';
      if (!t) return message.reply('Usage: `!kick @user [reason]`');
      await t.kick(reason).catch(e => message.reply(`Failed: ${e.message}`));
      message.channel.send(`👢 Kicked ${t.user.tag}`);
      getLogChannel(message.guild)?.send(`👢 Kick: ${message.author.tag} -> ${t.user.tag} — ${reason}`);
      return;
    }

    if (cmd === 'timeout') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('❌ Missing permission: ModerateMembers');
      const t = message.mentions.members.first();
      const seconds = parseInt(args[1] || args[0], 10);
      if (!t || Number.isNaN(seconds)) return message.reply('Usage: `!timeout @user <seconds>`');
      await t.timeout(seconds * 1000, `By ${message.author.tag}`).catch(e => message.reply(`Failed: ${e.message}`));
      message.channel.send(`⏲️ Timed out ${t.user.tag} for ${seconds}s`);
      getLogChannel(message.guild)?.send(`⏲️ Timeout: ${message.author.tag} -> ${t.user.tag} (${seconds}s)`);
      return;
    }

    if (cmd === 'vmute') {
      if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('❌ Missing permission: ModerateMembers');
      const t = message.mentions.members.first();
      if (!t) return message.reply('Usage: `!vmute @user`');
      if (!t.voice?.channel) return message.reply('User not in VC.');
      await t.voice.setMute(true, `Manual VMute by ${message.author.tag}`).catch(e => message.reply(`Failed: ${e.message}`));
      message.channel.send(`🔇 Voice-muted ${t.user.tag}`);
      getLogChannel(message.guild)?.send(`🔇 VMute: ${message.author.tag} -> ${t.user.tag}`);
      return;
    }

    // ---------- DM utilities ----------
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
        m.send(`${text}\n\n*dm sent by ${message.author.tag}*`).catch(() => {});
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
      let count = 0;
      for (const m of members.values()) {
        if (m.user.bot) continue;
        m.send(`${text}\n\n*dm sent by ${message.author.tag}*`).catch(() => {});
        count++;
      }
      message.channel.send(`📩 DMed ${count} members.`);
      return;
    }

    // ---------- Activity check ----------
    if (cmd === 'activitycheck') {
      const goal = Math.max(1, parseInt(args[0],10) || 40);
      const emb = new EmbedBuilder().setColor(0x2b6cb0).setTitle('📊 Activity Check').setDescription(`React with ✅ to check in!\nGoal: **${goal}** members.`);
      const m = await message.channel.send({ content: '@here', embeds: [emb] });
      await m.react('✅');
      return;
    }

    // ---------- Voice controls ----------
    if (cmd === 'joinvc') {
      if (!ENABLE_VOICE) return message.reply('⚠️ Voice disabled on this host.');
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

    // ---------- Music (YouTube) ----------
    if (cmd === 'play') {
      if (!ENABLE_VOICE) return message.reply('⚠️ Voice disabled on this host.');
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
        player.on('error', e => message.channel.send(`Player error: ${e.message}`));
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

    // ---------- Hostfriendly lineup ----------
    if (cmd === 'hostfriendly') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('❌ You are not allowed to host friendlies.');
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
        if (idx >=0 && idx < positions.length && !taken[idx]) {
          taken[idx] = message.author.id;
          lineup[message.author.id] = idx;
        }
      }

      const buildEmbed = (state) => {
        const lines = state.positions.map((pos,i) => `${state.numbers[i]} ➜ **${pos}**\n${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n\n');
        const final = state.positions.map((pos,i) => `${pos}: ${state.taken[i] ? `<@${state.taken[i]}>` : '_-_'}`).join('\n');
        return new EmbedBuilder().setColor(0x00a86b).setTitle('AGNELLO FC 7v7 FRIENDLY').setDescription(lines + '\n\nReact to claim. Host can edit with `!editlineup` or `!resetlineup`.\n\n✅ **Final Lineup:**\n' + final);
      };

      const sent = await message.channel.send({ content: '@here', embeds: [buildEmbed({positions,numbers,taken,lineup})] });
      for (const e of numbers) await sent.react(e);

      lineups.set(message.guild.id, { messageId: sent.id, channelId: sent.channel.id, positions, numbers, taken, lineup });

      const collector = sent.createReactionCollector({ filter: (r,u) => numbers.includes(r.emoji.name) && !u.bot });
      collector.on('collect', async (reaction, user) => {
        const state = lineups.get(message.guild.id);
        if (!state) return;
        const posIndex = state.numbers.indexOf(reaction.emoji.name);
        if (state.lineup[user.id] !== undefined) { reaction.users.remove(user.id).catch(()=>{}); message.channel.send(`<@${user.id}> ❌ You are already in the lineup!`); return; }
        if (state.taken[posIndex]) { reaction.users.remove(user.id).catch(()=>{}); message.channel.send(`<@${user.id}> ❌ Position taken.`); return; }
        state.taken[posIndex] = user.id;
        state.lineup[user.id] = posIndex;
        try { await user.send(`✅ Position confirmed: **${state.positions[posIndex]}**`); } catch {}
        message.channel.send(`✅ ${state.positions[posIndex]} confirmed for <@${user.id}>`);
        const ch = await message.guild.channels.fetch(state.channelId);
        const msgToEdit = await ch.messages.fetch(state.messageId);
        await msgToEdit.edit({ embeds: [buildEmbed(state)] }).catch(()=>{});
      });

      return;
    }

    if (cmd === 'editlineup') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('Only host can edit lineup.');
      const state = lineups.get(message.guild.id);
      if (!state) return message.reply('No active lineup.');
      const posArg = args[0]?.toLowerCase();
      const user = message.mentions.users.first();
      if (!posArg || !user) return message.reply('Usage: `!editlineup <pos> @user`');
      let idx = -1;
      if (!Number.isNaN(Number(posArg))) idx = parseInt(posArg,10)-1;
      else idx = state.positions.findIndex(p => p.toLowerCase() === posArg);
      if (idx < 0 || idx >= state.positions.length) return message.reply('Invalid position.');
      if (state.taken[idx]) { const prev = state.taken[idx]; delete state.lineup[prev]; }
      if (state.lineup[user.id] !== undefined) { const old = state.lineup[user.id]; state.taken[old] = null; }
      state.taken[idx] = user.id; state.lineup[user.id] = idx;
      const ch = await message.guild.channels.fetch(state.channelId);
      const msgToEdit = await ch.messages.fetch(state.messageId);
      await msgToEdit.edit({ embeds: [ (function build(s){ const lines = s.positions.map((pos,i)=> `${s.numbers[i]} ➜ **${pos}**\n${s.taken[i] ? `<@${s.taken[i]}>` : '_-_'}`).join('\n\n'); const final = s.positions.map((pos,i)=> `${pos}: ${s.taken[i] ? `<@${s.taken[i]}>` : '_-_'}`).join('\n'); return new EmbedBuilder().setColor(0x00a86b).setTitle('AGNELLO FC 7v7 FRIENDLY').setDescription(lines + '\n\n✅ **Final Lineup:**\n' + final); })(state) ] }).catch(()=>{});
      return message.channel.send(`✏️ ${state.positions[idx]} updated → <@${user.id}>`);
    }

    if (cmd === 'resetlineup') {
      if (!message.member.roles.cache.has(HOST_ROLE_ID)) return message.reply('Only host can reset.');
      lineups.delete(message.guild.id);
      return message.channel.send('♻️ Lineup reset.');
    }

    // ---------- Economy & Gambling commands ----------
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
      const bet = parseBet(args[0], getBal(message.author.id));
      if (!bet) return message.reply('Usage: `!poker <amount|all|<percent>%>`');
      if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.');
      subBal(message.author.id, bet);
      const res = pokerResolve(bet);
      if (res.payout > 0) addBal(message.author.id, res.payout);
      const ph = res.player.map(c=>`${c.r}${c.s}`).join(' ');
      const dh = res.dealer.map(c=>`${c.r}${c.s}`).join(' ');
      const outcome = res.payout>0?`You won ${res.payout} Robux!`:(res.payout<0?`You lost ${-res.payout} Robux.`:'Push.');
      return message.reply(`🂡 Poker (5-card)\nYour hand: ${ph} — ${res.pr.name}\nDealer: ${dh} — ${res.dr.name}\n${outcome}\nNew balance: ${getBal(message.author.id)}`);
    }

    if (cmd === 'crime') {
      const r = crimeAttempt();
      if (r.success) { addBal(message.author.id, r.amount); getLogChannel(message.guild)?.send(`🕵️‍♂️ Crime success: ${message.author.tag} got ${r.amount}`); return message.reply(`💰 Crime succeeded! You stole **${r.amount} Robux**. New balance: ${getBal(message.author.id)}`); }
      const loss = Math.min(getBal(message.author.id), r.fine);
      subBal(message.author.id, loss);
      getLogChannel(message.guild)?.send(`🚔 Crime failed: ${message.author.tag} fined ${loss}`);
      return message.reply(`🚨 You got caught! You paid **${loss} Robux** in fines. New balance: ${getBal(message.author.id)}`);
    }

    // unknown command -> ignore
  } catch (err) {
    console.error('messageCreate handler error:', err);
  }
});

// -----------------------------
// Audio play helper
// -----------------------------
async function playTrack(guildId, url, textChannel) {
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
  await textChannel.send(`🎶 Playing **${info?.videoDetails?.title || url}**`);
}

// -----------------------------
// Keepalive web server for Render (or any host that expects binding)
// -----------------------------
const app = express();
const PORT = process.env.PORT || 10000;
app.get('/', (req,res) => res.send('✅ Agnello FC Bot is alive and running!'));
app.listen(PORT, '0.0.0.0', () => console.log(`🌍 Keepalive server listening on http://0.0.0.0:${PORT}`));

// -----------------------------
// Final: login
// -----------------------------
if (!TOKEN) {
  console.error('❌ Missing TOKEN env var. Set TOKEN in environment.');
  process.exit(1);
}
client.login(TOKEN).catch(e => { console.error('Failed to login:', e); process.exit(1); });