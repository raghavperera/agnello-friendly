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
import fs from 'fs';
import path from 'path';

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
// -----------------------------
// Economy System
// -----------------------------
const economyFile = path.resolve('./economy.json');
let economy = {};

// Load economy data
if (fs.existsSync(economyFile)) {
  try {
    economy = JSON.parse(fs.readFileSync(economyFile, 'utf8'));
  } catch (err) {
    console.error("Failed to parse economy.json:", err);
    economy = {};
  }
}

// Save economy data
function saveEconomy() {
  fs.writeFileSync(economyFile, JSON.stringify(economy, null, 2));
}

function getBal(userId) {
  if (!economy[userId]) {
    economy[userId] = { balance: 10 }; // everyone starts with 10 Robux
    saveEconomy();
  }
  return economy[userId].balance;
}

function addBal(userId, amt) {
  getBal(userId);
  economy[userId].balance += amt;
  saveEconomy();
}
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
// --- !help Command ---
if (message.content.toLowerCase().startsWith("!help")) {
    const helpEmbed = new EmbedBuilder()
        .setColor("#00AAFF")
        .setTitle("📖 Agnello FC Friendly Bot — Help Menu")
        .setDescription("Here are all the available commands and features:")
        .addFields(
            { name: "⚽ Friendlies", value: "`!hostfriendly` — Post reaction-role lineup (GK, CB, CB2, CM, LW, RW, ST)" },
            { name: "🛠 Moderation", value: "`!ban @user`\n`!unban <userId>`\n`!kick @user`\n`!timeout @user <seconds>`\n`!vmute @user` (voice mute)" },
            { name: "🎵 Music", value: "`!joinvc`\n`!leavevc`\n`!play <YouTubeURL>`\n`!skip`\n`!stop`" },
            { name: "👥 Activity", value: "`!activitycheck <goal>` — Start activity check with ✅ reactions" },
            { name: "✉️ DM Tools", value: "`!dmrole <roleId> <message>`\n`!dmall <message>` (Admins only)" },
            { name: "📢 Auto Features", value: "✅ Reacts to @everyone/@here\n🧹 Auto deletes swears in chat\n🎤 Auto VC mute (if on UDP-enabled host)\n👋 Welcome + Farewell messages with DMs" },
        )
        .setFooter({ text: "Agnello FC Bot — Built for 7v7 Friendlies ⚽" });

    message.channel.send({ embeds: [helpEmbed] });
}
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
// ---------------------------
// Economy & Gambling Module
// ---------------------------
// Requires: fs imported at top of file
// Persist file: './economy.json'
// Add these commands to your message handler (prefix-based)

import fs from 'fs';
import path from 'path';

const ECON_FILE = path.join(process.cwd(), 'economy.json');

// load or init file
function loadEconomy() {
  try {
    if (!fs.existsSync(ECON_FILE)) {
      fs.writeFileSync(ECON_FILE, JSON.stringify({}), 'utf8');
    }
    const raw = fs.readFileSync(ECON_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (e) {
    console.error('Failed to load economy file:', e);
    return {};
  }
}
function saveEconomy(data) {
  try {
    fs.writeFileSync(ECON_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Failed to save economy file:', e);
  }
}

let ECON = loadEconomy();

// ensure user exists
function ensureUser(id) {
  if (!ECON[id]) ECON[id] = { balance: 10 }; // start with 10 robux by default
  return ECON[id];
}

function getBal(id) {
  const u = ensureUser(id);
  return u.balance || 0;
}
function setBal(id, amount) {
  ensureUser(id);
  ECON[id].balance = Math.max(0, Math.floor(amount));
  saveEconomy(ECON);
}
function addBal(id, amount) {
  ensureUser(id);
  ECON[id].balance = Math.max(0, Math.floor((ECON[id].balance || 0) + amount));
  saveEconomy(ECON);
  return ECON[id].balance;
}
function subBal(id, amount) {
  ensureUser(id);
  ECON[id].balance = Math.max(0, Math.floor((ECON[id].balance || 0) - amount));
  saveEconomy(ECON);
  return ECON[id].balance;
}

// helpers
function parseBet(arg, max) {
  if (!arg) return null;
  arg = arg.toLowerCase();
  if (arg === 'all') return max;
  if (arg.endsWith('%')) {
    const p = parseFloat(arg.slice(0, -1));
    if (isNaN(p) || p <= 0) return null;
    return Math.max(1, Math.floor((p / 100) * max));
  }
  const n = parseInt(arg, 10);
  if (isNaN(n) || n <= 0) return null;
  return n;
}

function randInt(min, max) { // inclusive
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ---------------------------
// Games
// ---------------------------

// SPIN (wheel): multipliers array
function spinWheel(bet) {
  // multipliers: common small, rare big
  const wheel = [
    0, 0, 0, 0, 0, // blanks -> lose
    1, 1, // return
    2, 2,
    3,
    5,
    10,
    20,
    50, // very rare
  ];
  const choice = wheel[randInt(0, wheel.length - 1)];
  return Math.floor(choice * bet);
}

// COIN flip: double or lose
function coinFlip(bet) {
  const win = Math.random() < 0.5;
  return win ? bet : -bet;
}

// SLOTS: 3 symbols: 🍒, 🍋, 🔔, ⭐, 💎
function slotsResult(bet) {
  const symbols = ['🍒','🍋','🔔','⭐','💎'];
  const r1 = symbols[randInt(0, symbols.length - 1)];
  const r2 = symbols[randInt(0, symbols.length - 1)];
  const r3 = symbols[randInt(0, symbols.length - 1)];
  const display = `${r1} ${r2} ${r3}`;
  let payout = 0;
  if (r1 === r2 && r2 === r3) {
    // triple
    if (r1 === '💎') payout = bet * 10;
    else if (r1 === '⭐') payout = bet * 6;
    else if (r1 === '🔔') payout = bet * 4;
    else payout = bet * 3;
  } else if (r1 === r2 || r2 === r3 || r1 === r3) {
    // pair
    payout = Math.floor(bet * 1.5);
  } else {
    payout = -bet;
  }
  return { display, payout };
}

// BLACKJACK: simplified auto-play for player (player hits until >=17), dealer hits until 17
function drawCard() {
  // returns value and pretty name
  const ranks = [
    ['A', 11],
    ['2',2],['3',3],['4',4],['5',5],['6',6],['7',7],
    ['8',8],['9',9],['10',10],['J',10],['Q',10],['K',10]
  ];
  const r = ranks[randInt(0, ranks.length - 1)];
  return { rank: r[0], value: r[1] };
}
function handValue(cards) {
  // cards: [{rank,value},...]
  let total = cards.reduce((s,c) => s + c.value, 0);
  // count Aces
  const aces = cards.filter(c => c.rank === 'A').length;
  let adjusted = total;
  // treat some aces as 1 if bust
  for (let i=0;i<aces;i++) {
    if (adjusted > 21) adjusted -= 10; // convert an Ace from 11 to 1
  }
  return adjusted;
}
function blackjackResolve(bet) {
  // player auto hits until >=17
  const player = [drawCard(), drawCard()];
  const dealer = [drawCard(), drawCard()];
  while (handValue(player) < 17) player.push(drawCard());
  while (handValue(dealer) < 17) dealer.push(drawCard());

  const pv = handValue(player), dv = handValue(dealer);
  let result = null;
  let payout = 0;
  if (pv > 21) { result = 'bust'; payout = -bet; }
  else if (dv > 21) { result = 'dealer_bust'; payout = bet; }
  else if (pv > dv) { result = 'win'; payout = bet; }
  else if (pv < dv) { result = 'lose'; payout = -bet; }
  else { result = 'push'; payout = 0; }

  return {
    player, dealer, pv, dv, result, payout
  };
}

// POKER (simple 5-card compare): evaluate basic ranking
function buildDeck() {
  const suits = ['♠','♥','♦','♣'];
  const ranks = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const deck = [];
  for (const s of suits) for (const r of ranks) deck.push({ s, r });
  return deck;
}
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randInt(0, i);
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
  // accommodate wheel A-2-3-4-5
  let isSeq = true;
  for (let i=1;i<vals.length;i++) if (vals[i] !== vals[i-1]+1) { isSeq = false; break; }
  if (isSeq) return true;
  // check A low
  if (vals.includes(14)) {
    const alt = vals.map(v => v===14?1:v).sort((a,b)=>a-b);
    let ok = true;
    for (let i=1;i<alt.length;i++) if (alt[i] !== alt[i-1]+1) { ok=false; break; }
    return ok;
  }
  return false;
}
function evaluateHand(cards) {
  // cards: [{s,r}]
  const vals = cards.map(c => rankValue(c.r));
  const suits = cards.map(c => c.s);
  const counts = {};
  for (const v of vals) counts[v] = (counts[v]||0)+1;
  const countsSorted = Object.values(counts).sort((a,b)=>b-a); // e.g. [3,1,1]
  const unique = Object.keys(counts).length;
  const flush = suits.every(s => s === suits[0]);
  const straight = isStraight(vals.slice());
  if (straight && flush) return { rank:8, name:'Straight Flush', t: Math.max(...vals) };
  if (countsSorted[0] === 4) return { rank:7, name:'Four of a Kind', t: parseInt(Object.keys(counts).find(k=>counts[k]===4)) };
  if (countsSorted[0] === 3 && countsSorted[1] === 2) return { rank:6, name:'Full House', t: parseInt(Object.keys(counts).find(k=>counts[k]===3)) };
  if (flush) return { rank:5, name:'Flush', t: Math.max(...vals) };
  if (straight) return { rank:4, name:'Straight', t: Math.max(...vals) };
  if (countsSorted[0] === 3) return { rank:3, name:'Three of a Kind', t: parseInt(Object.keys(counts).find(k=>counts[k]===3)) };
  if (countsSorted[0] === 2 && countsSorted[1] === 2) {
    // two pair
    const pairs = Object.keys(counts).filter(k=>counts[k]===2).map(x=>parseInt(x)).sort((a,b)=>b-a);
    return { rank:2, name:'Two Pair', t: pairs[0]*100 + pairs[1] }; // t holds combined
  }
  if (countsSorted[0] === 2) return { rank:1, name:'One Pair', t: parseInt(Object.keys(counts).find(k=>counts[k]===2)) };
  return { rank:0, name:'High Card', t: Math.max(...vals) };
}
function compareHands(a,b) {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.t - b.t;
}
function pokerResolve(bet) {
  const deck = shuffle(buildDeck());
  const player = deck.splice(0,5);
  const dealer = deck.splice(0,5);
  const er = evaluateHand(player);
  const dr = evaluateHand(dealer);
  const cmp = compareHands(er, dr);
  let payout = 0;
  if (cmp > 0) payout = bet; // player > dealer => win
  else if (cmp < 0) payout = -bet;
  else payout = 0; // tie
  return { player, dealer, er, dr, payout };
}

// CRIME: risk/reward, e.g., 50% success, 50% caught
function crimeAttempt() {
  const roll = Math.random();
  if (roll < 0.45) { // success
    const amount = randInt(5, 50); // reward
    return { success: true, amount };
  } else { // caught
    const fine = randInt(10, 60);
    return { success: false, fine };
  }
}

// ---------------------------
// Commands (add to your message handler)
// Prefix assumed to be in variable `PREFIX` and message available
// Example usage:
// !start
// !bal
// !give @user 10
// !spin 5
// !coin 5
// !slots 10
// !blackjack 5
// !poker 10
// !crime
// ---------------------------

/* Example: in your messageCreate handler add the following */

if (message.content.startsWith(PREFIX)) {
  const [cmdRaw, ...cmdArgs] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = cmdRaw.toLowerCase();

  // ensure author initialized
  ensureUser(message.author.id);

  // START: init user with 10 robux (or show bal)
  if (cmd === 'start') {
    const bal = getBal(message.author.id);
    return message.reply(`You have ${bal} Robux. (New users start with 10 Robux)`);
  }

  // BALANCE
  if (cmd === 'bal' || cmd === 'balance') {
    const bal = getBal(message.author.id);
    return message.reply(`${message.author}, your balance: **${bal} Robux**`);
  }

  // GIVE
  if (cmd === 'give') {
    const target = message.mentions.users.first();
    const amtArg = cmdArgs[1] || cmdArgs[0];
    if (!target) return message.reply('Usage: `!give @user <amount>`');
    const amt = parseInt(amtArg,10);
    if (isNaN(amt) || amt <= 0) return message.reply('Invalid amount.');
    if (getBal(message.author.id) < amt) return message.reply('Insufficient funds.');
    subBal(message.author.id, amt);
    addBal(target.id, amt);
    return message.reply(`✅ Sent ${amt} Robux to ${target.tag}. Your new balance: ${getBal(message.author.id)} Robux`);
  }

  // SPIN
  if (cmd === 'spin') {
    const betArg = cmdArgs[0];
    const bet = parseBet(betArg, getBal(message.author.id));
    if (!bet) return message.reply('Usage: `!spin <amount|all|<percent>%>`');
    if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.');
    subBal(message.author.id, bet);
    const win = spinWheel(bet);
    if (win > 0) {
      addBal(message.author.id, win);
      return message.reply(`🎡 You spun and won **${win} Robux**! New balance: ${getBal(message.author.id)}`);
    } else {
      return message.reply(`🎡 Bad luck — you lost ${bet} Robux. New balance: ${getBal(message.author.id)}`);
    }
  }

  // COIN
  if (cmd === 'coin') {
    const betArg = cmdArgs[0];
    const bet = parseBet(betArg, getBal(message.author.id));
    if (!bet) return message.reply('Usage: `!coin <amount|all|<percent>%>`');
    if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.');
    const res = coinFlip(bet);
    if (res > 0) { addBal(message.author.id, res); subBal(message.author.id, 0); return message.reply(`🪙 You won ${res} Robux! New balance: ${getBal(message.author.id)}`); }
    else { subBal(message.author.id, -res); return message.reply(`🪙 You lost ${bet} Robux. New balance: ${getBal(message.author.id)}`); }
  }

  // SLOTS
  if (cmd === 'slots') {
    const betArg = cmdArgs[0];
    const bet = parseBet(betArg, getBal(message.author.id));
    if (!bet) return message.reply('Usage: `!slots <amount|all|<percent>%>`');
    if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.');
    subBal(message.author.id, bet);
    const { display, payout } = slotsResult(bet);
    if (payout > 0) addBal(message.author.id, payout);
    return message.reply(`🎰 ${display}\n${payout>0?`You won ${payout} Robux!`:`You lost ${bet} Robux.`}\nNew balance: ${getBal(message.author.id)}`);
  }

  // BLACKJACK (auto-play)
  if (cmd === 'blackjack' || cmd === 'bj') {
    const betArg = cmdArgs[0];
    const bet = parseBet(betArg, getBal(message.author.id));
    if (!bet) return message.reply('Usage: `!blackjack <amount|all|<percent>%>`');
    if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.');
    subBal(message.author.id, bet);
    const res = blackjackResolve(bet);
    // pretty print hands
    const playerHand = res.player.map(c=>c.rank).join(' ');
    const dealerHand = res.dealer.map(c=>c.rank).join(' ');
    if (res.payout > 0) addBal(message.author.id, res.payout);
    const resultText = res.result === 'push' ? 'Push — bet returned.' : (res.payout>0?`You win ${res.payout} Robux!`:`You lose ${-res.payout} Robux.`);
    return message.reply(`🃏 Blackjack\nYour hand: ${playerHand} (${res.pv})\nDealer hand: ${dealerHand} (${res.dv})\n${resultText}\nNew balance: ${getBal(message.author.id)}`);
  }

  // POKER (5-card showdown)
  if (cmd === 'poker') {
    const betArg = cmdArgs[0];
    const bet = parseBet(betArg, getBal(message.author.id));
    if (!bet) return message.reply('Usage: `!poker <amount|all|<percent>%>`');
    if (getBal(message.author.id) < bet) return message.reply('Insufficient funds.');
    subBal(message.author.id, bet);
    const res = pokerResolve(bet);
    if (res.payout > 0) addBal(message.author.id, res.payout);
    // display short
    const ph = res.player.map(c=>`${c.r}${c.s}`).join(' ');
    const dh = res.dealer.map(c=>`${c.r}${c.s}`).join(' ');
    const outcome = res.payout>0?`You won ${res.payout} Robux!`:(res.payout<0?`You lost ${-res.payout} Robux.`:'Push.');
    return message.reply(`🂡 Poker (5-card)\nYour hand: ${ph} — ${res.er.name}\nDealer hand: ${dh} — ${res.dr.name}\n${outcome}\nNew balance: ${getBal(message.author.id)}`);
  }

  // CRIME
  if (cmd === 'crime') {
    // no bet, risk-based
    const res = crimeAttempt();
    if (res.success) {
      addBal(message.author.id, res.amount);
      getLog(message.guild)?.send(`🕵️‍♂️ Crime success: ${message.author.tag} got ${res.amount} Robux`);
      return message.reply(`💰 Crime succeeded! You stole **${res.amount} Robux**. New balance: ${getBal(message.author.id)}`);
    } else {
      // fine: subtract but not below zero
      const loss = Math.min(getBal(message.author.id), res.fine);
      subBal(message.author.id, loss);
      getLog(message.guild)?.send(`🚔 Crime failed: ${message.author.tag} fined ${loss} Robux`);
      return message.reply(`🚨 You got caught! You paid **${loss} Robux** in fines. New balance: ${getBal(message.author.id)}`);
    }
  }
}
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
// --- Keepalive server for Render ---
import express from "express";

const app = express();
const PORT = process.env.PORT || 10000;

app.get("/", (req, res) => {
  res.send("✅ Agnello FC Bot is alive and running!");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌍 Keepalive server listening on http://0.0.0.0:${PORT}`);
});
// -----------------------------
// LOGIN
// -----------------------------
if (!TOKEN) {
  console.error('❌ Missing TOKEN env var.');
  process.exit(1);
}
client.login(TOKEN);
