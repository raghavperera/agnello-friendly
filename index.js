import {
  Client,
  GatewayIntentBits,
  Partials,
  Events,
  EmbedBuilder
} from 'discord.js';
import 'dotenv/config';
import express from 'express';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const logChannelId = '1362214241091981452';


const positions = {
  '1️⃣': 'GK',
  '2️⃣': 'CB',
  '3️⃣': 'CB',
  '4️⃣': 'CM',
  '5️⃣': 'LW',
  '6️⃣': 'RW',
  '7️⃣': 'ST'
};

const badWords = ['fuck','bitch','nigger','dick','nigga','pussy'];

// --- Helper Functions ---
async function runFriendly(channel, member) {
  // Check channel
  const allowedChannels = ['1361111188506935428','1378795435589632010'];
  if (!allowedChannels.includes(channel.id)) return;

  // Check role
  const requiredRoleId = '1383970211933454378';
  const roleObj = channel.guild.roles.cache.get(requiredRoleId);
  if (!member.roles.cache.some(r => r.id === requiredRoleId || r.position >= roleObj.position)) return;

  const friendlyMsg = await channel.send('@everyone :AGNELLO: Agnello FC friendly, react for your position :AGNELLO:');
  const msg = await channel.send(`React with your position:\n1️⃣ → GK\n2️⃣ → CB\n3️⃣ → CB2\n4️⃣ → CM\n5️⃣ → LW\n6️⃣ → RW\n7️⃣ → ST`);

  for (const emoji of Object.keys(positions)) await msg.react(emoji);

  const claimed = {};
  const filter = (reaction, user) => !user.bot && positions[reaction.emoji.name] && !Object.values(claimed).includes(user.id);

  const collector = msg.createReactionCollector({ filter, time: 600000 }); // 10min

  collector.on('collect', (reaction, user) => {
    if (!claimed[reaction.emoji.name]) {
      claimed[reaction.emoji.name] = user.id;
      msg.edit(`**Current lineup:**\n` + Object.entries(positions).map(([emoji,pos]) => `${emoji} → ${claimed[emoji]?`<@${claimed[emoji]}> (${pos})`:pos}`).join('\n'));
      client.channels.cache.get(logChannelId)?.send(`${user.tag} claimed ${positions[reaction.emoji.name]}`);
    }
    if (Object.keys(claimed).length === Object.keys(positions).length) collector.stop('filled');
  });

  collector.on('end', (collected, reason) => {
    if (reason==='filled') {
      channel.send('Looking for a Roblox RFL link...');
      const linkFilter = m => m.content.includes('roblox.com') && !m.author.bot;
      const linkCollector = channel.createMessageCollector({ filter: linkFilter, time: 900000 });
      linkCollector.on('collect', linkMsg => {
        Object.values(claimed).forEach(userId => {
          client.users.send(userId, `<@${userId}>, here is the friendly link: ${linkMsg.content}`);
        });
        linkCollector.stop();
      });
    }
  });
}

async function runActivity(channel, goal=0) {
  const msg = await channel.send(`:AGNELLO: @everyone, AGNELLO FC ACTIVITY CHECK, GOAL (${goal}), REACT WITH A ✅`);
  await msg.react('✅');
  const filter = (reaction, user) => reaction.emoji.name==='✅' && !user.bot;
  const collector = msg.createReactionCollector({ filter, time: 86400000 }); // 1 day
  collector.on('collect', (reaction,user) => client.channels.cache.get(logChannelId)?.send(`${user.tag} responded to activity check.`));
}

async function runDMAll(channel, author) {
  if (author.id !== channel.guild.ownerId) return;
  channel.send('Please send the message to DM all users.');
  const filter = m => m.author.id===author.id;
  const collector = channel.createMessageCollector({ filter, max:1, time:60000 });
  collector.on('collect', m => {
    channel.guild.members.fetch().then(members => {
      members.forEach(member => { if (!member.user.bot) member.send(m.content).catch(()=>{}); });
      client.channels.cache.get(logChannelId)?.send('Server owner sent a DM to all members.');
    });
  });
}

function runAnnouncement(channel) {
  channel.send('There is a announcement in Agnello FC, please check it out. https://discord.com/channels/1357085245983162708/1361111742427697152');
  client.channels.cache.get(logChannelId)?.send('Announcement sent.');
}

// --- Slash commands ---
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName==='friendly') {
    await runFriendly(interaction.channel, interaction.member);
    await interaction.reply({ content: 'Friendly started!', ephemeral:true });
  }
  if (interaction.commandName==='activity') {
    const goal = interaction.options.getInteger('goal') ?? 0;
    await runActivity(interaction.channel, goal);
    await interaction.reply({ content: 'Activity check started!', ephemeral:true });
  }
  if (interaction.commandName==='dmall') {
    await runDMAll(interaction.channel, interaction.user);
    await interaction.reply({ content: 'DM all executed!', ephemeral:true });
  }
  if (interaction.commandName==='announcement') {
    runAnnouncement(interaction.channel);
    await interaction.reply({ content: 'Announcement sent!', ephemeral:true });
  }
});

// --- Prefix commands ---
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  if (!message.member) message.member = await message.guild.members.fetch(message.author.id).catch(()=>{});

  const args = message.content.trim().split(/ +/g);
  const command = args.shift().toLowerCase();

  if (command==='!friendly') await runFriendly(message.channel, message.member);
  if (command==='!activity') await runActivity(message.channel, parseInt(args[0])||0);
  if (command==='!dmall') await runDMAll(message.channel, message.author);
  if (command==='!announcement') runAnnouncement(message.channel);

  // Bad words
  const cleaned = message.content.toLowerCase().replace(/[^a-z0-9]/g,'');
  for (const bad of badWords) {
    if (cleaned.includes(bad)) {
      message.delete().catch(()=>{});
      message.channel.send(`You can't say that word, ${message.author}!`);
      client.channels.cache.get(logChannelId)?.send(`${message.author.tag} tried to say a bad word: ${message.content}`);
      return;
    }
  }
});

// --- Deleted message logging ---
client.on(Events.MessageDelete, message => {
  if (!message.partial && message.author) client.channels.cache.get(logChannelId)?.send(`Message deleted by ${message.author.tag}: ${message.content}`);
});

// --- Voice channel idle ---
client.on(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  const vc = client.channels.cache.get('1357085245983162708');
  if (vc && vc.isVoiceBased()) vc.join?.().catch(()=>{});
  client.channels.cache.get(logChannelId)?.send('Bot joined VC to idle.');
});

// --- Express server for uptime ---
const app = express();
app.get('/', (req,res)=>res.send('Bot is running.'));
app.listen(process.env.PORT||3000);

// --- Login ---
client.login(process.env.BOT_TOKEN);
