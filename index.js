import { Client, GatewayIntentBits, Partials, Events, PermissionsBitField } from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, getVoiceConnection } from '@discordjs/voice';
import express from 'express';
import 'dotenv/config';
import ytdl from 'ytdl-core';
import play from 'play-dl';
import { OpenAI } from 'openai';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const logChannelId = '1362214241091981452';
const friendlyRoleId = '1383970211933454378';
const adminPerms = [PermissionsBitField.Flags.Administrator];
const badWords = ['fuck', 'bitch', 'nigger', 'dick', 'nigga', 'pussy'];
const positions = { '1️⃣': 'GK', '2️⃣': 'CB', '3️⃣': 'CB2', '4️⃣': 'CM', '5️⃣': 'LW', '6️⃣': 'RW', '7️⃣': 'ST' };
const queues = new Map();

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ------------------ Helper Functions ------------------ //
async function log(msg) {
  const channel = client.channels.cache.get(logChannelId);
  if (channel) channel.send(msg).catch(() => {});
}

async function handleFriendly(channel, author, member) {
  if (!member.roles.cache.has(friendlyRoleId)) return channel.send('You do not have permission to host a friendly.');

  await channel.send('@everyone :AGNELLO: Agnello Friendly, react to position');
  const msg = await channel.send(`React with the number corresponding to your position:
1️⃣ → GK  
2️⃣ → CB  
3️⃣ → CB2  
4️⃣ → CM  
5️⃣ → LW  
6️⃣ → RW  
7️⃣ → ST`);

  for (const emoji of Object.keys(positions)) await msg.react(emoji);

  const claimed = {};
  const filter = (reaction, user) => !user.bot && positions[reaction.emoji.name] && !Object.values(claimed).includes(user.id);
  const collector = msg.createReactionCollector({ filter, time: 600000 });

  collector.on('collect', (reaction, user) => {
    if (!claimed[reaction.emoji.name]) {
      claimed[reaction.emoji.name] = user.id;
      msg.edit(
        '**Current lineup:**\n' +
          Object.entries(positions)
            .map(([emoji, pos]) => `${emoji} → ${claimed[emoji] ? `<@${claimed[emoji]}> (${pos})` : pos}`)
            .join('\n')
      );
      log(`${user.tag} claimed ${positions[reaction.emoji.name]}`);
    }
    if (Object.keys(claimed).length === Object.keys(positions).length) collector.stop('filled');
  });

  collector.on('end', (collected, reason) => {
    if (reason === 'filled') {
      channel.send('Looking for a Roblox RFL link...');
      const linkCollector = channel.createMessageCollector({
        filter: m => m.content.includes('roblox.com') && !m.author.bot,
        time: 900000
      });
      linkCollector.on('collect', linkMsg => {
        Object.values(claimed).forEach(userId => {
          client.users.send(userId, `<@${userId}>, here is the friendly link: ${linkMsg.content}`);
        });
        linkCollector.stop();
      });
    }
  });
}

// ------------------ Prefix Commands ------------------ //
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  const args = message.content.trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  // ---- Hostfriendly ----
  if (cmd === '!hostfriendly') handleFriendly(message.channel, message.author, message.member);

  // ---- Activity ----
  if (cmd === '!activity') {
    const goal = parseInt(args[0]) || 0;
    const msg = await message.channel.send(`:AGNELLO: @everyone, AGNELLO FC ACTIVITY CHECK, GOAL (${goal}), REACT WITH A ✅`);
    await msg.react('✅');
    const collector = msg.createReactionCollector({ filter: (r, u) => r.emoji.name === '✅' && !u.bot, time: 86400000 });
    collector.on('collect', user => log(`${user.tag} responded to activity check.`));
  }

  // ---- DM Role ----
  if (cmd === '!dmrole') {
    if (!args[0] || !args.slice(1).join(' ')) return message.reply('Usage: !dmrole @role <message>');
    const roleId = args[0].replace(/\D/g, '');
    const dmMessage = args.slice(1).join(' ');
    const role = message.guild.roles.cache.get(roleId);
    if (!role) return message.reply('Role not found.');
    const failed = [];
    role.members.forEach(mem => mem.send(dmMessage).catch(() => failed.push(mem.user.tag)));
    message.channel.send(`DM sent to ${role.members.size - failed.length} members. Failed: ${failed.join(', ')}`);
  }

  // ---- Kick / Ban ----
  if ((cmd === '!kick' || cmd === '!ban') && message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
    const target = message.mentions.members.first();
    if (!target) return message.reply('Mention a user.');
    if (cmd === '!kick') target.kick().catch(() => message.reply('Failed to kick.'));
    if (cmd === '!ban') target.ban().catch(() => message.reply('Failed to ban.'));
    log(`${message.author.tag} executed ${cmd} on ${target.user.tag}`);
  }

  // ---- Music ----
  if (cmd === '!play') {
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('Join a VC first.');
    const query = args.join(' ');
    if (!query) return message.reply('Provide a song name or URL.');
    const queue = queues.get(message.guild.id) || { songs: [], player: createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }) };
    queues.set(message.guild.id, queue);
    const stream = await play.stream(query);
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    queue.songs.push({ resource, title: query });
    joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
    if (!queue.player.playing) {
      queue.player.play(queue.songs.shift().resource);
      log(`Now playing: ${query}`);
      queue.player.on(AudioPlayerStatus.Idle, () => { if (queue.songs.length > 0) queue.player.play(queue.songs.shift().resource); });
    }
  }
  if (cmd === '!skip') { const queue = queues.get(message.guild.id); if (queue && queue.songs.length > 0) queue.player.stop(); }
  if (cmd === '!stop') { const queue = queues.get(message.guild.id); if (queue) { queue.player.stop(); queue.songs = []; } }
  if (cmd === '!queue') { const queue = queues.get(message.guild.id); if (!queue || queue.songs.length === 0) return message.reply('Queue is empty.'); message.channel.send(`Queue:\n${queue.songs.map((s,i)=>`${i+1}. ${s.title}`).join('\n')}`); }

  // ---- Bad words ----
  const cleaned = message.content.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const bad of badWords) {
    if (cleaned.includes(bad)) {
      message.delete().catch(() => {});
      message.channel.send(`You can't say that word, ${message.author}!`);
      log(`${message.author.tag} tried to say a bad word: ${message.content}`);
      // TODO: Mute in VC if in VC and using bad word with Whisper transcription
      return;
    }
  }
});

// ------------------ Deleted messages ------------------ //
client.on(Events.MessageDelete, msg => {
  if (!msg.partial && msg.author) log(`Message deleted by ${msg.author.tag}: ${msg.content}`);
});

// ------------------ Join VC command ------------------ //
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;
  if (message.content.toLowerCase() === '!joinvc') {
    const vc = message.member.voice.channel;
    if (!vc) return message.reply('Join a VC first.');
    joinVoiceChannel({ channelId: vc.id, guildId: vc.guild.id, adapterCreator: vc.guild.voiceAdapterCreator });
    message.channel.send('Joined your VC!');
    log(`${message.author.tag} used !joinvc`);
  }
});

// ------------------ Client Ready ------------------ //
client.on(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  log('Bot is online.');
});

// ------------------ Express server ------------------ //
const app = express();
app.get('/', (req,res)=>res.send('Bot is running.'));
app.listen(process.env.PORT || 3000);

client.login(process.env.BOT_TOKEN);
