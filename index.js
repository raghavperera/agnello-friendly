import "dotenv/config";
import express from "express";
import {
  Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, EmbedBuilder, ChannelType, PermissionsBitField,
} from "discord.js";
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus,
  VoiceConnectionStatus, NoSubscriberBehavior, entersState,
} from "@discordjs/voice";
import play from "play-dl";
import OpenAI from "openai";

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-mini";

const PREFIX = "!";
const GUILD_ID = process.env.GUILD_ID || "1540116399558313995";
const HOSTER_ROLE = process.env.FRIENDLY_HOSTER_ROLE_ID || "1541193960041615361";
const RESULTS_CHANNEL = process.env.RESULTS_CHANNEL_ID || "1540136949908770827";
const LOG_CHANNEL = process.env.LOG_CHANNEL_ID || "1362214241091981452";
const FIXED_VC = process.env.FIXED_VC_ID || "1368359914145058956";
const INVITE = process.env.INVITE_LINK || "https://discord.gg/ZrNuUKJFfS";
const PORT = Number(process.env.PORT || 10000);

if (!TOKEN) {
  console.error("❌ TOKEN is missing.");
  process.exit(1);
}

const app = express();

app.get("/", (_req, res) => {
  res.status(200).send("erts United Bot is online.");
});

app.get("/health", (_req, res) => {
  res.json({
    status: "online",
    bot: client.user?.tag || null,
    guild: GUILD_ID,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Web server on ${PORT}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const openai = OPENAI_API_KEY
  ? new OpenAI({ apiKey: OPENAI_API_KEY })
  : null;

// ============================================================
// FRIENDLY SYSTEM
// ============================================================

const POSITIONS = [
  ["GK", "GK", "friendly_GK"],
  ["CB", "CB", "friendly_CB"],
  ["CB2", "CB2", "friendly_CB2"],
  ["CM", "CM", "friendly_CM"],
  ["LW", "LW", "friendly_LW"],
  ["RW", "RW", "friendly_RW"],
  ["ST", "ST", "friendly_ST"],
];

const NEED_ADD = "friendly_need_add";

const friendlies = new Map();
const completed = new Map();
const locks = new Map();
const pendingDMs = new Map();

const DM_TIMEOUT = 10 * 60 * 1000;

// ============================================================
// BASIC HELPERS
// ============================================================

function emptyLineup() {
  return {
    GK: null,
    CB: null,
    CB2: null,
    CM: null,
    LW: null,
    RW: null,
    ST: null,
  };
}

function filled(lineup) {
  return Object.values(lineup).filter(Boolean).length;
}

function complete(lineup) {
  return filled(lineup) === 7;
}

function mention(id) {
  return `<@${id}>`;
}

function isHoster(message) {
  return message.member?.roles?.cache?.has(HOSTER_ROLE) === true;
}

function noMentions(content) {
  return {
    content,
    allowedMentions: {
      parse: [],
    },
  };
}

function lock(channelId, fn) {
  const previous = locks.get(channelId) || Promise.resolve();

  const next = previous
    .catch(() => {})
    .then(fn)
    .finally(() => {
      if (locks.get(channelId) === next) {
        locks.delete(channelId);
      }
    });

  locks.set(channelId, next);
  return next;
}

async function getMember(guild, id) {
  try {
    return await guild.members.fetch(id);
  } catch {
    return null;
  }
}

async function sendLog(text) {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL);

    if (channel?.isTextBased()) {
      await channel.send(noMentions(text));
    }
  } catch (error) {
    console.error("❌ Log error:", error?.message || error);
  }
}

// ============================================================
// FRIENDLY MESSAGE
// ============================================================

function needAddText(state) {
  if (!state.needs.length) {
    return "None";
  }

  return state.needs
    .map(
      (entry) =>
        `• **${entry.discordName}** → Roblox: **${entry.roblox}**`
    )
    .join("\n");
}

function buildFriendlyButtons(state) {
  const rows = [];

  const firstRow = new ActionRowBuilder().addComponents(
    ...POSITIONS.slice(0, 4).map(([key, label, customId]) => {
      const taken = Boolean(state.lineup[key]);

      return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(taken ? `${label} ✓` : label)
        .setStyle(taken ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(taken || complete(state.lineup));
    })
  );

  const secondRow = new ActionRowBuilder().addComponents(
    ...POSITIONS.slice(4).map(([key, label, customId]) => {
      const taken = Boolean(state.lineup[key]);

      return new ButtonBuilder()
        .setCustomId(customId)
        .setLabel(taken ? `${label} ✓` : label)
        .setStyle(taken ? ButtonStyle.Success : ButtonStyle.Primary)
        .setDisabled(taken || complete(state.lineup));
    })
  );

  const thirdRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(NEED_ADD)
      .setLabel("➕ Need Add")
      .setStyle(ButtonStyle.Secondary)
  );

  rows.push(firstRow);
  rows.push(secondRow);
  rows.push(thirdRow);

  return rows;
}

function friendlyText(state) {
  let text =
    `## ⚽ 7v7 Erts United Friendly\n\n` +
    `${complete(state.lineup) ? "**FINAL LINEUP**\n\n" : ""}`;

  for (const [key, label] of POSITIONS) {
    if (state.lineup[key]) {
      // REAL Discord mention
      text += `${label}: ${mention(state.lineup[key])}\n`;
    } else {
      text += `${label}: **OPEN**\n`;
    }
  }

  text +=
    `\n**➕ NEED ADDED**\n` +
    `${needAddText(state)}\n`;

  if (complete(state.lineup)) {
    text += `\n✅ **7/7 spots filled.**`;
  } else {
    text += `\n**${filled(state.lineup)}/7 spots filled.**`;
  }

  text +=
    `\n\nClick your position to claim it. Need added? Click **➕ Need Add**.`;

  return text;
}

function finalText(state) {
  let text =
    `## ⚽ 7v7 Erts United Friendly\n\n` +
    `**FINAL LINEUP**\n\n`;

  for (const [key, label] of POSITIONS) {
    text += `${label}: ${mention(state.lineup[key])}\n`;
  }

  text +=
    `\n**➕ NEED ADDED**\n` +
    `${needAddText(state)}\n\n` +
    `✅ **7/7 spots filled.**\n\n` +
    `Need added? Click **➕ Need Add**.`;

  return text;
}

async function createFriendly(channel) {
  const state = {
    channelId: channel.id,
    guildId: channel.guild.id,
    message: null,
    messageId: null,
    lineup: emptyLineup(),
    needs: [],
    createdBy: null,
  };

  // THIS IS THE ONLY MESSAGE CREATED BY !hostfriendly
  const message = await channel.send({
    content:
      "@here\n\n" +
      "## ⚽ 7v7 Erts United Friendly\n\n" +
      "**7 spots. Click your position below.**\n\n" +
      "GK: **OPEN**\n" +
      "CB: **OPEN**\n" +
      "CB2: **OPEN**\n" +
      "CM: **OPEN**\n" +
      "LW: **OPEN**\n" +
      "RW: **OPEN**\n\n" +
      "ST: **OPEN**\n\n" +
      "**➕ NEED ADDED**\n" +
      "None\n\n" +
      "**0/7 spots filled.**\n\n" +
      "Click your position to claim it. Need added? Click **➕ Need Add**.",
    components: buildFriendlyButtons(state),
    allowedMentions: {
      parse: ["everyone"],
    },
  });

  state.message = message;
  state.messageId = message.id;

  return state;
}

// ============================================================
// ROBLOX
// ============================================================

function validRobloxUsername(username) {
  return /^[A-Za-z0-9_]{3,20}$/.test(username);
}

async function lookupRoblox(username) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, 8000);

  try {
    const response = await fetch(
      "https://users.roblox.com/v1/usernames/users",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          usernames: [username],
          excludeBannedUsers: false,
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      throw new Error(`Roblox API HTTP ${response.status}`);
    }

    const data = await response.json();
    const user = data?.data?.[0];

    if (!user?.id || !user?.name) {
      return null;
    }

    return {
      id: String(user.id),
      name: user.name,
    };
  } finally {
    clearTimeout(timer);
  }
}

function removePendingForChannel(channelId) {
  for (const [userId, data] of pendingDMs.entries()) {
    if (data.channelId === channelId) {
      pendingDMs.delete(userId);
    }
  }
}

// ============================================================
// FRIENDLY BUTTON INTERACTIONS
// ============================================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) {
    return;
  }

  if (interaction.guildId !== GUILD_ID) {
    return;
  }

  const state = friendlies.get(interaction.channelId);

  if (!state || state.messageId !== interaction.message.id) {
    await interaction
      .reply({
        content: "❌ This friendly is no longer active.",
        ephemeral: true,
      })
      .catch(() => {});

    return;
  }

  // ==========================================================
  // NEED ADD
  // ==========================================================

  if (interaction.customId === NEED_ADD) {
    // Immediately acknowledge the button.
    await interaction.deferUpdate().catch(() => {});

    await lock(state.channelId, async () => {
      pendingDMs.set(interaction.user.id, {
        channelId: state.channelId,
        guildId: state.guildId,
        messageId: state.messageId,
        expires: Date.now() + DM_TIMEOUT,
      });

      try {
        await interaction.user.send(
          "⚽ **erts United Friendly**\n\n" +
          "What's ur Roblox username?\n\n" +
          "Reply to this DM with your Roblox username. You have 10 minutes."
        );
      } catch (error) {
        pendingDMs.delete(interaction.user.id);

        console.error(
          "❌ Need Add DM error:",
          error?.message || error
        );

        await interaction
          .followUp({
            content:
              "❌ I couldn't DM you. Turn on DMs from server members and click **➕ Need Add** again.",
            ephemeral: true,
          })
          .catch(() => {});
      }
    });

    return;
  }

  // ==========================================================
  // POSITION BUTTON
  // ==========================================================

  const position = POSITIONS.find(
    (entry) => entry[2] === interaction.customId
  );

  if (!position) {
    return;
  }

  // Acknowledge immediately so the button doesn't timeout.
  await interaction.deferUpdate().catch(() => {});

  await lock(state.channelId, async () => {
    const userId = interaction.user.id;
    const positionKey = position[0];
    const positionLabel = position[1];

    // Someone already took this spot.
    if (state.lineup[positionKey]) {
      return;
    }

    // A player can only have one position.
    if (Object.values(state.lineup).includes(userId)) {
      return;
    }

    // Claim the spot.
    state.lineup[positionKey] = userId;

    // Remove them from Need Add if they were there.
    state.needs = state.needs.filter(
      (entry) => entry.discordId !== userId
    );

    const isComplete = complete(state.lineup);

    if (isComplete) {
      completed.set(state.channelId, state);
    }

    // ========================================================
    // THIS IS THE IMPORTANT PART
    // It edits the SAME original message.
    // ========================================================

    await interaction.editReply({
      content: isComplete
        ? finalText(state)
        : friendlyText(state),

      components: buildFriendlyButtons(state),

      // Only the newly added player is pinged on this edit.
      allowedMentions: {
        users: [userId],
      },
    });

    await sendLog(
      `👤 ${interaction.user.tag} claimed ${positionLabel} in <#${state.channelId}>.`
    );

    if (isComplete) {
      await sendLog(
        `✅ 7/7 friendly completed in <#${state.channelId}>.`
      );
    }
  }).catch((error) => {
    console.error(
      "❌ Friendly button error:",
      error
    );
  });
});

// ============================================================
// ROBLOX DM RESPONSE
// ============================================================

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) {
      return;
    }

    // Only process DMs here.
    if (message.guildId) {
      return;
    }

    const pending = pendingDMs.get(message.author.id);

    if (!pending) {
      return;
    }

    if (pending.expires <= Date.now()) {
      pendingDMs.delete(message.author.id);

      await message.reply(
        "❌ That request expired. Go back to the friendly and click **➕ Need Add** again."
      );

      return;
    }

    const username = message.content.trim();

    if (!validRobloxUsername(username)) {
      await message.reply(
        "❌ Send only your Roblox username. Use 3-20 letters, numbers, or underscores."
      );

      return;
    }

    const state = friendlies.get(pending.channelId);

    if (!state || state.messageId !== pending.messageId) {
      pendingDMs.delete(message.author.id);

      await message.reply(
        "❌ That friendly is no longer active."
      );

      return;
    }

    await lock(state.channelId, async () => {
      let roblox;

      try {
        roblox = await lookupRoblox(username);
      } catch (error) {
        console.error(
          "❌ Roblox lookup error:",
          error?.message || error
        );

        await message.reply(
          "❌ Roblox couldn't be checked right now. Send your username again in a moment."
        );

        return;
      }

      if (!roblox) {
        await message.reply(
          "❌ I couldn't find that Roblox username. Check the spelling and send it again."
        );

        return;
      }

      const guild = await client.guilds.fetch(
        pending.guildId
      );

      const member = await getMember(
        guild,
        message.author.id
      );

      const discordName =
        member?.displayName ||
        message.author.globalName ||
        message.author.username;

      const entry = {
        discordId: message.author.id,
        discordName,
        roblox: roblox.name,
      };

      const existing = state.needs.findIndex(
        (x) => x.discordId === message.author.id
      );

      if (existing >= 0) {
        state.needs[existing] = entry;
      } else {
        state.needs.push(entry);
      }

      pendingDMs.delete(message.author.id);

      // EDIT THE SAME FRIENDLY MESSAGE AGAIN
      await state.message.edit({
        content: complete(state.lineup)
          ? finalText(state)
          : friendlyText(state),

        components: buildFriendlyButtons(state),

        allowedMentions: {
          users: [],
        },
      });

      await message.reply(
        `✅ Got it. Roblox username **${roblox.name}** is now on the friendly's **NEED ADDED** list.`
      );
    });
  } catch (error) {
    console.error(
      "❌ Roblox DM handler error:",
      error
    );
  }
});

// ============================================================
// GENERAL HELPERS
// ============================================================

async function deleteMessage(message) {
  try {
    if (message.deletable) {
      await message.delete();
    }
  } catch (error) {
    console.error(
      "❌ Delete error:",
      error?.message || error
    );
  }
}

function extractRoleText(message, role) {
  const roleTag = `<@&${role.id}>`;
  const index = message.content.indexOf(roleTag);

  if (index === -1) {
    return "";
  }

  return message.content
    .slice(index + roleTag.length)
    .trim();
}

async function purge(channel) {
  if (!channel?.isTextBased()) {
    return;
  }

  const fourteenDays =
    14 * 24 * 60 * 60 * 1000;

  for (let batch = 0; batch < 50; batch++) {
    const messages =
      await channel.messages.fetch({
        limit: 100,
      });

    if (!messages.size) {
      break;
    }

    const recent = messages.filter(
      (message) =>
        message.deletable &&
        Date.now() - message.createdTimestamp <
          fourteenDays
    );

    const old = messages.filter(
      (message) =>
        message.deletable &&
        Date.now() - message.createdTimestamp >=
          fourteenDays
    );

    let deletedAnything = false;

    if (recent.size) {
      try {
        await channel.bulkDelete(
          recent,
          true
        );

        deletedAnything = true;
      } catch {
        for (const message of recent.values()) {
          try {
            await message.delete();
            deletedAnything = true;
          } catch {}
        }
      }
    }

    for (const message of old.values()) {
      try {
        await message.delete();
        deletedAnything = true;

        await new Promise((resolve) =>
          setTimeout(resolve, 250)
        );
      } catch {}
    }

    if (!deletedAnything) {
      break;
    }

    if (messages.size < 100) {
      break;
    }
  }
}

// ============================================================
// MUSIC
// ============================================================

const music = new Map();

function getMusic(guildId) {
  if (music.has(guildId)) {
    return music.get(guildId);
  }

  const player = createAudioPlayer({
    behaviors: {
      noSubscriber: NoSubscriberBehavior.Pause,
    },
  });

  const data = {
    queue: [],
    current: null,
    loop: false,
    player,
    connection: null,
    textChannel: null,
  };

  player.on(
    AudioPlayerStatus.Idle,
    async () => {
      const d = music.get(guildId);

      if (!d) {
        return;
      }

      if (d.loop && d.current) {
        try {
          await startTrack(
            guildId,
            d.current
          );
        } catch {
          d.current = null;
          await nextTrack(guildId);
        }
      } else {
        d.current = null;
        await nextTrack(guildId);
      }
    }
  );

  player.on(
    "error",
    async (error) => {
      console.error(
        "❌ Music error:",
        error
      );

      const d = music.get(guildId);

      if (d) {
        d.current = null;
        await nextTrack(guildId);
      }
    }
  );

  music.set(guildId, data);

  return data;
}

async function connectVC(channel) {
  if (
    !channel ||
    (
      channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildStageVoice
    )
  ) {
    throw new Error(
      "Invalid voice channel."
    );
  }

  const connection =
    joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator:
        channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

  await entersState(
    connection,
    VoiceConnectionStatus.Ready,
    15000
  );

  return connection;
}

async function findTrack(query) {
  if (
    play.yt_validate(query) ===
    "video"
  ) {
    const info =
      await play.video_info(
        query
      );

    const video =
      info.video_details;

    return {
      title:
        video.title ||
        "Unknown",
      url:
        video.url ||
        query,
    };
  }

  const results =
    await play.search(
      query,
      { limit: 1 }
    );

  if (!results.length) {
    throw new Error(
      "Song not found."
    );
  }

  return {
    title:
      results[0].title ||
      "Unknown",
    url: results[0].url,
  };
}

async function startTrack(
  guildId,
  track
) {
  const d = getMusic(guildId);

  if (!d.connection) {
    throw new Error(
      "Not connected to voice."
    );
  }

  const stream =
    await play.stream(
      track.url,
      {
        quality: 2,
        discordPlayerCompatibility:
          true,
      }
    );

  const resource =
    createAudioResource(
      stream.stream,
      {
        inputType:
          stream.type,
      }
    );

  d.current = track;

  d.player.play(resource);

  d.connection.subscribe(
    d.player
  );
}

async function nextTrack(guildId) {
  const d = music.get(guildId);

  if (!d) {
    return;
  }

  const track =
    d.queue.shift();

  if (!track) {
    d.current = null;
    return;
  }

  try {
    await startTrack(
      guildId,
      track
    );

    if (d.textChannel) {
      await d.textChannel.send(
        noMentions(
          `▶️ Now playing: **${track.title}**`
        )
      );
    }
  } catch (error) {
    console.error(
      "❌ Track error:",
      error
    );

    d.current = null;

    await nextTrack(
      guildId
    );
  }
}

// ============================================================
// PREFIX COMMANDS
// ============================================================

client.on(
  "messageCreate",
  async (message) => {
    try {
      if (
        message.author.bot ||
        message.guildId !== GUILD_ID ||
        !message.content.startsWith(PREFIX)
      ) {
        return;
      }

      const args =
        message.content
          .slice(PREFIX.length)
          .trim()
          .split(/\s+/)
          .filter(Boolean);

      const command =
        (args.shift() || "")
          .toLowerCase();

      if (!command) {
        return;
      }

      const reply = (content) =>
        message
          .reply(
            noMentions(content)
          )
          .catch(() => {});

      // ======================================================
      // HELP
      // ======================================================

      if (command === "help") {
        await reply(
          [
            "**erts United Bot**",
            "",
            "**Friendly**",
            "`!hostfriendly`",
            "`!host friendly`",
            "`!friendlylink`",
            "`!endfriendly`",
            "`!end friendly`",
            "`!result <opponent> <score> <win/draw/loss> [details]`",
            "",
            "**Utility**",
            "`!dmrole @role <message>`",
            "`!dmall <message>`",
            "`!joinvc`",
            "",
            "**Music**",
            "`!play <song>`",
            "`!skip`",
            "`!stop`",
            "`!loop`",
            "`!queue`",
            "",
            "Mention the bot for AI chat.",
          ].join("\n")
        );

        return;
      }

      // ======================================================
      // HOST FRIENDLY
      // ======================================================

      if (
        command === "hostfriendly" ||
        (
          command === "host" &&
          args[0]?.toLowerCase() ===
            "friendly"
        )
      ) {
        if (!isHoster(message)) {
          await reply(
            "❌ You need the Friendly Hoster role."
          );
          return;
        }

        if (
          !message.channel.isTextBased() ||
          !message.guild
        ) {
          return;
        }

        const old =
          friendlies.get(
            message.channel.id
          );

        if (old) {
          await deleteMessage(
            message
          );
          return;
        }

        try {
          const state =
            await createFriendly(
              message.channel
            );

          state.createdBy =
            message.author.id;

          friendlies.set(
            message.channel.id,
            state
          );

          // Delete !hostfriendly.
          // This leaves only ONE bot message.
          await deleteMessage(
            message
          );

          await sendLog(
            `📋 Friendly hosted by ${message.author.tag} in <#${message.channel.id}>.`
          );
        } catch (error) {
          console.error(
            "❌ !hostfriendly error:",
            error
          );

          await reply(
            "❌ I couldn't create the friendly. Check the bot's channel permissions and @here permission."
          );
        }

        return;
      }

      // ======================================================
      // FRIENDLY LINK
      // ======================================================

      if (command === "friendlylink") {
        if (!isHoster(message)) {
          await reply(
            "❌ You need the Friendly Hoster role."
          );
          return;
        }

        const state =
          friendlies.get(
            message.channel.id
          ) ||
          completed.get(
            message.channel.id
          );

        if (
          !state ||
          !complete(state.lineup)
        ) {
          await reply(
            "❌ The friendly isn't full yet."
          );
          return;
        }

        let sent = 0;
        let failed = 0;

        for (
          const id of Object.values(
            state.lineup
          )
        ) {
          try {
            const member =
              await message.guild.members.fetch(
                id
              );

            await member.send(
              `⚽ **erts United Friendly**\n\nYou're in the 7v7 lineup.\n\nJoin here: ${INVITE}`
            );

            sent++;
          } catch {
            failed++;
          }
        }

        await reply(
          `✅ Friendly link sent to **${sent}** player(s).\n❌ Failed: **${failed}**.`
        );

        return;
      }

      // ======================================================
      // END FRIENDLY
      // ======================================================

      if (
        command === "endfriendly" ||
        (
          command === "end" &&
          args[0]?.toLowerCase() ===
            "friendly"
        )
      ) {
        if (!isHoster(message)) {
          await reply(
            "❌ You need the Friendly Hoster role."
          );
          return;
        }

        friendlies.delete(
          message.channel.id
        );

        completed.delete(
          message.channel.id
        );

        removePendingForChannel(
          message.channel.id
        );

        await deleteMessage(
          message
        );

        await purge(
          message.channel
        );

        return;
      }

      // ======================================================
      // DM ROLE
      // ======================================================

      if (command === "dmrole") {
        if (!isHoster(message)) {
          await reply(
            "❌ You need the Friendly Hoster role."
          );
          return;
        }

        const role =
          message.mentions.roles.first();

        if (!role) {
          await reply(
            "Usage: `!dmrole @role your message here`"
          );
          return;
        }

        const text =
          extractRoleText(
            message,
            role
          );

        if (!text) {
          await reply(
            "❌ You need to provide a message."
          );
          return;
        }

        const members =
          await message.guild.members.fetch();

        let sent = 0;
        let failed = 0;

        for (
          const member of
          members.values()
        ) {
          if (
            member.user.bot
          ) {
            continue;
          }

          if (
            !member.roles.cache.has(
              role.id
            )
          ) {
            continue;
          }

          try {
            await member.send(
              text
            );

            sent++;
          } catch {
            failed++;
          }
        }

        await reply(
          `✅ Sent to **${sent}** member(s).\n❌ Failed: **${failed}**.`
        );

        return;
      }

      // ======================================================
      // DM ALL
      // ======================================================

      if (command === "dmall") {
        if (!isHoster(message)) {
          await reply(
            "❌ You need the Friendly Hoster role."
          );
          return;
        }

        const text =
          args.join(" ");

        if (!text) {
          await reply(
            "Usage: `!dmall your message here`"
          );
          return;
        }

        const members =
          await message.guild.members.fetch();

        let sent = 0;
        let failed = 0;

        for (
          const member of
          members.values()
        ) {
          if (
            member.user.bot
          ) {
            continue;
          }

          try {
            await member.send(
              text
            );

            sent++;
          } catch {
            failed++;
          }
        }

        await reply(
          `✅ Sent to **${sent}** member(s).\n❌ Failed: **${failed}**.`
        );

        return;
      }

      // ======================================================
      // JOIN VC
      // ======================================================

      if (command === "joinvc") {
        try {
          const channel =
            await client.channels.fetch(
              FIXED_VC
            );

          const connection =
            await connectVC(
              channel
            );

          const data =
            getMusic(
              message.guild.id
            );

          data.connection =
            connection;

          connection.subscribe(
            data.player
          );

          await reply(
            `🔊 Joined **${channel.name}**.`
          );
        } catch (error) {
          console.error(
            "❌ !joinvc error:",
            error
          );

          await reply(
            "❌ Couldn't join the fixed VC."
          );
        }

        return;
      }

      // ======================================================
      // RESULT
      // ======================================================

      if (command === "result") {
        if (!isHoster(message)) {
          await reply(
            "❌ You need the Friendly Hoster role."
          );
          return;
        }

        const opponent =
          args[0];

        const score =
          args[1];

        const outcome =
          args[2]?.toUpperCase();

        const details =
          args
            .slice(3)
            .join(" ");

        if (
          !opponent ||
          !score ||
          ![
            "WIN",
            "DRAW",
            "LOSS",
          ].includes(outcome)
        ) {
          await reply(
            "Usage: `!result <opponent> <score> <win/draw/loss> [details]`"
          );

          return;
        }

        const channel =
          await client.channels.fetch(
            RESULTS_CHANNEL
          );

        if (
          !channel?.isTextBased()
        ) {
          await reply(
            "❌ Results channel not found."
          );

          return;
        }

        const title =
          outcome === "WIN"
            ? "🏆 MATCH WIN"
            : outcome === "DRAW"
            ? "🤝 MATCH DRAW"
            : "❌ MATCH LOSS";

        const embed =
          new EmbedBuilder()
            .setTitle(title)
            .addFields(
              {
                name:
                  "Opponent",
                value:
                  opponent.slice(
                    0,
                    1024
                  ),
                inline:
                  true,
              },
              {
                name:
                  "Score",
                value:
                  score.slice(
                    0,
                    1024
                  ),
                inline:
                  true,
              }
            )
            .setTimestamp();

        if (details) {
          embed.addFields({
            name:
              "Details",
            value:
              details.slice(
                0,
                1024
              ),
          });
        }

        await channel.send({
          embeds: [
            embed,
          ],
        });

        await reply(
          `✅ Result posted in <#${RESULTS_CHANNEL}>.`
        );

        return;
      }

      // ======================================================
      // PLAY
      // ======================================================

      if (command === "play") {
        const query =
          args.join(" ");

        if (!query) {
          await reply(
            "Usage: `!play <song or YouTube URL>`"
          );
          return;
        }

        if (
          !message.member?.voice?.channel
        ) {
          await reply(
            "❌ You need to be in a voice channel."
          );
          return;
        }

        try {
          const data =
            getMusic(
              message.guild.id
            );

          if (
            !data.connection
          ) {
            data.connection =
              await connectVC(
                message.member.voice.channel
              );

            data.connection.subscribe(
              data.player
            );
          }

          data.textChannel =
            message.channel;

          const track =
            await findTrack(
              query
            );

          const playing =
            Boolean(
              data.current
            );

          data.queue.push(
            track
          );

          if (!playing) {
            await nextTrack(
              message.guild.id
            );

            await reply(
              `▶️ Playing **${track.title}**`
            );
          } else {
            await reply(
              `✅ Added **${track.title}** to the queue.`
            );
          }
        } catch (error) {
          console.error(
            "❌ !play error:",
            error
          );

          await reply(
            "❌ Couldn't play that track."
          );
        }

        return;
      }

      // ======================================================
      // SKIP
      // ======================================================

      if (command === "skip") {
        const data =
          music.get(
            message.guild.id
          );

        if (
          !data?.current
        ) {
          await reply(
            "❌ Nothing is playing."
          );
        } else {
          data.player.stop();

          await reply(
            "⏭️ Skipped."
          );
        }

        return;
      }

      // ======================================================
      // STOP
      // ======================================================

      if (command === "stop") {
        const data =
          music.get(
            message.guild.id
          );

        if (!data) {
          await reply(
            "❌ Nothing is playing."
          );
        } else {
          data.queue = [];
          data.current = null;
          data.loop = false;
          data.player.stop();

          await reply(
            "⏹️ Music stopped and queue cleared."
          );
        }

        return;
      }

      // ======================================================
      // LOOP
      // ======================================================

      if (command === "loop") {
        const data =
          getMusic(
            message.guild.id
          );

        data.loop =
          !data.loop;

        await reply(
          data.loop
            ? "🔁 Loop is now **ON**."
            : "➡️ Loop is now **OFF**."
        );

        return;
      }

      // ======================================================
      // QUEUE
      // ======================================================

      if (command === "queue") {
        const data =
          music.get(
            message.guild.id
          );

        if (
          !data ||
          (
            !data.current &&
            !data.queue.length
          )
        ) {
          await reply(
            "📭 Queue is empty."
          );

          return;
        }

        let text =
          data.current
            ? `▶️ **Now Playing:** ${data.current.title}\n\n`
            : "";

        text +=
          data.queue.length
            ? data.queue
                .map(
                  (track, index) =>
                    `**${index + 1}.** ${track.title}`
                )
                .join("\n")
            : "No songs waiting.";

        await reply(
          text.slice(
            0,
            1900
          )
        );

        return;
      }
    } catch (error) {
      console.error(
        "❌ Command error:",
        error
      );
    }
  }
);

// ============================================================
// BOT AI MENTION
// ============================================================

client.on(
  "messageCreate",
  async (message) => {
    try {
      if (
        message.author.bot ||
        message.guildId !== GUILD_ID ||
        !client.user ||
        !message.mentions.has(
          client.user.id
        )
      ) {
        return;
      }

      if (
        message.content
          .trim()
          .startsWith(PREFIX)
      ) {
        return;
      }

      const prompt =
        message.content
          .replace(
            new RegExp(
              `<@!?${client.user.id}>`,
              "g"
            ),
            ""
          )
          .trim();

      if (!prompt) {
        await message.reply(
          noMentions(
            "Yo, what do you need?"
          )
        );

        return;
      }

      if (!openai) {
        await message.reply(
          noMentions(
            "❌ AI isn't configured. Add OPENAI_API_KEY in Render."
          )
        );

        return;
      }

      await message.channel.sendTyping();

      try {
        const response =
          await openai.responses.create(
            {
              model:
                OPENAI_MODEL,

              instructions:
                "You are the erts United Discord server assistant. Be casual, helpful, concise, and friendly.",

              input:
                prompt,

              max_output_tokens:
                500,
            }
          );

        const answer =
          response.output_text?.trim();

        await message.reply(
          noMentions(
            answer
              ? answer.slice(
                  0,
                  1900
                )
              : "❌ I didn't get a response."
          )
        );
      } catch (error) {
        console.error(
          "❌ OpenAI error:",
          error
        );

        await message.reply(
          noMentions(
            "❌ AI error. Check OPENAI_API_KEY and OPENAI_MODEL in Render."
          )
        );
      }
    } catch (error) {
      console.error(
        "❌ AI handler error:",
        error
      );
    }
  }
);

// ============================================================
// STARTUP
// ============================================================

client.once(
  "ready",
  async () => {
    console.log(
      "===================================="
    );

    console.log(
      `🤖 ${client.user.tag}`
    );

    console.log(
      `🆔 ${client.user.id}`
    );

    console.log(
      `🎯 Guild: ${GUILD_ID}`
    );

    console.log(
      `👤 Hoster role: ${HOSTER_ROLE}`
    );

    console.log(
      "🚫 Slash commands disabled"
    );

    console.log(
      "⌨️ Prefix: !"
    );

    console.log(
      "===================================="
    );

    try {
      const guild =
        await client.guilds.fetch(
          GUILD_ID
        );

      const botMember =
        await guild.members.fetch(
          client.user.id
        );

      console.log(
        `✅ Connected to ${guild.name}`
      );

      console.log(
        `✅ Hoster role ${
          guild.roles.cache.has(
            HOSTER_ROLE
          )
            ? "found"
            : "NOT FOUND"
        }`
      );

      const results =
        await client.channels.fetch(
          RESULTS_CHANNEL
        );

      console.log(
        `✅ Results channel ${
          results
            ? "found"
            : "NOT FOUND"
        }`
      );

      const vc =
        await client.channels.fetch(
          FIXED_VC
        );

      if (
        vc &&
        (
          vc.type ===
            ChannelType.GuildVoice ||
          vc.type ===
            ChannelType.GuildStageVoice
        )
      ) {
        const permissions =
          vc.permissionsFor(
            botMember
          );

        if (
          permissions &&
          !permissions.has(
            PermissionsBitField.Flags.Connect
          )
        ) {
          console.warn(
            "⚠️ Missing Connect permission in fixed VC."
          );
        }

        try {
          const connection =
            await connectVC(
              vc
            );

          const data =
            getMusic(
              GUILD_ID
            );

          data.connection =
            connection;

          connection.subscribe(
            data.player
          );

          console.log(
            `🔊 Joined ${vc.name}`
          );
        } catch (error) {
          console.warn(
            "⚠️ Auto VC join failed:",
            error?.message ||
              error
          );
        }
      }
    } catch (error) {
      console.error(
        "❌ Target guild check failed:",
        error?.message ||
          error
      );
    }

    console.log(
      "✅ PREFIX BOT READY."
    );

    console.log(
      "✅ Friendly buttons are active."
    );
  }
);

// ============================================================
// CLEANUP
// ============================================================

setInterval(() => {
  const now =
    Date.now();

  for (
    const [
      userId,
      request,
    ] of pendingDMs
  ) {
    if (
      request.expires <=
      now
    ) {
      pendingDMs.delete(
        userId
      );
    }
  }
}, 60_000).unref();

client.on(
  "error",
  (error) => {
    console.error(
      "❌ Discord client error:",
      error
    );
  }
);

process.on(
  "unhandledRejection",
  (error) => {
    console.error(
      "❌ Unhandled rejection:",
      error
    );
  }
);

process.on(
  "uncaughtException",
  (error) => {
    console.error(
      "❌ Uncaught exception:",
      error
    );
  }
);

console.log(
  "🚀 Starting erts United Bot..."
);

client.login(TOKEN).catch(
  (error) => {
    console.error(
      "❌ Discord login failed:",
      error
    );

    process.exit(1);
  }
);