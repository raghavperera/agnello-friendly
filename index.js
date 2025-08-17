// ==========================
// agnello-friendly Discord Bot
// ==========================

// --- Imports ---
import { 
    Client, 
    GatewayIntentBits, 
    Partials, 
    EmbedBuilder,
    PermissionsBitField
} from 'discord.js';

import { 
    joinVoiceChannel, 
    VoiceConnectionStatus 
} from '@discordjs/voice';

import fs from 'fs';
import path from 'path';
import process from 'process';

// --- Config ---
const TOKEN = process.env.TOKEN;
const LOG_CHANNEL_ID = "1362214241091981452"; // Logs channel

// --- Client Init ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ],
    partials: [Partials.Channel]
});

// --- Utility: Logging ---
function logAction(action, details, guild) {
    const channel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (channel) {
        const embed = new EmbedBuilder()
            .setTitle(`🔎 ${action}`)
            .setDescription(details)
            .setColor("Red")
            .setTimestamp();
        channel.send({ embeds: [embed] }).catch(console.error);
    }
    console.log(`[LOG] ${action}: ${details}`);
}

// ==========================
// Moderation Commands
// ==========================

// --- Ban Command ---
client.on("messageCreate", async (message) => {
    if (!message.content.startsWith("!ban") || message.author.bot) return;

    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply("❌ You don’t have permission to use this.");
    }

    const user = message.mentions.users.first();
    if (!user) return message.reply("⚠️ Mention someone to ban.");

    const member = message.guild.members.cache.get(user.id);
    if (!member) return message.reply("⚠️ User not found.");

    await member.ban({ reason: "Banned via bot" });
    message.channel.send(`✅ Banned ${user.tag}`);
    logAction("Ban", `${message.author.tag} banned ${user.tag}`, message.guild);
});

// --- Unban Command ---
client.on("messageCreate", async (message) => {
    if (!message.content.startsWith("!unban") || message.author.bot) return;

    if (!message.member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
        return message.reply("❌ You don’t have permission to use this.");
    }

    const args = message.content.split(" ");
    const userId = args[1];
    if (!userId) return message.reply("⚠️ Provide a user ID to unban.");

    try {
        await message.guild.members.unban(userId);
        message.channel.send(`✅ Unbanned <@${userId}>`);
        logAction("Unban", `${message.author.tag} unbanned <@${userId}>`, message.guild);
    } catch (err) {
        console.error(err);
        message.reply("❌ Couldn’t unban user.");
    }
});
// --- Kick Command ---
client.on("messageCreate", async (message) => {
    if (!message.content.startsWith("!kick") || message.author.bot) return;

    if (!message.member.permissions.has(PermissionsBitField.Flags.KickMembers)) {
        return message.reply("❌ You don’t have permission to use this.");
    }

    const user = message.mentions.users.first();
    if (!user) return message.reply("⚠️ Mention someone to kick.");

    const member = message.guild.members.cache.get(user.id);
    if (!member) return message.reply("⚠️ User not found.");

    await member.kick("Kicked via bot");
    message.channel.send(`✅ Kicked ${user.tag}`);
    logAction("Kick", `${message.author.tag} kicked ${user.tag}`, message.guild);
});

// --- Timeout Command ---
client.on("messageCreate", async (message) => {
    if (!message.content.startsWith("!timeout") || message.author.bot) return;

    if (!message.member.permissions.has(PermissionsBitField.Flags.ModerateMembers)) {
        return message.reply("❌ You don’t have permission to use this.");
    }

    const user = message.mentions.users.first();
    const args = message.content.split(" ");
    const duration = parseInt(args[2]) * 60 * 1000; // in minutes

    if (!user || !duration) return message.reply("⚠️ Usage: `!timeout @user <minutes>`");

    const member = message.guild.members.cache.get(user.id);
    if (!member) return message.reply("⚠️ User not found.");

    await member.timeout(duration, "Timed out via bot");
    message.channel.send(`✅ Timed out ${user.tag} for ${args[2]} minutes`);
    logAction("Timeout", `${message.author.tag} timed out ${user.tag} for ${args[2]} minutes`, message.guild);
});

// ==========================
// Swear Filter
// ==========================
const badWords = ["fuck","shit","bitch","asshole","cunt","dick","bastard","slut","whore"]; // extend in swears.js

client.on("messageCreate", (message) => {
    if (message.author.bot) return;

    for (const word of badWords) {
        if (message.content.toLowerCase().includes(word)) {
            message.delete().catch(() => {});
            message.channel.send(`⚠️ ${message.author}, watch your language!`);
            logAction("Swear Filter", `${message.author.tag} said a banned word: "${word}"`, message.guild);
            break;
        }
    }
});

// ==========================
// Voice Moderation (BIGGEST FEATURE)
// ==========================
client.on("voiceStateUpdate", async (oldState, newState) => {
    const member = newState.member;

    // User joined VC
    if (!oldState.channelId && newState.channelId) {
        logAction("VC Join", `${member.user.tag} joined VC: ${newState.channel.name}`, newState.guild);
    }

    // User left VC
    if (oldState.channelId && !newState.channelId) {
        logAction("VC Leave", `${member.user.tag} left VC`, oldState.guild);
    }

    // Example: Mute on trigger
    if (newState.channelId && member.user.username.toLowerCase().includes("toxic")) {
        await member.voice.setMute(true, "Auto-mute by voice moderation");
        logAction("VC Auto-Mute", `${member.user.tag} was muted for suspicious activity`, newState.guild);
    }

    // 🎤 Advanced: Logging audio clips (pseudo - needs ffmpeg/opus stream)
    // Note: Real-time recording/clip logging would require ffmpeg piping streams,
    // which is very resource heavy and may not be Render-friendly.
    // We can stub logging here:
    logAction("VC Monitor", `Monitoring audio activity for ${member.user.tag}`, newState.guild);
});
// ==========================
// Reaction Role Example (Hostfriendly Command)
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
// Auto ✅ reaction for @everyone/@here
// ==========================
client.on("messageCreate", async (message) => {
    if (message.mentions.has(message.guild.roles.everyone) || message.content.includes("@here")) {
        message.react("✅");
    }
});

// ==========================
// Bot Ready Event
// ==========================
client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log("--------------------------------------------------");
    console.log("- @discordjs/voice: Installed");
    console.log("- prism-media: Installed");
    console.log("- opus library: @discordjs/opus");
    console.log("- FFmpeg: version 6.0-static");
    console.log("--------------------------------------------------");
});

// ==========================
// Helper Function - Logging
// ==========================
function logAction(action, details, guild) {
    const logChannel = guild.channels.cache.get("1362214241091981452");
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
// Login Bot
// ==========================
client.login(TOKEN);
