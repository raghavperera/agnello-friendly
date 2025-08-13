import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  Events
} from 'discord.js';
import 'dotenv/config';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

const logChannelId = '1405241260624838686';

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

const badWords = ['fuck', 'bitch', 'nigger', 'dick', 'nigga', 'pussy'];

// Slash command handling
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'friendly') {
    // Restrict to specific channels
    const allowedChannels = ['1361111188506935428', '1378795435589632010'];
    if (!allowedChannels.includes(interaction.channelId)) {
      return interaction.reply({ content: 'You can only host a friendly in the designated channels.', ephemeral: true });
    }

    // Restrict by role
    const requiredRoleId = '1383970211933454378';
    const member = interaction.member;
    const hasRoleOrHigher = member.roles.cache.some(role => role.id === requiredRoleId || role.position >= interaction.guild.roles.cache.get(requiredRoleId).position);
    if (!hasRoleOrHigher) {
      return interaction.reply({ content: 'You do not have permission to host a friendly.', ephemeral: true });
    }

    await interaction.reply('@everyone :AGNELLO: Agnello FC friendly, react for your position :AGNELLO:');

    const msg = await interaction.channel.send(`React with the number corresponding to your position:
1️⃣ → GK  
2️⃣ → CB  
3️⃣ → CB2  
4️⃣ → CM  
5️⃣ → LW  
6️⃣ → RW  
7️⃣ → ST`);

    for (const emoji of Object.keys(positions)) {
      await msg.react(emoji);
    }

    const claimed = {};
    const filter = (reaction, user) => !user.bot && positions[reaction.emoji.name] && !Object.values(claimed).includes(user.id);
    const collector = msg.createReactionCollector({ filter, time: 600000 }); // 10 minutes

    collector.on('collect', (reaction, user) => {
      if (!claimed[reaction.emoji.name]) {
        claimed[reaction.emoji.name] = user.id;
        msg.edit(`**Current lineup:**\n` + Object.entries(positions).map(([emoji, pos]) => `${emoji} → ${claimed[emoji] ? `<@${claimed[emoji]}> (${pos})` : pos}`).join('\n'));
        client.channels.cache.get(logChannelId)?.send(`${user.tag} claimed ${positions[reaction.emoji.name]}`);
      }

      if (Object.keys(claimed).length === Object.keys(positions).length) {
        collector.stop('filled');
      }
    });

    collector.on('end', (collected, reason) => {
      if (reason === 'filled') {
        interaction.channel.send('Looking for a Roblox RFL link...');
        const linkFilter = m => m.content.includes('roblox.com') && !m.author.bot;
        const linkCollector = interaction.channel.createMessageCollector({ filter: linkFilter, time: 900000 }); // 15 mins

        linkCollector.on('collect', linkMsg => {
          Object.values(claimed).forEach(userId => {
            client.users.send(userId, `<@${userId}>, here is the friendly link: ${linkMsg.content}`);
          });
          linkCollector.stop();
        });
      }
    });
  }

  if (interaction.commandName === 'activity') {
    const goal = interaction.options.getInteger('goal') ?? 0;
    const msg = await interaction.reply({ content: `:AGNELLO: @everyone, AGNELLO FC ACTIVITY CHECK, GOAL (${goal}), REACT WITH A ✅`, fetchReply: true });
    await msg.react('✅');

    const filter = (reaction, user) => reaction.emoji.name === '✅' && !user.bot;
    const collector = msg.createReactionCollector({ filter, time: 86400000 }); // 1 day

    collector.on('collect', user => {
      client.channels.cache.get(logChannelId)?.send(`${user.tag} responded to activity check.`);
    });
  }

  if (interaction.commandName === 'dmall') {
    if (interaction.user.id !== interaction.guild.ownerId) {
      return interaction.reply({ content: 'Only the server owner can use this command.', ephemeral: true });
    }
    await interaction.reply({ content: 'Please send the message you want to DM everyone.', ephemeral: true });
    const filter = m => m.author.id === interaction.user.id;
    const collector = interaction.channel.createMessageCollector({ filter, max: 1, time: 60000 });

    collector.on('collect', m => {
      interaction.guild.members.fetch().then(members => {
        members.forEach(member => {
          if (!member.user.bot) member.send(m.content).catch(() => {});
        });
        client.channels.cache.get(logChannelId)?.send('Server owner sent a DM to all members.');
      });
    });
  }

  if (interaction.commandName === 'announcement') {
    await interaction.reply('There is a announcement in Agnello FC, please check it out. https://discord.com/channels/1357085245983162708/1361111742427697152');
    client.channels.cache.get(logChannelId)?.send('Announcement sent.');
  }
});

// Deleted message logging
client.on(Events.MessageDelete, message => {
  if (!message.partial && message.author) {
    client.channels.cache.get(logChannelId)?.send(`Message deleted by ${message.author.tag}: ${message.content}`);
  }
});

// Bad word filter
client.on(Events.MessageCreate, message => {
  if (message.author.bot) return;
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

// Join VC and idle
client.on(Events.ClientReady, () => {
  console.log(`Logged in as ${client.user.tag}`);
  const vc = client.channels.cache.get('1357085245983162708');
  if (vc && vc.isVoiceBased()) {
    vc.join?.().catch(() => {}); // For older voice lib compatibility
    client.channels.cache.get(logChannelId)?.send('Bot joined VC to idle.');
  }
});

client.login(process.env.BOT_TOKEN);
import express from 'express';

const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(process.env.PORT || 3000);
  }
});
