// ==========================
// Agnello FC Bot - Full Index.js
// ==========================

// --- Imports ---
import { Client, GatewayIntentBits, Partials, PermissionsBitField, EmbedBuilder } from "discord.js";
import { joinVoiceChannel, entersState, VoiceConnectionStatus, createAudioPlayer, createAudioResource, AudioPlayerStatus } from "@discordjs/voice";
import prism from "prism-media";
import fs from "fs";
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

// --- Global Music Queue ---
const queue = new Map(); // guildId => { connection, player, songs }

// --- Swear words list (example, you can expand) ---
const swears = ["fuck","shit","bitch","ass","damn","bastard","cunt","dick","pussy"];

// ==========================
// Logging Helper
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
// Moderation Commands
// ==========================
client.on("messageCreate", async message => {
    if (!message.content.startsWith("!")) return;
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return;

    const args = message.content.split(" ");
    const command = args[0].toLowerCase();

    if(command === "!ban") {
        const user = message.mentions.members.first();
        if(user) {
            await user.ban({ reason: "Banned by command" });
            logAction("Ban", `${user.user.tag} was banned by ${message.author.tag}`, message.guild);
        }
    }

    if(command === "!unban") {
        const userId = args[1];
        if(userId) {
            await message.guild.bans.remove(userId);
            logAction("Unban", `${userId} was unbanned by ${message.author.tag}`, message.guild);
        }
    }

    if(command === "!kick") {
        const user = message.mentions.members.first();
        if(user) {
            await user.kick("Kicked by command");
            logAction("Kick", `${user.user.tag} was kicked by ${message.author.tag}`, message.guild);
        }
    }

    if(command === "!timeout") {
        const user = message.mentions.members.first();
        const duration = parseInt(args[2]) || 10;
        if(user) {
            await user.timeout(duration * 1000, "Timeout by command");
            logAction("Timeout", `${user.user.tag} timed out for ${duration}s by ${message.author.tag}`, message.guild);
        }
    }

    if(command === "!vmute") {
        const user = message.mentions.members.first();
        if(user && user.voice.channel) {
            await user.voice.setMute(true, "Muted by command");
            logAction("Voice Mute", `${user.user.tag} was voice muted`, message.guild);
        }
    }
});

// ==========================
// Music Commands
// ==========================
client.on("messageCreate", async message => {
    if(!message.content.startsWith("!")) return;

    const args = message.content.split(" ");
    const command = args[0].toLowerCase();
    const serverQueue = queue.get(message.guild.id);

    if(command === "!play") {
        const url = args[1];
        if(!url) return message.reply("❌ Please provide a YouTube URL");
        const voiceChannel = message.member.voice.channel;
        if(!voiceChannel) return message.reply("❌ You must be in a VC!");

        let connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: message.guild.id,
            adapterCreator: message.guild.voiceAdapterCreator
        });

        if(!serverQueue) {
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

    if(command === "!skip") {
        if(!serverQueue) return;
        serverQueue.player.stop();
        message.channel.send("⏭️ Skipped!");
    }

    if(command === "!stop") {
        if(!serverQueue) return;
        serverQueue.songs = [];
        serverQueue.player.stop();
        queue.delete(message.guild.id);
        message.channel.send("🛑 Stopped!");
    }
});

function playSong(guildId) {
    const serverQueue = queue.get(guildId);
    if(!serverQueue || serverQueue.songs.length === 0) {
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
// Hostfriendly Reaction Role
// ==========================
client.on("messageCreate", async message => {
    if(message.content.toLowerCase() === "!hostfriendly") {
        const embed = new EmbedBuilder()
            .setColor(0x00AE86)
            .setTitle("__**AGNELLO FC 7v7 FRIENDLY**__")
            .setDescription(
                `React 1️⃣ → GK\n` +
                `React 2️⃣ → CB\n` +
                `React 3️⃣ → CB2\n` +
                `React 4️⃣ → CM\n` +
                `React 5️⃣ → LW\n` +
                `React 6️⃣ → RW\n` +
                `React 7️⃣ → ST\n` +
                `@everyone`
            )
            .setFooter({ text: "Powered by Agnello FC Bot" })
            .setTimestamp();

        const sent = await message.channel.send({ content: "@everyone", embeds: [embed] });
        const emojis = ["1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣","7️⃣"];
        for(const e of emojis) await sent.react(e);

        const claimed = {};
        const collector = sent.createReactionCollector({ filter: (r,u) => !u.bot });

        collector.on("collect", async (reaction, user) => {
            const member = await message.guild.members.fetch(user.id);
            if(Object.values(claimed).includes(user.id)) return;
            const index = emojis.indexOf(reaction.emoji.name);
            if(index > -1) {
                claimed[index] = user.id;
                message.channel.send(`✅ ${reaction.emoji.name} confirmed for <@${user.id}>`);
            }
        });

        collector.on("end", () => {
            const final = emojis.map((e,i) => `${e} → <@${claimed[i] || "Not claimed"}>`).join("\n");
            message.channel.send(`**FINAL LINEUP:**\n${final}`);
        });
    }
});

// ==========================
// Activity Check
// ==========================
client.on("messageCreate", async message => {
    if(message.content.startsWith("!activitycheck")) {
        const args = message.content.split(" ");
        const goal = parseInt(args[1]) || 10;
        const embed = new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle("__**AGNELLO FC Activity Check**__")
            .setDescription(`React with ✅\nGoal: ${goal}\nDuration: 1 Day\n@everyone`)
            .setTimestamp();

        const sent = await message.channel.send({ content: "@everyone", embeds: [embed] });
        await sent.react("✅");

        const filter = (reaction,user) => reaction.emoji.name === "✅" && !user.bot;
        const collector = sent.createReactionCollector({ filter, time: 24*60*60*1000 });
        collector.on("collect", r => {
            if(r.count - 1 >= goal) message.channel.send(`🎉 Activity Check goal reached!`);
        });
    }
});

// ==========================
// Automatic VC Moderation
// ==========================
client.on("voiceStateUpdate", async (oldState,newState) => {
    if(!newState.channelId) return; // left VC
    const member = newState.member;

    if(member.user.bot) return;

    // Auto mute anyone joining VC
    if(newState.channel) {
        try { await member.voice.setMute(true, "Auto VC mute"); } catch(err) {}
        logAction("Auto VC Mute", `${member.user.tag} was auto-muted in VC`, newState.guild);

        // Record 10s clip
        try {
            const connection = joinVoiceChannel({
                channelId: newState.channelId,
                guildId: newState.guild.id,
                adapterCreator: newState.guild.voiceAdapterCreator,
                selfMute: true,
                selfDeaf: true
            });
            const receiver = connection.receiver;
            const audioStream = receiver.subscribe(member.id, { end: { behavior: "silence", duration: 10000 } });
            const chunks = [];
            audioStream.on("data", chunk => chunks.push(chunk));
            audioStream.on("end", () => {
                const buffer = Buffer.concat(chunks);
                fs.writeFileSync(`./vc_logs/${member.id}_${Date.now()}.pcm`, buffer);
                logAction("VC Clip Saved", `${member.user.tag}'s 10s clip recorded`, newState.guild);
            });
        } catch(err) { console.error(err); }
    }
});

// ==========================
// Auto ✅ for @everyone / @here
// ==========================
client.on("messageCreate", async message => {
    if(message.mentions.has(message.guild.roles.everyone) || message.content.includes("@here")) {
        message.react("✅");
    }
});

// ==========================
// Bot Ready
// ==========================
client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log("Voice + Music + VC Auto-Moderation Ready!");
});

// ==========================
// Login
// ==========================
client.login(TOKEN);
