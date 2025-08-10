import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import { DisTube } from 'distube';
import { SpotifyPlugin } from '@distube/spotify';
import { YtDlpPlugin } from '@distube/yt-dlp';
import dotenv from 'dotenv';

dotenv.config(); // Load environment variables (e.g., TOKEN from .env)

// Ensure the bot token is provided
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
    console.error("Error: Discord bot token is not set in the environment (TOKEN).");
    process.exit(1);
}

// Create a new Discord client with necessary intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,            // guild information
        GatewayIntentBits.GuildMessages,     // text messages
        GatewayIntentBits.GuildVoiceStates,  // voice channel data
        GatewayIntentBits.GuildMembers,      // for join/leave and role members
        GatewayIntentBits.MessageContent     // to read message content
    ],
    partials: [Partials.Channel]             // for DMs or partial data
});

// Initialize DisTube with Spotify and YouTube (via yt-dlp) support
const distube = new DisTube(client, {
    plugins: [
        new SpotifyPlugin(),              // enable Spotify links [oai_citation:6‡npmjs.com](https://www.npmjs.com/package/@distube/spotify#:~:text=const%20,new%20SpotifyPlugin%28%29%5D%2C)
        new YtDlpPlugin({ update: true }) // enable YouTube/others via yt-dlp [oai_citation:7‡npmjs.com](https://www.npmjs.com/package/@distube/yt-dlp#:~:text=import%20,dlp)
    ]
});

// When the bot is ready
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

// Send an embed log when a member joins
client.on('guildMemberAdd', member => {
    const joinEmbed = new EmbedBuilder()
        .setTitle('Member Joined')
        .setColor('Green')
        .setDescription(`${member.user.tag} has joined the server.`)
        .addFields(
            { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: false },
            { name: 'Member Count', value: `${member.guild.memberCount}`, inline: false }
        )
        .setThumbnail(member.user.displayAvatarURL({ size: 1024 }));
    const logChannel = member.guild.systemChannel;
    if (logChannel) {
        logChannel.send({ embeds: [joinEmbed] }).catch(console.error);
    }
});

// Send an embed log when a member leaves
client.on('guildMemberRemove', member => {
    const leaveEmbed = new EmbedBuilder()
        .setTitle('Member Left')
        .setColor('Red')
        .setDescription(`${member.user.tag} has left the server.`)
        .addFields(
            { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: false },
            { name: 'Member Count', value: `${member.guild.memberCount}`, inline: false }
        )
        .setThumbnail(member.user.displayAvatarURL({ size: 1024 }));
    const logChannel = member.guild.systemChannel;
    if (logChannel) {
        logChannel.send({ embeds: [leaveEmbed] }).catch(console.error);
    }
});

// Handle messages for commands and auto-reactions
client.on('messageCreate', message => {
    // Ignore bot messages and non-guild messages
    if (message.author.bot || !message.guild) return;

    // Auto-react with ✅ if @everyone or @here is mentioned
    if (message.mentions.everyone) {
        message.react('✅').catch(console.error);
    }

    // Use '!' as the command prefix
    const prefix = '!';
    if (!message.content.startsWith(prefix)) return;
    const args = message.content.slice(prefix.length).trim().split(/\s+/);
    const command = args.shift().toLowerCase();

    // Music commands using DisTube
    if (command === 'play') {
        const query = args.join(' ');
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) {
            message.reply('You need to join a voice channel first!').catch(console.error);
            return;
        }
        // Play the song/query in the user's voice channel
        distube.play(voiceChannel, query, {
            textChannel: message.channel,
            member: message.member
        }).catch(err => {
            console.error(err);
            message.reply(`Error playing: ${err.message}`).catch(console.error);
        });
    }
    else if (command === 'skip') {
        const queue = distube.getQueue(message);
        if (!queue) {
            message.reply('Nothing is playing right now.').catch(console.error);
        } else {
            // Skip the current song
            distube.skip(message)
                .then(() => message.channel.send('⏭ Skipped the song.'))
                .catch(err => {
                    console.error(err);
                    message.reply(`Could not skip: ${err.message}`).catch(console.error);
                });
        }
    }
    else if (command === 'stop') {
        const queue = distube.getQueue(message);
        if (!queue) {
            message.reply('Nothing is playing to stop.').catch(console.error);
        } else {
            // Stop playback and clear the queue
            distube.stop(message);
            message.channel.send('🛑 Stopped the music and cleared the queue.').catch(console.error);
        }
    }
    else if (command === 'loop') {
        const queue = distube.getQueue(message);
        if (!queue) {
            message.reply('Nothing is playing to loop.').catch(console.error);
        } else {
            // Toggle repeat mode (Off, this song, all queue)
            const mode = distube.setRepeatMode(message); // 0,1,2 [oai_citation:8‡npmjs.com](https://www.npmjs.com/package/distube/v/1.3.3#:~:text=,play%20mode)
            const modes = ['Off', 'This Song', 'All Queue'];
            message.channel.send(`🔁 Loop mode set to: **${modes[mode]}**`).catch(console.error);
        }
    }
    // Command to DM all members of a mentioned role
    else if (command === 'dmrole') {
        // Format: !dmrole @Role Your message here
        const role = message.mentions.roles.first();
        if (!role) {
            message.reply('Please mention a role to DM.').catch(console.error);
            return;
        }
        // Remove the role mention from args and join the rest as the message
        args.shift(); // Remove role arg
        const dmMessage = args.join(' ');
        if (!dmMessage) {
            message.reply('Please include a message to send to the role members.').catch(console.error);
            return;
        }
        // DM each member of the role
        role.members.forEach(member => {
            member.send(dmMessage).catch(err => {
                // Ignore if user has DMs disabled or blocks the bot
                console.error(`Could not DM ${member.user.tag}: ${err.message}`);
            });
        });
        message.channel.send(`✉️ Sent a DM to all members of ${role.name}.`).catch(console.error);
    }
});

// Log in to Discord (secure token from environment) [oai_citation:9‡npmjs.com](https://www.npmjs.com/package/distube/v/1.3.3#:~:text=prefix%3A%20,)
client.login(TOKEN).catch(console.error);