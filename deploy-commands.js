// ES Modules version
import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import 'dotenv/config';

// Required env vars in your .env
const TOKEN = process.env.BOT_TOKEN;     // Your bot token
const CLIENT_ID = process.env.CLIENT_ID; // Application (client) ID
const GUILD_ID = process.env.GUILD_ID;   // Your server ID (guild)

if (!TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('Missing BOT_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  process.exit(1);
}

// Define commands
const commands = [
  new SlashCommandBuilder()
    .setName('friendly')
    .setDescription('Host an Agnello FC friendly with 1–7 reaction positions'),

  new SlashCommandBuilder()
    .setName('activity')
    .setDescription('Start an Agnello FC activity check')
    .addIntegerOption(o =>
      o.setName('goal')
       .setDescription('Activity goal number (optional)')
       .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('dmall')
    .setDescription('DM all server members (server owner only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // still checked server-owner in code

  new SlashCommandBuilder()
    .setName('announcement')
    .setDescription('Send the Agnello FC announcement link')
].map(c => c.toJSON());

// Register to a single guild for instant availability
const rest = new REST({ version: '10' }).setToken(TOKEN);

try {
  console.log('Registering slash commands to guild…');
  await rest.put(
    Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
    { body: commands }
  );
  console.log('✅ Slash commands registered successfully.');
} catch (err) {
  console.error('❌ Error registering commands:', err);
  process.exit(1);
}
