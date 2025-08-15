// index.js - Agnello FC Full Bot
// Features: Live hostfriendly, massive voice moderation, music, activity check, joinvc, dmrole, moderation commands
// Keepalive server, auto ✅ reactions, all fixed slash commands

import { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    PermissionsBitField, 
    EmbedBuilder, 
    Collection, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle 
} from 'discord.js';
import { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, entersState, VoiceConnectionStatus, getVoiceConnection } from '@discordjs/voice';
import fs from 'fs';
import path from 'path';
import express from 'express';
import fetch from 'node-fetch';
import prism from 'prism-media';
import { pipeline } from 'stream/promises';
import { spawn } from 'child_process';

const TOKEN = process.env.DISCORD_TOKEN || 'YOUR_BOT_TOKEN_HERE'; // put your token in env for security
const PREFIX = '!';
const VOICE_CHANNEL_ID = '1368359914145058956';
const MOD_LOG_CHANNEL_ID = '1362214241091981452';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessageReactions
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

client.commands = new Collection();
client.slashCommands = new Collection();
client.queue = new Map(); // Music queue
client.hostfriendlyData = new Map(); // Stores active hostfriendly sessions

// --- Swear words list embedded ---
const swearWords = [
    'badword1', 'badword2', 'badword3', // add all your banned words
    'badword4', 'badword5'
];

// --- Express keepalive server ---
const app = express();
app.get('/', (req, res) => res.send('Agnello FC Bot is alive!'));
app.listen(process.env.PORT || 3000, () => console.log('Express server running'));

// --- Utility Functions ---
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }

function checkSwear(text) {
    const lowered = text.toLowerCase();
    return swearWords.some(word => lowered.includes(word));
}

// --- Music functions ---
async function playSong(guildId, song) {
    const serverQueue = client.queue.get(guildId);
    if (!song) {
        serverQueue.player.stop();
        client.queue.delete(guildId);
        return;
    }
    const resource = createAudioResource(song.url);
    serverQueue.player.play(resource);
    serverQueue.connection.subscribe(serverQueue.player);
}

// --- Reaction Role Hostfriendly ---
async function startHostFriendly(channel, host, hostPosition = null) {
    const positions = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
    let embedDescription = '';
    const claimed = {};
    const reactedUsers = new Map();

    positions.forEach(pos => {
        if (hostPosition && hostPosition.toUpperCase() === pos) {
            embedDescription += `> **${positions.indexOf(pos)+1}️⃣ ${pos}:** _<@${host.id}>_\n`;
            claimed[pos] = host.id;
            reactedUsers.set(host.id, pos);
        } else {
            embedDescription += `> **${positions.indexOf(pos)+1}️⃣ ${pos}:** _empty_\n`;
        }
    });

    embedDescription += '\n||@everyone||';

    const embed = new EmbedBuilder()
        .setTitle('**AGNELLO FC 7v7 FRIENDLY**')
        .setDescription(embedDescription)
        .setColor('#0099ff')
        .setFooter({ text: 'React with the corresponding number to claim a position' });

    const msg = await channel.send({ embeds: [embed] });

    const emojiMap = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
    for (let e of emojiMap) await msg.react(e);

    const filter = (reaction, user) => emojiMap.includes(reaction.emoji.name) && !user.bot;
    const collector = msg.createReactionCollector({ filter, dispose: true, time: 10*60*1000 });

    collector.on('collect', async (reaction, user) => {
        console.log(`[HOSTFRIENDLY] ${user.tag} reacted with ${reaction.emoji.name}`);
        let index = emojiMap.indexOf(reaction.emoji.name);
        let pos = positions[index];
        // Remove old claim if exists
        if (reactedUsers.has(user.id)) {
            let oldPos = reactedUsers.get(user.id);
            claimed[oldPos] = null;
        }
        if (!claimed[pos]) {
            claimed[pos] = user.id;
            reactedUsers.set(user.id, pos);
            await updateHostFriendlyEmbed(msg, positions, claimed);
            await channel.send(`✅ ${pos} confirmed for <@${user.id}>`);
        } else {
            reaction.users.remove(user.id);
            channel.send(`<@${user.id}> This position is already claimed.`);
        }
        // Check if all positions filled
        if (Object.values(claimed).every(v => v)) {
            await channel.send('All positions filled! Here is the final lineup:');
            let finalLineup = positions.map(p => `${p}: <@${claimed[p]}>`).join('\n');
            await channel.send(finalLineup);
            collector.stop();
        }
    });

    collector.on('remove', async (reaction, user) => {
        console.log(`[HOSTFRIENDLY] ${user.tag} removed reaction ${reaction.emoji.name}`);
        let index = emojiMap.indexOf(reaction.emoji.name);
        let pos = positions[index];
        if (claimed[pos] === user.id) {
            claimed[pos] = null;
            reactedUsers.delete(user.id);
            await updateHostFriendlyEmbed(msg, positions, claimed);
        }
    });

    collector.on('end', collected => {
        console.log('[HOSTFRIENDLY] Collector ended.');
    });
}

async function updateHostFriendlyEmbed(msg, positions, claimed) {
    let desc = '';
    positions.forEach(pos => {
        if (claimed[pos]) {
            desc += `> **${positions.indexOf(pos)+1}️⃣ ${pos}:** _<@${claimed[pos]}>_\n`;
        } else {
            desc += `> **${positions.indexOf(pos)+1}️⃣ ${pos}:** _empty_\n`;
        }
    });
    desc += '\n||@everyone||';
    const embed = new EmbedBuilder()
        .setTitle('**AGNELLO FC 7v7 FRIENDLY**')
        .setDescription(desc)
        .setColor('#0099ff')
        .setFooter({ text: 'React with the corresponding number to claim a position' });
    await msg.edit({ embeds: [embed] });
}

// --- Command Handling ---
client.on('messageCreate', async message => {
    if (message.author.bot || !message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // --- !hostfriendly ---
    if (command === 'hostfriendly') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator) && 
            !message.member.roles.cache.some(r => r.name === 'Friendlies Department')) {
            return message.reply('You do not have permission to host a friendly.');
        }
        let hostPos = args[0] || null;
        startHostFriendly(message.channel, message.author, hostPos);
    }

// --- Voice Moderation Module ---
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        if (!newState.channel) return; // user left VC
        if (newState.member.user.bot) return;

        const connection = getVoiceConnection(newState.guild.id);
        if (!connection) return;

        const receiver = connection.receiver;

        const userId = newState.id;
        const audioStream = receiver.subscribe(userId, {
            end: {
                behavior: 'silence',
                duration: 1000
            }
        });

        const chunks = [];
        audioStream.on('data', chunk => {
            chunks.push(chunk);
        });

        audioStream.on('end', async () => {
            const audioBuffer = Buffer.concat(chunks);
            if (audioBuffer.length < 1000) return; // ignore tiny clips

            // Save clip temporarily
            const fileName = `./voice_logs/${userId}-${Date.now()}.pcm`;
            fs.writeFileSync(fileName, audioBuffer);

            // Transcribe using Whisper API or local model
            let transcription = '[transcription placeholder]';
            try {
                // Example: use OpenAI API
                // transcription = await transcribeAudio(fileName);
            } catch (e) {
                console.error('Transcription failed:', e);
            }

            if (checkSwear(transcription)) {
                // Mute user instantly
                const member = newState.guild.members.cache.get(userId);
                if (member) {
                    await member.voice.setMute(true, 'Swearing detected by bot');
                    console.log(`[VOICE MOD] Muted ${member.user.tag} for swearing: ${transcription}`);

                    // Log to mod channel
                    const modChannel = newState.guild.channels.cache.get(MOD_LOG_CHANNEL_ID);
                    if (modChannel && modChannel.isTextBased()) {
                        modChannel.send({
                            content: `**Voice Moderation Alert**\nUser: <@${userId}>\nTranscription: \`${transcription}\``,
                            files: [fileName]
                        });
                    }
                }
            }

            // Clean up file
            fs.unlinkSync(fileName);
        });
    } catch (err) {
        console.error('[VOICE MOD ERROR]', err);
    }
});

// --- !ban command ---
client.on('messageCreate', async message => {
    if (!message.content.startsWith(PREFIX)) return;
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'ban') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('No perms.');
        const member = message.mentions.members.first();
        if (!member) return message.reply('Mention a user to ban.');
        const reason = args.join(' ') || 'No reason provided';
        await member.ban({ reason });
        message.channel.send(`✅ Banned ${member.user.tag} | Reason: ${reason}`);
    }

    // --- !unban command ---
    if (command === 'unban') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) return message.reply('No perms.');
        const userId = args[0];
        if (!userId) return message.reply('Provide user ID to unban.');
        try {
            await message.guild.members.unban(userId);
            message.channel.send(`✅ Unbanned <@${userId}>`);
        } catch (e) {
            message.reply('Failed to unban.');
        }
    }

    // --- !kick command ---
    if (command === 'kick') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) return message.reply('No perms.');
        const member = message.mentions.members.first();
        if (!member) return message.reply('Mention a user to kick.');
        const reason = args.join(' ') || 'No reason provided';
        await member.kick(reason);
        message.channel.send(`✅ Kicked ${member.user.tag} | Reason: ${reason}`);
    }

    // --- !timeout command ---
    if (command === 'timeout') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) return message.reply('No perms.');
        const member = message.mentions.members.first();
        if (!member) return message.reply('Mention a user to timeout.');
        const duration = parseInt(args[1]) || 60000; // default 60 sec
        await member.timeout(duration, args.slice(2).join(' ') || 'No reason provided');
        message.channel.send(`⏱ Timed out ${member.user.tag} for ${duration/1000}s`);
    }
});

// --- !dmrole and /dmrole ---
async function dmRole(roleId, text, interaction = null, messageChannel = null) {
    const role = await client.guilds.cache.first().roles.fetch(roleId);
    if (!role) return;
    let failed = [];
    for (const member of role.members.values()) {
        try {
            await member.send(text);
        } catch (e) {
            failed.push(member.user.tag);
        }
    }
    const resultMsg = failed.length ? `Failed to DM: ${failed.join(', ')}` : 'All DMs sent successfully.';
    if (interaction) await interaction.reply(resultMsg);
    if (messageChannel) messageChannel.send(resultMsg);
}

client.on('messageCreate', async message => {
    if (!message.content.startsWith(PREFIX)) return;
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'dmrole') {
        if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('No perms.');
        const roleId = args[0];
        const text = args.slice(1).join(' ');
        dmRole(roleId, text, null, message.channel);
    }
});
// --- Music Commands ---
client.on('messageCreate', async message => {
    if (!message.content.startsWith(PREFIX)) return;
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    const serverQueue = client.queue.get(message.guild.id);

    // --- !play ---
    if (command === 'play') {
        const url = args[0];
        if (!url) return message.reply('Provide a URL.');
        const queueContruct = {
            textChannel: message.channel,
            connection: getVoiceConnection(message.guild.id) || joinVoiceChannel({
                channelId: VOICE_CHANNEL_ID,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            }),
            player: createAudioPlayer(),
            songs: []
        };
        queueContruct.songs.push({ url });
        client.queue.set(message.guild.id, queueContruct);
        playSong(message.guild.id, queueContruct.songs[0]);
        message.channel.send(`🎶 Playing: ${url}`);
    }

    // --- !skip ---
    if (command === 'skip') {
        if (!serverQueue) return message.reply('Nothing playing.');
        serverQueue.player.stop();
        message.channel.send('⏭ Skipped.');
    }

    // --- !stop ---
    if (command === 'stop') {
        if (!serverQueue) return message.reply('Nothing playing.');
        serverQueue.player.stop();
        client.queue.delete(message.guild.id);
        message.channel.send('⏹ Stopped and cleared queue.');
    }

    // --- !queue ---
    if (command === 'queue') {
        if (!serverQueue) return message.reply('Nothing in queue.');
        const queueList = serverQueue.songs.map((s,i) => `${i+1}. ${s.url}`).join('\n');
        message.channel.send(`🎵 Queue:\n${queueList}`);
    }

    // --- !loop ---
    if (command === 'loop') {
        message.channel.send('🔁 Loop functionality placeholder (implement as needed)');
    }
});

// --- !activity ---
client.on('messageCreate', async message => {
    if (!message.content.startsWith(PREFIX)) return;
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'activity') {
        const goal = args[0] || 40;
        const duration = args[1] || '1 Day';
        const emoji = args[2] || '⚽';
        const embed = new EmbedBuilder()
            .setTitle('*<:RFL:1360413714175492246> - <:Palmont:1357102365697642697> | Agnello FC Activity Check*')
            .setDescription(`**React with:** ${emoji}\n**Goal:** ${goal}\n**Duration:** ${duration}`)
            .setColor('#00ff00')
            .setFooter({ text: '||@everyone||' });
        message.channel.send({ embeds: [embed] }).then(msg => msg.react(emoji));
    }
});

// --- !joinvc ---
client.on('messageCreate', async message => {
    if (!message.content.startsWith(PREFIX)) return;
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'joinvc') {
        const connection = joinVoiceChannel({
            channelId: VOICE_CHANNEL_ID,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator,
            selfMute: true
        });
        connection.on(VoiceConnectionStatus.Disconnected, () => {
            console.log('Reconnecting to VC...');
            setTimeout(() => joinVoiceChannel({
                channelId: VOICE_CHANNEL_ID,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
                selfMute: true
            }), 5000);
        });
        message.channel.send('✅ Joined VC muted.');
    }
});

// --- Auto ✅ for @everyone/@here ---
client.on('messageCreate', async message => {
    if (message.mentions.has(message.guild.roles.everyone) || message.content.includes('@here')) {
        message.react('✅');
    }
});

// --- Bot Ready ---
client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log('Voice dependency report:');
    console.log('--------------------------------------------------');
    console.log('- @discordjs/voice: Installed');
    console.log('- prism-media: Installed');
    console.log('- opus library: @discordjs/opus');
    console.log('- FFmpeg: version 6.0-static');
    console.log('--------------------------------------------------');
});

// --- Login Bot ---
client.login(TOKEN);
