import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

// Your bot token, client ID, and guild ID from Discord Developer Portal
const TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID; // Bot's application ID
const GUILD_ID = process.env.GUILD_ID;   // Your server ID

const commands = [
  new SlashCommandBuilder()
    .setName('friendly')
    .setDescription('Host an Agnello FC friendly with reaction role positions'),

  new SlashCommandBuilder()
    .setName('activity')
    .setDescription('Start an Agnello FC activity check')
    .addIntegerOption(option =>
      option.setName('goal')
        .setDescription('Activity goal number')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('dmall')
    .setDescription('DM all server members (server owner only)'),

  new SlashCommandBuilder()
    .setName('announcement')
    .setDescription('Send the Agnello FC announcement link to all')
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('✅ Slash commands registered successfully.');
  } catch (error) {
    console.error('❌ Error registering commands:', error);
  }
})();
