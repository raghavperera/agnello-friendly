// index.js
import { Client, GatewayIntentBits, Partials, EmbedBuilder } from "discord.js";
import {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
} from "@discordjs/voice";
import fs from "fs";

// ===============================
// BOT SETUP
// ===============================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const PREFIX = "!";
const HOST_ROLE_ID = "1383970211933454378";

// memory storage
client.lineupData = null;
client.musicPlayer = createAudioPlayer();

// ===============================
// READY EVENT
// ===============================
client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

// ===============================
// MESSAGE HANDLER
// ===============================
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    // ===============================
    // HOSTFRIENDLY COMMAND
    // ===============================
    if (command === "hostfriendly") {
        if (!message.member.roles.cache.has(HOST_ROLE_ID)) {
            message.reply("❌ You are not allowed to host friendlies.");
            return;
        }

        const positions = ["GK", "CB", "CB2", "CM", "LW", "RW", "ST"];
        const numbers = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣"];

        let lineup = {}; // userId -> posIndex
        let taken = new Array(positions.length).fill(null);

        // Preclaim logic
        let preclaimIndex = null;
        if (args[0]) {
            const arg = args[0].toLowerCase();
            let chosen = -1;

            if (!isNaN(arg)) {
                chosen = parseInt(arg) - 1;
            } else {
                chosen = positions.findIndex((p) => p.toLowerCase() === arg);
            }

            if (chosen >= 0 && chosen < positions.length && !taken[chosen]) {
                lineup[message.author.id] = chosen;
                taken[chosen] = message.author.id;
                preclaimIndex = chosen;
            }
        }

        // Embed builder
        const buildEmbed = () => {
            let desc = positions
                .map((pos, i) => {
                    const userId = taken[i];
                    return `${numbers[i]} ➝ **${pos}**\n${userId ? `<@${userId}>` : "_-_"}`;
                })
                .join("\n\n");

            let finalLineup = positions
                .map((pos, i) => `${pos}: ${taken[i] ? `<@${taken[i]}>` : "_-_"}`)
                .join("\n");

            return new EmbedBuilder()
                .setTitle("AGNELLO FC 7v7 FRIENDLY")
                .setColor("Green")
                .setDescription(
                    desc +
                        "\n\nReact to claim a position. Only 1 position per user.\n\n" +
                        "✅ **Final Lineup:**\n" +
                        finalLineup
                );
        };

        const embedMsg = await message.channel.send({ embeds: [buildEmbed()] });
        for (const emoji of numbers) {
            await embedMsg.react(emoji);
        }

        // Reaction collector
        const collector = embedMsg.createReactionCollector({
            filter: (reaction, user) =>
                numbers.includes(reaction.emoji.name) && !user.bot,
            dispose: true,
        });

        collector.on("collect", async (reaction, user) => {
            const posIndex = numbers.indexOf(reaction.emoji.name);

            if (lineup[user.id] !== undefined) {
                await reaction.users.remove(user.id);
                message.channel.send(`<@${user.id}> ❌ You are already in the lineup!`);
                return;
            }

            if (taken[posIndex]) {
                await reaction.users.remove(user.id);
                message.channel.send(`<@${user.id}> ❌ That position is already filled.`);
                return;
            }

            lineup[user.id] = posIndex;
            taken[posIndex] = user.id;

            try {
                await user.send(
                    `✅ You have been confirmed for **${positions[posIndex]}** in the lineup!`
                );
            } catch {
                message.channel.send(`⚠️ Could not DM <@${user.id}>.`);
            }

            await embedMsg.edit({ embeds: [buildEmbed()] });
            message.channel.send(`✅ ${positions[posIndex]} confirmed for <@${user.id}>`);
        });

        // save to memory
        client.lineupData = { embedMsg, lineup, taken, positions, numbers };
    }

    // ===============================
    // EDIT LINEUP
    // ===============================
    if (command === "editlineup") {
        if (!message.member.roles.cache.has(HOST_ROLE_ID)) {
            message.reply("❌ Only the friendly host can edit the lineup.");
            return;
        }
        if (!client.lineupData) {
            message.reply("❌ No active lineup found.");
            return;
        }

        const { embedMsg, lineup, taken, positions, numbers } = client.lineupData;

        const posArg = args[0]?.toLowerCase();
        const user = message.mentions.users.first();
        if (!posArg || !user) {
            message.reply(
                "⚠️ Usage: `!editlineup <pos> <@user>` (e.g. `!editlineup cm @Player`)"
            );
            return;
        }

        let posIndex = -1;
        if (!isNaN(posArg)) {
            posIndex = parseInt(posArg) - 1;
        } else {
            posIndex = positions.findIndex((p) => p.toLowerCase() === posArg);
        }

        if (posIndex < 0 || posIndex >= positions.length) {
            message.reply("❌ Invalid position.");
            return;
        }

        // Free old slot
        if (taken[posIndex]) {
            const prevUserId = taken[posIndex];
            delete lineup[prevUserId];
        }

        // Assign
        lineup[user.id] = posIndex;
        taken[posIndex] = user.id;

        const buildEmbed = () => {
            let desc = positions
                .map((pos, i) => {
                    const userId = taken[i];
                    return `${numbers[i]} ➝ **${pos}**\n${userId ? `<@${userId}>` : "_-_"}`;
                })
                .join("\n\n");

            let finalLineup = positions
                .map((pos, i) => `${pos}: ${taken[i] ? `<@${taken[i]}>` : "_-_"}`)
                .join("\n");

            return new EmbedBuilder()
                .setTitle("AGNELLO FC 7v7 FRIENDLY")
                .setColor("Green")
                .setDescription(
                    desc + "\n\n✅ **Final Lineup:**\n" + finalLineup
                );
        };

        await embedMsg.edit({ embeds: [buildEmbed()] });
        message.channel.send(`✏️ ${positions[posIndex]} updated → <@${user.id}>`);
    }

    // ===============================
    // RESET LINEUP
    // ===============================
    if (command === "resetlineup") {
        if (!message.member.roles.cache.has(HOST_ROLE_ID)) {
            message.reply("❌ Only the host can reset.");
            return;
        }
        client.lineupData = null;
        message.channel.send("♻️ Lineup has been reset.");
    }

    // ===============================
    // BASIC MUSIC (play local file test)
    // ===============================
    if (command === "play") {
        const channel = message.member.voice.channel;
        if (!channel) {
            message.reply("❌ You must be in a voice channel.");
            return;
        }

        const connection = joinVoiceChannel({
            channelId: channel.id,
            guildId: channel.guild.id,
            adapterCreator: channel.guild.voiceAdapterCreator,
        });

        const resource = createAudioResource("song.mp3"); // put file in project root
        client.musicPlayer.play(resource);
        connection.subscribe(client.musicPlayer);

        client.musicPlayer.on(AudioPlayerStatus.Playing, () => {
            message.channel.send("🎵 Now playing music...");
        });
    }
});

// ===============================
// AUTO-MUTE (if user says banned word)
// ===============================
const bannedWords = ["fuck", "shit", "noob","bitch","nigger","nigga"]; // customize
client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    const content = message.content.toLowerCase();

    if (bannedWords.some((word) => content.includes(word))) {
        const member = message.member;
        if (member && member.voice.channel) {
            await member.voice.setMute(true, "Swearing detected");
            message.channel.send(
                `🔇 ${member.user.username} has been muted for 10s (bad language).`
            );
            setTimeout(() => {
                if (member.voice.channel) {
                    member.voice.setMute(false, "Mute expired");
                }
            }, 10000);
        }
    }
});

// ===============================
// LOGIN
// ===============================
client.login(process.env.TOKEN);
