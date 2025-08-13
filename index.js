const Discord = require('discord.js');
const client = new Discord.Client({ intents: ["GUILDS", "GUILD_MESSAGES", "GUILD_VOICE_STATES"] });

// Set up the logging channel
const logChannel = '1405241260624838686';

// Define the reaction role positions
const positions = {
  '1': 'GK',
  '2': 'CB',
  '3': 'CB',
  '4': 'CM',
  '5': 'LW',
  '6': 'RW',
  '7': 'ST'
};

// Command: /friendly
client.on('interactionCreate', async (interaction) => {
  if (interaction.commandName === 'friendly') {
    // Ping @everyone and send the message
    await interaction.reply(':AGNELLO: Agnello FC friendly, react for your position :AGNELLO:');

    // Create the reaction role message
    const message = await interaction.channel.send('React with the number corresponding to your position:');

    // Add the reactions
    for (const [emoji, position] of Object.entries(positions)) {
      await message.react(emoji);
    }

    // Wait for reactions and assign roles
    const filter = (reaction, user) => {
      return Object.keys(positions).includes(reaction.emoji.name) && !user.bot;
    };

    const collector = message.createReactionCollector({ filter, time: 60000 });

    collector.on('collect', async (reaction, user) => {
      const position = positions[reaction.emoji.name];
      const member = await interaction.guild.members.fetch(user.id);
      await member.roles.add(reaction.emoji.name);
      client.channels.cache.get(logChannel).send(`${user.username} has claimed the ${position} position.`);
    });

    collector.on('end', collected => {
      if (collected.size === Object.keys(positions).length) {
        message.channel.send('Looking for a Roblox RFL link...');
      }
    });
  }
});

// Command: /activity
client.on('interactionCreate', async (interaction) => {
  if (interaction.commandName === 'activity') {
    // Send the activity check message
    const message = await interaction.reply(':AGNELLO: @everyone, AGNELLO FC ACTIVITY CHECK, GOAL (5), REACT WITH A ✅');
    await message.react('✅');

    // Wait for reactions and log the activity
    const filter = (reaction, user) => {
      return reaction.emoji.name === '✅' && !user.bot;
    };

    const collector = message.createReactionCollector({ filter, time: 60000 });

    collector.on('collect', async (reaction, user) => {
      const member = await interaction.guild.members.fetch(user.id);
      client.channels.cache.get(logChannel).send(`${user.username} has responded to the activity check.`);
    });

    collector.on('end', collected => {
      if (collected.size === 0) {
        message.channel.send('No one responded to the activity check.');
      }
    });
  }
});

// Command: /dmall
client.on('interactionCreate', async (interaction) => {
  if (interaction.commandName === 'dmall') {
    // Check if the user is the server owner
    if (interaction.user.id === interaction.guild.ownerId) {
      // Prompt the user for a message
      const filter = (m) => m.author.id === interaction.user.id;
      const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

      collector.on('collect', async (message) => {
        // DM the message to all users in the server
        const members = await interaction.guild.members.fetch();
        members.forEach(member => {
          if (!member.user.bot) {
            member.user.send(`${message.content}`);
          }
        });

        client.channels.cache.get(logChannel).send(`The server owner has sent a DM to all users.`);
      });

      collector.on('end', collected => {
        if (collected.size === 0) {
          interaction.reply('No message provided.');
        }
      });
    } else {
      interaction.reply('Only the server owner can use this command.');
    }
  }
});

// Command: /announcement
client.on('interactionCreate', async (interaction) => {
  if (interaction.commandName === 'announcement') {
    // Send the announcement message
    await interaction.reply('There is a announcement in Agnello FC, please check it out. https://discord.com/channels/1357085245983162708/1361111742427697152');
    client.channels.cache.get(logChannel).send(`An announcement has been made.`);
  }
});

// Logging system
client.on('messageDelete', async (message) => {
  client.channels.cache.get(logChannel).send(`A message by ${message.author.username} has been deleted: ${message.content}`);
});

// Bad word filter
const badWords = ['fuck', 'bitch', 'nigger', 'dick', 'nigga', 'pussy'];

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Check for bad words
  for (const word of badWords) {
    if (message.content.toLowerCase().includes(word.toLowerCase()) || message.content.replace(/\s/g, '').toLowerCase().includes(word.toLowerCase())) {
      await message.delete();
      await message.channel.send(`You can't say that word, ${message.author}!`);
      client.channels.cache.get(logChannel).send(`${message.author.username} tried to say a bad word: ${message.content}`);
      return;
    }
  }
});

// Join and idle in voice channel
client.on('ready', () => {
  const voiceChannel = client.channels.cache.get('1357085245983162708');
  if (voiceChannel && voiceChannel.type === 'GUILD_VOICE') {
    voiceChannel.join();
    client.channels.cache.get(logChannel).send('Bot has joined the voice channel, now idling.');
  }
});

client.login('BOT_TOKEN');
