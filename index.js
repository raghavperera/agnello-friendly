// ==========================
// Agnello Bot - Full Index.js
// ==========================

// --- Imports ---
import { 
    Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField 
} from "discord.js";
import { 
    joinVoiceChannel, createAudioPlayer, createAudioResource, 
    VoiceConnectionStatus, AudioPlayerStatus 
} from "@discordjs/voice";
import ytdl from "ytdl-core";

// --- Config ---
const TOKEN = process.env.TOKEN;
const LOG_CHANNEL_ID = "1362214241091981452";

// --- Client Setup ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel]
});

// --- Music Player ---
const queue = new Map(); // guildId => { connection, player, songs }

// ==========================
// Moderation Commands
// ==========================
client.on("messageCreate", async (message) => {
    if (!message.content.startsWith("!")) return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

    const args = message.content.split(" ");
    const command = args[0].toLowerCase();

    if (command === "!ban") {
        const user = message.mentions.members.first();
        if (user) {
            await user.ban({ reason: "Banned by command" });
            logAction("Ban", `${user.user.tag} was banned by ${message.author.tag}`, message.guild);
        }
    }

    if (command === "!unban") {
        const userId = args[1];
        if (userId) {
            await message.guild.bans.remove(userId);
            logAction("Unban", `${userId} was unbanned by ${message.author.tag}`, message.guild);
        }
    }

    if (command === "!kick") {
        const user = message.mentions.members.first();
        if (user) {
            await user.kick("Kicked by command");
            logAction("Kick", `${user.user.tag} was kicked by ${message.author.tag}`, message.guild);
        }
    }

    if (command === "!timeout") {
        const user = message.mentions.members.first();
        const duration = parseInt(args[2]) || 10; // seconds
        if (user) {
            await user.timeout(duration * 1000, "Timeout by command");
            logAction("Timeout", `${user.user.tag} timed out for ${duration}s by ${message.author.tag}`, message.guild);
        }
    }
});

// ==========================
// Voice Moderation (Mute)
// ==========================
client.on("messageCreate", async (message) => {
    if (message.content.startsWith("!vmute")) {
        const user = message.mentions.members.first();
        if (user && user.voice.channel) {
            await user.voice.setMute(true, "Muted by command");
            logAction("Voice Mute", `${user.user.tag} was voice muted`, message.guild);
        }
    }
});

// ==========================
// Music Commands
// ==========================
client.on("messageCreate", async (message) => {
    if (!message.content.startsWith("!")) return;

    const args = message.content.split(" ");
    const command = args[0].toLowerCase();
    const serverQueue = queue.get(message.guild.id);

    if (command === "!play") {
        const url = args[1];
        if (!url) return message.reply("❌ Please provide a YouTube URL");

        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) return message.reply("❌ You must be in a VC!");

        let connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator
        });

        if (!serverQueue) {
            const player = createAudioPlayer();
            const song = { url };

            queue.set(message.guild.id, { connection, player, songs: [song] });
            playSong(message.guild.id);
            logAction("Music", `Started playing ${url}`, message.guild);
        } else {
            serverQueue.songs.push({ url });
            message.channel.send(`🎶 Added to queue: ${url}`);
        }
    }

    if (command === "!skip") {
        if (!serverQueue) return;
        serverQueue.player.stop();
        message.channel.send("⏭️ Skipped!");
    }

    if (command === "!stop") {
        if (!serverQueue) return;
        serverQueue.songs = [];
        serverQueue.player.stop();
        queue.delete(message.guild.id);
        message.channel.send("🛑 Stopped!");
    }
});

function playSong(guildId) {
    const serverQueue = queue.get(guildId);
    if (!serverQueue || serverQueue.songs.length === 0) {
        queue.delete(guildId);
        return;
    }

    const song = serverQueue.songs.shift();
    const stream = ytdl(song.url, { filter: "audioonly" });
    const resource = createAudioResource(stream);

    serverQueue.player.play(resource);
    serverQueue.connection.subscribe(serverQueue.player);

    serverQueue.player.once(AudioPlayerStatus.Idle, () => {
        playSong(guildId);
    });
}

// ==========================
// Reaction Role (Hostfriendly)
// ==========================
client.on("messageCreate", async (message) => {
    if (message.content.toLowerCase() === "!hostfriendly") {
        const embed = new EmbedBuilder()
            .setColor(0x00AE86)
            .setTitle("__**Host-Friendly Setup**__")
            .setDescription(
                `Hey <@&${message.guild.roles.everyone.id}> 👋\n\n` +
                `React below to get access to the **Host-Friendly Zone**!\n\n` +
                `> ✅ = Get role\n` +
                `> ❌ = Remove role`
            )
            .setFooter({ text: "Powered by Agnello Bot" })
            .setTimestamp();

        const sent = await message.channel.send({ content: "@everyone", embeds: [embed] });
        await sent.react("✅");
        await sent.react("❌");

        const filter = (reaction, user) => !user.bot;
        const collector = sent.createReactionCollector({ filter, dispose: true });

        collector.on("collect", async (reaction, user) => {
            const member = await message.guild.members.fetch(user.id);
            if (reaction.emoji.name === "✅") {
                member.roles.add("ROLE_ID").catch(console.error);
                logAction("Reaction Role", `${user.tag} added Host-Friendly role`, message.guild);
            } else if (reaction.emoji.name === "❌") {
                member.roles.remove("ROLE_ID").catch(console.error);
                logAction("Reaction Role", `${user.tag} removed Host-Friendly role`, message.guild);
            }
        });
    }
});

// ==========================
// Auto ✅ for @everyone / @here
// ==========================
client.on("messageCreate", async (message) => {
    if (message.mentions.has(message.guild.roles.everyone) || message.content.includes("@here")) {
        message.react("✅");
    }
});

// ==========================
// Ready Event
// ==========================
client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log("Voice + Music ready!");
});

// ==========================
// Helper Function - Logging
// ==========================
function logAction(action, details, guild) {
    const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) {
        const embed = new EmbedBuilder()
            .setColor(0xff0000)
            .setTitle(`🔔 ${action}`)
            .setDescription(details)
            .setTimestamp();
        logChannel.send({ embeds: [embed] });
    }
    console.log(`[LOG] ${action} - ${details}`);
}

// ==========================
// Login
// ==========================
client.login(TOKEN);
