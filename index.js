import { Client, GatewayIntentBits, Partials, EmbedBuilder, PermissionsBitField } from 'discord.js';
import dotenv from 'dotenv';
dotenv.config();

const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error("Error: TOKEN not set in environment.");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Channel],
});

// --- Globals for friendly hoster ---
let friendlyMessage = null;
let friendlyCollector = null;
const POSITIONS = ['GK', 'CB', 'CB2', 'CM', 'LW', 'RW', 'ST'];
let claimedPositions = {}; // position index (0-6) => userId
let claimedUsers = new Set();

client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const prefix = '!';
  if (!message.content.startsWith(prefix)) return;

  const args = message.content.slice(prefix.length).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // ===== !hostfriendly =====
  if (command === 'hostfriendly') {
    if (friendlyMessage) {
      message.channel.send('A friendly is already being hosted. Please wait until it finishes.').catch(console.error);
      return;
    }

    // Reset tracking
    claimedPositions = {};
    claimedUsers.clear();

    // Send the embed listing positions with instructions
    const embed = new EmbedBuilder()
      .setTitle('AGNELLO FC 7v7 FRIENDLY')
      .setDescription(
        POSITIONS.map((pos, i) => `${numberEmoji(i + 1)} → ${pos}`).join('\n') + '\n\n' +
        'React to claim your position. Only one position per user.'
      )
      .setColor('Blue');

    friendlyMessage = await message.channel.send({ embeds: [embed] });

    // Add reaction emojis 1️⃣ to 7️⃣
    for (let i = 0; i < POSITIONS.length; i++) {
      await friendlyMessage.react(numberEmoji(i + 1));
    }

    // Create a reaction collector to handle position claiming
    friendlyCollector = friendlyMessage.createReactionCollector({
      filter: (reaction, user) => !user.bot && numberEmojiRange().includes(reaction.emoji.name),
      time: 10 * 60 * 1000, // 10 minutes
    });

    friendlyCollector.on('collect', async (reaction, user) => {
      try {
        // Remove other reactions from this user if any
        const userReactions = friendlyMessage.reactions.cache.filter(r => r.users.cache.has(user.id));
        for (const r of userReactions.values()) {
          if (r.emoji.name !== reaction.emoji.name) {
            await r.users.remove(user.id);
          }
        }

        const posIndex = numberEmojiIndex(reaction.emoji.name);
        if (posIndex === -1) return;

        // Check if position already claimed
        if (claimedPositions[posIndex]) {
          if (claimedPositions[posIndex] === user.id) {
            // Already claimed by this user, do nothing
            return;
          } else {
            // Position taken by someone else, remove user's reaction
            reaction.users.remove(user.id).catch(() => {});
            message.channel.send(`${reaction.emoji} is already claimed by <@${claimedPositions[posIndex]}>.`).catch(() => {});
            return;
          }
        }

        // Check if user already claimed a different position
        if (claimedUsers.has(user.id)) {
          reaction.users.remove(user.id).catch(() => {});
          message.channel.send(`<@${user.id}>, you already claimed a position.`).catch(() => {});
          return;
        }

        // Assign position
        claimedPositions[posIndex] = user.id;
        claimedUsers.add(user.id);

        // Update embed with claimed users
        const lines = POSITIONS.map((pos, i) => {
          const userId = claimedPositions[i];
          return `${numberEmoji(i + 1)} → ${pos} : ${userId ? `<@${userId}>` : '_available_'}`;
        });
        embed.setDescription(lines.join('\n') + '\n\nReact to claim your position. Only one position per user.');
        await friendlyMessage.edit({ embeds: [embed] });

        message.channel.send(`✅ ${posIndex + 1}️⃣ ${POSITIONS[posIndex]} confirmed for <@${user.id}>`).catch(() => {});

        // Check if all positions filled - end early
        if (Object.keys(claimedPositions).length === POSITIONS.length) {
          friendlyCollector.stop('full');
        }
      } catch (err) {
        console.error('Error processing reaction:', err);
      }
    });

    friendlyCollector.on('end', async (_, reason) => {
      // Final lineup or cancellation
      if (Object.keys(claimedPositions).length === POSITIONS.length) {
        const lineup = POSITIONS.map((pos, i) => `${pos}: <@${claimedPositions[i]}>`).join('\n');
        await message.channel.send(`**Friendly lineup confirmed:**\n${lineup}\n\nWaiting for host to post the friendly link...`);
      } else {
        await message.channel.send('Friendly cancelled due to not enough players.');
      }
      // Clean up
      friendlyMessage = null;
      friendlyCollector = null;
      claimedPositions = {};
      claimedUsers.clear();
    });

    return;
  }

  // ===== !dmrole =====
  if (command === 'dmrole') {
    const role = message.mentions.roles.first();
    if (!role) {
      message.reply('Please mention a role to DM.').catch(console.error);
      return;
    }
    args.shift(); // Remove role mention
    const dmMessage = args.join(' ');
    if (!dmMessage) {
      message.reply('Please provide a message to send.').catch(console.error);
      return;
    }

    let successCount = 0;
    let failCount = 0;
    for (const [memberId, member] of role.members) {
      try {
        await member.send(dmMessage);
        successCount++;
      } catch {
        failCount++;
      }
    }
    message.channel.send(`Sent message to ${successCount} members. Failed to DM ${failCount} members.`).catch(console.error);
    return;
  }

  // ===== !activitycheck =====
  if (command === 'activitycheck') {
    // Usage: !activitycheck <goal> <durationHours>
    // Defaults:
    let goal = parseInt(args[0]);
    if (isNaN(goal) || goal < 1) goal = 40;
    let durationHours = parseInt(args[1]);
    if (isNaN(durationHours) || durationHours < 1) durationHours = 24;

    const embed = new EmbedBuilder()
      .setTitle('🏆 Agnello FC Activity Check')
      .setDescription(`React with ✅ to join the activity check!`)
      .addFields(
        { name: 'Goal', value: `${goal}`, inline: true },
        { name: 'Duration', value: `${durationHours} hour(s)`, inline: true }
      )
      .setColor('Green')
      .setFooter({ text: 'React to this message!' });

    const activityMessage = await message.channel.send({ content: '@everyone', embeds: [embed] });
    await activityMessage.react('✅');

    // Optional: You can create a reaction collector here for tracking if you want

    return;
  }

  // Other commands ignored
});

client.login(TOKEN);

// Helpers for number emojis
function numberEmoji(number) {
  const map = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
  return map[number - 1] || '';
}
function numberEmojiRange() {
  return ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣'];
}
function numberEmojiIndex(emoji) {
  const map = {'1️⃣':0,'2️⃣':1,'3️⃣':2,'4️⃣':3,'5️⃣':4,'6️⃣':5,'7️⃣':6};
  return map[emoji] ?? -1;
}