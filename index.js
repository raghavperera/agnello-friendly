import { Client, GatewayIntentBits, Partials, Events } from 'discord.js';
import 'dotenv/config';
import express from 'express';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const logChannelId = '1362214241091981452';

// Positions mapping
const positions = {
  '1️⃣': 'GK',
  '2️⃣': 'CB',
  '3️⃣': 'CB',
  '4️⃣': 'CM',
  '5️⃣': 'LW',
  '6️⃣': 'RW',
  '7️⃣': 'ST'
};

// Bad words
const badWords = ['fuck', 'bitch', 'nigger', 'dick', 'nigga', 'pussy'];

// Helper function to handle friendly hosting
async function handleFriendly(channel, author, member) {
  // Check roles
  const requiredRoleId = '1383970211933454378';
  const hasRoleOrHigher = member.roles.cache.some(
    role => role.id === requiredRoleId || role.position >= member.guild.roles.cache.get(requiredRoleId).position
  );
  if (!hasRoleOrHigher) {
    return channel.send('You do not have permission to host a friendly.');
  }

  // Send message
  await channel.send('@everyone :AGNELLO: Agnello FC friendly, react for your position :AGNELLO:');

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
  const filter = (reaction, user) =>
    !user.bot && positions[reaction.emoji.name] && !Object.values(claimed).includes(user.id);
  const collector = msg.createReactionCollector({ filter, time: 600000 });

  collector.on('collect', (reaction, user) => {
    if (!claimed[reaction.emoji.name]) {
      claimed[reaction.emoji.name] = user.id;
      msg.edit(
        '**Current lineup:**\n' +
          Object.entries(positions)
            .map(
              ([emoji, pos]) =>
                `${emoji} → ${claimed[emoji] ? `<@${claimed[emoji]}> (${pos})` : pos}`
            )
            .join('\n')
      );
      client.channels.cache.get(logChannelId)?.send(`${user.tag} claimed ${positions[reaction.emoji.name]}`);
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

// Slash command handling
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const member = interaction.member;
  const channel = interaction.channel;

  if (interaction.commandName === 'friendly') {
    const allowedChannels = ['1361111188506935428', '1378795435589632010'];
    if (!allowedChannels.includes(channel.id)) {
      return interaction.reply({ content: 'You can only host a friendly in the designated channels.', ephemeral: true });
    }
    await interaction.reply({ content: 'Friendly started!', ephemeral: true });
    handleFriendly(channel, interaction.user, member);
  }

  if (interaction.commandName === 'activity') {
    const goal = interaction.options.getInteger('goal') ?? 0;
    const msg = await interaction.reply({
      content: `:AGNELLO: @everyone, AGNELLO FC ACTIVITY CHECK, GOAL (${goal}), REACT WITH A ✅`,
      fetchReply: true
    });
    await msg.react('✅');
    const collector = msg.createReactionCollector({ filter: (r, u) => r.emoji.name === '✅' && !u.bot, time: 86400000 });
    collector.on('collect', user => {
      client.channels.cache.get(logChannelId)?.send(`${user.tag} responded to activity check.`);
    });
  }

  if (interaction.commandName === 'dmall') {
    if (interaction.user.id !== interaction.guild.ownerId)
      return interaction.reply({ content: 'Only the server owner can use this command.', ephemeral: true });
    await interaction.reply({ content: 'Please send the message you want to DM everyone.', ephemeral: true });
    const collector = channel.createMessageCollector({ filter: m => m.author.id === interaction.user.id, max: 1, time: 60000 });
    collector.on('collect', m => {
      interaction.guild.members.fetch().then(members => {
        members.forEach(mem => { if (!mem.user.bot) mem.send(m.content).catch(() => {}); });
        client.channels.cache.get(logChannelId)?.send('Server owner sent a DM to all members.');
      });
    });
  }

  if (interaction.commandName === 'announcement') {
    await interaction.reply('There is a announcement in Agnello FC, please check it out. https://discord.com/channels/1357085245983162708/1361111742427697152');
    client.channels.cache.get(logChannelId)?.send('Announcement sent.');
  }
});

// Prefix command handling
client.on(Events.MessageCreate, message => {
  if (message.author.bot) return;

  const args = message.content.trim().split(/ +/);
  const cmd = args.shift().toLowerCase();

  if (cmd === '!friendly') handleFriendly(message.channel, message.author, message.member);

  if (cmd === '!activity') {
    const goal = parseInt(args[0]) || 0;
    message.channel.send(`:AGNELLO: @everyone, AGNELLO FC ACTIVITY CHECK, GOAL (${goal}), REACT WITH A ✅`).then(async msg => {
      await msg.react('✅');
      const collector = msg.createReactionCollector({ filter: (r, u) => r.emoji.name === '✅' && !u.bot, time: 86400000 });
      collector.on('collect', user => client.channels.cache.get(logChannelId)?.send(`${user.tag} responded to activity check.`));
    });
  }

  if (cmd === '!announcement') {
    message.channel.send('There is a announcement in Agnello FC, please check it out. https://discord.com/channels/1357085245983162708/1361111742427697152');
    client.channels.cache.get(logChannelId)?.send('Announcement sent.');
  }

  // Bad word filter
  const cleaned = message.content.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const bad of badWords) {
    if (cleaned.includes(bad)) {
      message.delete().catch(() => {});
      message.channel.send(`You can't say that word, ${message.author}!`);
      client.channels.cache.get(logChannelId)?.send(`${message.author.tag} tried to say a bad word: ${message.content}`);
      return;
    }
  }
});

// Deleted message logging
client.on(Events.MessageDelete, message => {
  if (!message.partial && message.author) {
    client.channels.cache.get(logChannelId)?.send(`Message deleted by ${message.author.tag}: ${message.content}`);
  }
});

// Join VC and idle
client.on(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  const vc = client.channels.cache.get('1357085245983162708');
  if (vc && vc.isVoiceBased()) {
    vc.join?.().catch(() => {});
    client.channels.cache.get(logChannelId)?.send('Bot joined VC to idle.');
  }
});

// Keep bot alive with Express
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(process.env.PORT || 3000);

client.login(process.env.BOT_TOKEN);
