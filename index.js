import "dotenv/config";
import express from "express";
import {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} from "discord.js";

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
} from "@discordjs/voice";

import play from "play-dl";
import OpenAI from "openai";

// ============================================================
// CONFIG
// ============================================================

const TOKEN =
  process.env.TOKEN ||
  process.env.DISCORD_TOKEN;

const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || "";

const OPENAI_MODEL =
  process.env.OPENAI_MODEL ||
  "gpt-5-mini";

const PREFIX = "!";

// YOUR ERts UNITED SERVER
const GUILD_ID = "1540116395558313995";

const FRIENDLY_HOSTER_ROLE_ID =
  "1541193960041615361";

const RESULTS_CHANNEL_ID =
  "1540136949908770827";

const LOG_CHANNEL_ID =
  "1362214241091981452";

const FIXED_VC_ID =
  "1368359914145058956";

const INVITE_LINK =
  process.env.INVITE_LINK ||
  "https://discord.gg/ZrNuUKJFfS";

const PORT =
  Number(process.env.PORT) ||
  10000;

// ============================================================
// CHECK TOKEN
// ============================================================

if (!TOKEN) {
  console.error("❌ TOKEN is missing.");
  process.exit(1);
}

// ============================================================
// WEB SERVER FOR RENDER
// ============================================================

const app = express();

app.get("/", (_req, res) => {
  res.status(200).send(
    "erts United Bot is online."
  );
});

app.get("/health", (_req, res) => {
  res.json({
    status: "online",
    bot: client.user?.tag || null,
    guild: GUILD_ID,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🌐 Web server running on port ${PORT}`
  );
});

// ============================================================
// DISCORD CLIENT
// ============================================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages,
  ],

  partials: [
    Partials.Channel,
  ],
});

const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
    })
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

const NEED_ADD_BUTTON =
  "friendly_need_add";

const activeFriendlies =
  new Map();

const completedFriendlies =
  new Map();

const pendingRobloxDMs =
  new Map();

const friendlyLocks =
  new Map();

const ROBLOX_DM_TIMEOUT =
  10 * 60 * 1000;

// ============================================================
// MUSIC
// ============================================================

const musicQueues =
  new Map();

// ============================================================
// GENERAL HELPERS
// ============================================================

function isCorrectGuild(message) {
  return (
    message.guildId ===
    GUILD_ID
  );
}

function isFriendlyHoster(message) {
  return Boolean(
    message.member?.roles?.cache?.has(
      FRIENDLY_HOSTER_ROLE_ID
    )
  );
}

function mentionUser(userId) {
  return `<@${userId}>`;
}

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

function lineupCount(lineup) {
  return Object.values(
    lineup
  ).filter(Boolean).length;
}

function lineupComplete(lineup) {
  return (
    lineupCount(lineup) === 7
  );
}

function safeReply(message, content) {
  return message
    .reply({
      content,
      allowedMentions: {
        parse: [],
      },
    })
    .catch(() => {});
}

async function deleteMessage(message) {
  try {
    if (message.deletable) {
      await message.delete();
    }
  } catch (error) {
    console.log(
      "⚠️ Could not delete message:",
      error.message
    );
  }
}

async function sendLog(text) {
  try {
    const channel =
      await client.channels.fetch(
        LOG_CHANNEL_ID
      );

    if (channel?.isTextBased()) {
      await channel.send({
        content: text,
        allowedMentions: {
          parse: [],
        },
      });
    }
  } catch (error) {
    console.log(
      "⚠️ Log error:",
      error.message
    );
  }
}

// ============================================================
// FRIENDLY LOCK
// ============================================================

async function withFriendlyLock(
  channelId,
  callback
) {
  const previous =
    friendlyLocks.get(
      channelId
    ) || Promise.resolve();

  const current =
    previous
      .catch(() => {})
      .then(callback);

  friendlyLocks.set(
    channelId,
    current
  );

  try {
    return await current;
  } finally {
    if (
      friendlyLocks.get(
        channelId
      ) === current
    ) {
      friendlyLocks.delete(
        channelId
      );
    }
  }
}

// ============================================================
// FRIENDLY DISPLAY
// ============================================================

function getNeedAddText(state) {
  if (!state.needs.length) {
    return "None";
  }

  return state.needs
    .map(
      (player) =>
        `• **${player.discordName}** → Roblox: **${player.roblox}**`
    )
    .join("\n");
}

function makeButtons(state) {
  const row1 =
    new ActionRowBuilder();

  const row2 =
    new ActionRowBuilder();

  const row3 =
    new ActionRowBuilder();

  POSITIONS
    .slice(0, 4)
    .forEach(
      ([key, label, customId]) => {
        const taken =
          Boolean(
            state.lineup[key]
          );

        row1.addComponents(
          new ButtonBuilder()
            .setCustomId(
              customId
            )
            .setLabel(
              taken
                ? `${label} ✓`
                : label
            )
            .setStyle(
              taken
                ? ButtonStyle.Success
                : ButtonStyle.Primary
            )
            .setDisabled(
              taken ||
                lineupComplete(
                  state.lineup
                )
            )
        );
      }
    );

  POSITIONS
    .slice(4)
    .forEach(
      ([key, label, customId]) => {
        const taken =
          Boolean(
            state.lineup[key]
          );

        row2.addComponents(
          new ButtonBuilder()
            .setCustomId(
              customId
            )
            .setLabel(
              taken
                ? `${label} ✓`
                : label
            )
            .setStyle(
              taken
                ? ButtonStyle.Success
                : ButtonStyle.Primary
            )
            .setDisabled(
              taken ||
                lineupComplete(
                  state.lineup
                )
            )
        );
      }
    );

  row3.addComponents(
    new ButtonBuilder()
      .setCustomId(
        NEED_ADD_BUTTON
      )
      .setLabel(
        "➕ Need Add"
      )
      .setStyle(
        ButtonStyle.Secondary
      )
  );

  return [
    row1,
    row2,
    row3,
  ];
}

function buildFriendlyMessage(
  state
) {
  let text =
    "## ⚽ 7v7 Erts United Friendly\n\n";

  if (
    lineupComplete(
      state.lineup
    )
  ) {
    text +=
      "**FINAL LINEUP**\n\n";
  }

  for (
    const [
      key,
      label,
    ] of POSITIONS
  ) {
    if (
      state.lineup[key]
    ) {
      text +=
        `${label}: ${mentionUser(
          state.lineup[key]
        )}\n`;
    } else {
      text +=
        `${label}: **OPEN**\n`;
    }
  }

  text +=
    `\n**➕ NEED ADDED**\n`;

  text +=
    getNeedAddText(
      state
    );

  text +=
    `\n\n**${lineupCount(
      state.lineup
    )}/7 spots filled.**`;

  if (
    lineupComplete(
      state.lineup
    )
  ) {
    text +=
      "\n\n✅ **7/7 spots filled.**";
  }

  text +=
    "\n\nClick your position to claim it. Need added? Click **➕ Need Add**.";

  return text;
}

// ============================================================
// CREATE FRIENDLY
// ============================================================

async function createFriendly(
  channel
) {
  const state = {
    channelId:
      channel.id,

    guildId:
      channel.guild.id,

    message:
      null,

    messageId:
      null,

    lineup:
      emptyLineup(),

    needs:
      [],

    createdBy:
      null,
  };

  // ONLY ONE BOT MESSAGE
  const message =
    await channel.send({
      content:
        "@here\n\n" +
        buildFriendlyMessage(
          state
        ),

      components:
        makeButtons(
          state
        ),

      allowedMentions: {
        parse: [
          "everyone",
        ],
      },
    });

  state.message =
    message;

  state.messageId =
    message.id;

  return state;
}

// ============================================================
// ROBLOX USERNAME LOOKUP
// ============================================================

function validRobloxUsername(
  username
) {
  return /^[A-Za-z0-9_]{3,20}$/.test(
    username
  );
}

async function lookupRobloxUser(
  username
) {
  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () =>
        controller.abort(),
      8000
    );

  try {
    const response =
      await fetch(
        "https://users.roblox.com/v1/usernames/users",
        {
          method:
            "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify({
              usernames: [
                username,
              ],
              excludeBannedUsers:
                false,
            }),

          signal:
            controller.signal,
        }
      );

    if (
      !response.ok
    ) {
      throw new Error(
        `Roblox API returned ${response.status}`
      );
    }

    const data =
      await response.json();

    const user =
      data?.data?.[0];

    if (
      !user?.id ||
      !user?.name
    ) {
      return null;
    }

    return {
      id: String(
        user.id
      ),
      name:
        user.name,
    };
  } finally {
    clearTimeout(
      timeout
    );
  }
}

// ============================================================
// REMOVE PENDING ROBLOX REQUESTS
// ============================================================

function clearPendingDMs(
  channelId
) {
  for (
    const [
      userId,
      data,
    ] of pendingRobloxDMs
  ) {
    if (
      data.channelId ===
      channelId
    ) {
      pendingRobloxDMs.delete(
        userId
      );
    }
  }
}

// ============================================================
// BUTTONS
// ============================================================

client.on(
  "interactionCreate",
  async (
    interaction
  ) => {
    try {
      if (
        !interaction.isButton()
      ) {
        return;
      }

      if (
        interaction.guildId !==
        GUILD_ID
      ) {
        await interaction
          .reply({
            content:
              "❌ This bot only works in the erts United server.",
            ephemeral:
              true,
          })
          .catch(() => {});

        return;
      }

      const state =
        activeFriendlies.get(
          interaction.channelId
        );

      if (
        !state ||
        state.messageId !==
          interaction.message.id
      ) {
        await interaction
          .reply({
            content:
              "❌ This friendly is no longer active.",
            ephemeral:
              true,
          })
          .catch(() => {});

        return;
      }

      // ======================================================
      // NEED ADD
      // ======================================================

      if (
        interaction.customId ===
        NEED_ADD_BUTTON
      ) {
        await interaction
          .deferUpdate()
          .catch(() => {});

        pendingRobloxDMs.set(
          interaction.user.id,
          {
            channelId:
              state.channelId,

            guildId:
              state.guildId,

            messageId:
              state.messageId,

            expires:
              Date.now() +
              ROBLOX_DM_TIMEOUT,
          }
        );

        try {
          await interaction.user.send(
            "⚽ **erts United Friendly**\n\n" +
              "What's ur Roblox username?\n\n" +
              "Reply to this DM with your Roblox username. You have 10 minutes."
          );
        } catch (error) {
          pendingRobloxDMs.delete(
            interaction.user.id
          );

          await interaction
            .followUp({
              content:
                "❌ I couldn't DM you. Turn on DMs from server members and click **➕ Need Add** again.",
              ephemeral:
                true,
            })
            .catch(() => {});
        }

        return;
      }

      // ======================================================
      // POSITION
      // ======================================================

      const position =
        POSITIONS.find(
          (entry) =>
            entry[2] ===
            interaction.customId
        );

      if (!position) {
        return;
      }

      await interaction
        .deferUpdate()
        .catch(() => {});

      await withFriendlyLock(
        state.channelId,
        async () => {
          const [
            positionKey,
            positionLabel,
          ] = position;

          const userId =
            interaction.user.id;

          // Already taken
          if (
            state.lineup[
              positionKey
            ]
          ) {
            return;
          }

          // Player already has another position
          if (
            Object.values(
              state.lineup
            ).includes(
              userId
            )
          ) {
            return;
          }

          // Claim position
          state.lineup[
            positionKey
          ] = userId;

          // Remove from need-added list
          state.needs =
            state.needs.filter(
              (player) =>
                player.discordId !==
                userId
            );

          const finished =
            lineupComplete(
              state.lineup
            );

          if (finished) {
            completedFriendlies.set(
              state.channelId,
              state
            );
          }

          // ==================================================
          // EDIT THE ORIGINAL MESSAGE
          // ==================================================

          await interaction.editReply(
            {
              content:
                buildFriendlyMessage(
                  state
                ),

              components:
                makeButtons(
                  state
                ),

              allowedMentions: {
                users: [
                  userId,
                ],
              },
            }
          );

          await sendLog(
            `👤 ${interaction.user.tag} claimed ${positionLabel} in <#${state.channelId}>.`
          );

          if (finished) {
            await sendLog(
              `✅ 7/7 friendly completed in <#${state.channelId}>.`
            );
          }
        }
      );
    } catch (error) {
      console.error(
        "❌ Button error:",
        error
      );
    }
  }
);

// ============================================================
// ROBLOX DM HANDLER
// ============================================================

client.on(
  "messageCreate",
  async (
    message
  ) => {
    try {
      if (
        message.author.bot
      ) {
        return;
      }

      // Only DMs
      if (
        message.guildId
      ) {
        return;
      }

      const pending =
        pendingRobloxDMs.get(
          message.author.id
        );

      if (!pending) {
        return;
      }

      if (
        pending.expires <=
        Date.now()
      ) {
        pendingRobloxDMs.delete(
          message.author.id
        );

        await message.reply(
          "❌ That request expired. Click **➕ Need Add** again."
        );

        return;
      }

      const username =
        message.content.trim();

      if (
        !validRobloxUsername(
          username
        )
      ) {
        await message.reply(
          "❌ That doesn't look like a valid Roblox username. Send only your Roblox username."
        );

        return;
      }

      const state =
        activeFriendlies.get(
          pending.channelId
        );

      if (
        !state ||
        state.messageId !==
          pending.messageId
      ) {
        pendingRobloxDMs.delete(
          message.author.id
        );

        await message.reply(
          "❌ That friendly is no longer active."
        );

        return;
      }

      await withFriendlyLock(
        state.channelId,
        async () => {
          let robloxUser;

          try {
            robloxUser =
              await lookupRobloxUser(
                username
              );
          } catch (error) {
            console.error(
              "❌ Roblox lookup error:",
              error
            );

            await message.reply(
              "❌ Roblox couldn't be checked right now. Try sending your username again."
            );

            return;
          }

          if (
            !robloxUser
          ) {
            await message.reply(
              "❌ I couldn't find that Roblox username. Check the spelling and send it again."
            );

            return;
          }

          const guild =
            await client.guilds.fetch(
              GUILD_ID
            );

          let member =
            null;

          try {
            member =
              await guild.members.fetch(
                message.author.id
              );
          } catch {}

          const discordName =
            member?.displayName ||
            message.author.globalName ||
            message.author.username;

          const entry = {
            discordId:
              message.author.id,

            discordName:
              discordName,

            roblox:
              robloxUser.name,
          };

          const existing =
            state.needs.findIndex(
              (player) =>
                player.discordId ===
                message.author.id
            );

          if (
            existing >= 0
          ) {
            state.needs[
              existing
            ] = entry;
          } else {
            state.needs.push(
              entry
            );
          }

          pendingRobloxDMs.delete(
            message.author.id
          );

          // EDIT THE SAME FRIENDLY MESSAGE
          await state.message.edit(
            {
              content:
                buildFriendlyMessage(
                  state
                ),

              components:
                makeButtons(
                  state
                ),

              allowedMentions: {
                parse: [],
              },
            }
          );

          await message.reply(
            `✅ Added **${robloxUser.name}** to the friendly's **NEED ADDED** list.`
          );
        }
      );
    } catch (error) {
      console.error(
        "❌ DM handler error:",
        error
      );
    }
  }
);

// ============================================================
// MUSIC
// ============================================================

function getMusicData(
  guildId
) {
  if (
    musicQueues.has(
      guildId
    )
  ) {
    return musicQueues.get(
      guildId
    );
  }

  const player =
    createAudioPlayer({
      behaviors: {
        noSubscriber:
          NoSubscriberBehavior.Pause,
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
      const current =
        musicQueues.get(
          guildId
        );

      if (!current) {
        return;
      }

      if (
        current.loop &&
        current.current
      ) {
        try {
          await startMusicTrack(
            guildId,
            current.current
          );
        } catch {
          current.current =
            null;

          await playNextTrack(
            guildId
          );
        }

        return;
      }

      current.current =
        null;

      await playNextTrack(
        guildId
      );
    }
  );

  player.on(
    "error",
    async (error) => {
      console.error(
        "❌ Music error:",
        error
      );

      const current =
        musicQueues.get(
          guildId
        );

      if (!current) {
        return;
      }

      current.current =
        null;

      await playNextTrack(
        guildId
      );
    }
  );

  musicQueues.set(
    guildId,
    data
  );

  return data;
}

async function connectToVoice(
  channel
) {
  if (
    !channel ||
    (
      channel.type !==
        ChannelType.GuildVoice &&
      channel.type !==
        ChannelType.GuildStageVoice
    )
  ) {
    throw new Error(
      "Invalid voice channel."
    );
  }

  const connection =
    joinVoiceChannel({
      channelId:
        channel.id,

      guildId:
        channel.guild.id,

      adapterCreator:
        channel.guild
          .voiceAdapterCreator,

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

async function getTrack(
  query
) {
  const validation =
    play.yt_validate(
      query
    );

  if (
    validation ===
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
      {
        limit: 1,
      }
    );

  if (
    !results.length
  ) {
    throw new Error(
      "Song not found."
    );
  }

  return {
    title:
      results[0].title ||
      "Unknown",

    url:
      results[0].url,
  };
}

async function startMusicTrack(
  guildId,
  track
) {
  const data =
    getMusicData(
      guildId
    );

  if (
    !data.connection
  ) {
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

  data.current =
    track;

  data.player.play(
    resource
  );

  data.connection.subscribe(
    data.player
  );
}

async function playNextTrack(
  guildId
) {
  const data =
    musicQueues.get(
      guildId
    );

  if (!data) {
    return;
  }

  const track =
    data.queue.shift();

  if (!track) {
    data.current =
      null;

    return;
  }

  try {
    await startMusicTrack(
      guildId,
      track
    );

    if (
      data.textChannel
    ) {
      await data.textChannel.send({
        content:
          `▶️ Now playing: **${track.title}**`,
        allowedMentions: {
          parse: [],
        },
      });
    }
  } catch (error) {
    console.error(
      "❌ Track error:",
      error
    );

    data.current =
      null;

    await playNextTrack(
      guildId
    );
  }
}

// ============================================================
// PURGE
// ============================================================

async function purgeChannel(
  channel
) {
  if (
    !channel?.isTextBased()
  ) {
    return;
  }

  for (
    let i = 0;
    i < 50;
    i++
  ) {
    const messages =
      await channel.messages.fetch({
        limit: 100,
      });

    if (
      !messages.size
    ) {
      break;
    }

    let deleted =
      false;

    for (
      const message of
      messages.values()
    ) {
      if (
        !message.deletable
      ) {
        continue;
      }

      try {
        await message.delete();
        deleted = true;

        await new Promise(
          (resolve) =>
            setTimeout(
              resolve,
              200
            )
        );
      } catch {}
    }

    if (!deleted) {
      break;
    }

    if (
      messages.size <
      100
    ) {
      break;
    }
  }
}

// ============================================================
// PREFIX COMMANDS
// ============================================================

client.on(
  "messageCreate",
  async (
    message
  ) => {
    try {
      if (
        message.author.bot
      ) {
        return;
      }

      // IMPORTANT:
      // Ignore all guilds except Erts United.
      if (
        message.guildId !==
        GUILD_ID
      ) {
        return;
      }

      // Ignore non-prefix messages.
      if (
        !message.content.startsWith(
          PREFIX
        )
      ) {
        return;
      }

      const args =
        message.content
          .slice(
            PREFIX.length
          )
          .trim()
          .split(/\s+/)
          .filter(Boolean);

      const command =
        (
          args.shift() ||
          ""
        ).toLowerCase();

      if (!command) {
        return;
      }

      // ======================================================
      // HELP
      // ======================================================

      if (
        command ===
        "help"
      ) {
        await safeReply(
          message,
          [
            "**erts United Bot Commands**",
            "",
            "**Friendly**",
            "`!hostfriendly`",
            "`!host friendly`",
            "`!friendlylink`",
            "`!endfriendly`",
            "`!end friendly`",
            "`!result <opponent> <score> <win/draw/loss>`",
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
          ].join("\n")
        );

        return;
      }

      // ======================================================
      // HOST FRIENDLY
      // ======================================================

      if (
        command ===
          "hostfriendly" ||
        (
          command ===
            "host" &&
          args[0]?.toLowerCase() ===
            "friendly"
        )
      ) {
        if (
          !isFriendlyHoster(
            message
          )
        ) {
          await safeReply(
            message,
            "❌ You need the Friendly Hoster role."
          );

          return;
        }

        if (
          activeFriendlies.has(
            message.channel.id
          )
        ) {
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

          activeFriendlies.set(
            message.channel.id,
            state
          );

          // Delete the command so the
          // bot leaves only ONE friendly message.
          await deleteMessage(
            message
          );

          await sendLog(
            `📋 Friendly started by ${message.author.tag} in <#${message.channel.id}>.`
          );
        } catch (error) {
          console.error(
            "❌ Host friendly error:",
            error
          );

          await safeReply(
            message,
            "❌ Couldn't create the friendly. Make sure the bot can send messages and use @here in this channel."
          );
        }

        return;
      }

      // ======================================================
      // FRIENDLY LINK
      // ======================================================

      if (
        command ===
        "friendlylink"
      ) {
        if (
          !isFriendlyHoster(
            message
          )
        ) {
          await safeReply(
            message,
            "❌ You need the Friendly Hoster role."
          );

          return;
        }

        const state =
          completedFriendlies.get(
            message.channel.id
          );

        if (
          !state ||
          !lineupComplete(
            state.lineup
          )
        ) {
          await safeReply(
            message,
            "❌ There isn't a completed friendly here."
          );

          return;
        }

        let sent = 0;
        let failed = 0;

        for (
          const userId of
          Object.values(
            state.lineup
          )
        ) {
          try {
            const member =
              await message.guild.members.fetch(
                userId
              );

            await member.send(
              `⚽ **erts United Friendly**\n\nYou're in the 7v7 lineup.\n\nJoin here: ${INVITE_LINK}`
            );

            sent++;
          } catch {
            failed++;
          }
        }

        await safeReply(
          message,
          `✅ Friendly link sent to **${sent}** players.\n❌ Failed: **${failed}**.`
        );

        return;
      }

      // ======================================================
      // END FRIENDLY
      // ======================================================

      if (
        command ===
          "endfriendly" ||
        (
          command ===
            "end" &&
          args[0]?.toLowerCase() ===
            "friendly"
        )
      ) {
        if (
          !isFriendlyHoster(
            message
          )
        ) {
          await safeReply(
            message,
            "❌ You need the Friendly Hoster role."
          );

          return;
        }

        activeFriendlies.delete(
          message.channel.id
        );

        completedFriendlies.delete(
          message.channel.id
        );

        clearPendingDMs(
          message.channel.id
        );

        await deleteMessage(
          message
        );

        await purgeChannel(
          message.channel
        );

        return;
      }

      // ======================================================
      // DM ROLE
      // ======================================================

      if (
        command ===
        "dmrole"
      ) {
        if (
          !isFriendlyHoster(
            message
          )
        ) {
          await safeReply(
            message,
            "❌ You need the Friendly Hoster role."
          );

          return;
        }

        const role =
          message.mentions.roles.first();

        if (!role) {
          await safeReply(
            message,
            "Usage: `!dmrole @role your message here`"
          );

          return;
        }

        const roleMention =
          `<@&${role.id}>`;

        const index =
          message.content.indexOf(
            roleMention
          );

        const text =
          index >= 0
            ? message.content
                .slice(
                  index +
                    roleMention.length
                )
                .trim()
            : "";

        if (!text) {
          await safeReply(
            message,
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

        await safeReply(
          message,
          `✅ Sent to **${sent}** member(s).\n❌ Failed: **${failed}**.`
        );

        return;
      }

      // ======================================================
      // DM ALL
      // ======================================================

      if (
        command ===
        "dmall"
      ) {
        if (
          !isFriendlyHoster(
            message
          )
        ) {
          await safeReply(
            message,
            "❌ You need the Friendly Hoster role."
          );

          return;
        }

        const text =
          args.join(" ");

        if (!text) {
          await safeReply(
            message,
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

        await safeReply(
          message,
          `✅ Sent to **${sent}** member(s).\n❌ Failed: **${failed}**.`
        );

        return;
      }

      // ======================================================
      // JOIN VC
      // ======================================================

      if (
        command ===
        "joinvc"
      ) {
        try {
          const channel =
            await client.channels.fetch(
              FIXED_VC_ID
            );

          const connection =
            await connectToVoice(
              channel
            );

          const data =
            getMusicData(
              message.guild.id
            );

          data.connection =
            connection;

          connection.subscribe(
            data.player
          );

          await safeReply(
            message,
            `🔊 Joined **${channel.name}**.`
          );
        } catch (error) {
          console.error(
            "❌ Join VC error:",
            error
          );

          await safeReply(
            message,
            "❌ Couldn't join the VC."
          );
        }

        return;
      }

      // ======================================================
      // RESULT
      // ======================================================

      if (
        command ===
        "result"
      ) {
        if (
          !isFriendlyHoster(
            message
          )
        ) {
          await safeReply(
            message,
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
          ].includes(
            outcome
          )
        ) {
          await safeReply(
            message,
            "Usage: `!result <opponent> <score> <win/draw/loss> [details]`"
          );

          return;
        }

        const channel =
          await client.channels.fetch(
            RESULTS_CHANNEL_ID
          );

        if (
          !channel?.isTextBased()
        ) {
          await safeReply(
            message,
            "❌ Results channel not found."
          );

          return;
        }

        const title =
          outcome ===
          "WIN"
            ? "🏆 MATCH WIN"
            : outcome ===
              "DRAW"
            ? "🤝 MATCH DRAW"
            : "❌ MATCH LOSS";

        const embed =
          new EmbedBuilder()
            .setTitle(
              title
            )
            .addFields(
              {
                name:
                  "Opponent",
                value:
                  opponent,
                inline:
                  true,
              },
              {
                name:
                  "Score",
                value:
                  score,
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

        await safeReply(
          message,
          `✅ Result posted in <#${RESULTS_CHANNEL_ID}>.`
        );

        return;
      }

      // ======================================================
      // PLAY
      // ======================================================

      if (
        command ===
        "play"
      ) {
        const query =
          args.join(" ");

        if (!query) {
          await safeReply(
            message,
            "Usage: `!play <song or YouTube URL>`"
          );

          return;
        }

        if (
          !message.member?.voice
            ?.channel
        ) {
          await safeReply(
            message,
            "❌ You need to be in a voice channel."
          );

          return;
        }

        try {
          const data =
            getMusicData(
              message.guild.id
            );

          if (
            !data.connection
          ) {
            data.connection =
              await connectToVoice(
                message.member
                  .voice.channel
              );

            data.connection.subscribe(
              data.player
            );
          }

          data.textChannel =
            message.channel;

          const track =
            await getTrack(
              query
            );

          const wasPlaying =
            Boolean(
              data.current
            );

          data.queue.push(
            track
          );

          if (
            !wasPlaying
          ) {
            await playNextTrack(
              message.guild.id
            );

            await safeReply(
              message,
              `▶️ Playing **${track.title}**`
            );
          } else {
            await safeReply(
              message,
              `✅ Added **${track.title}** to the queue.`
            );
          }
        } catch (error) {
          console.error(
            "❌ Play error:",
            error
          );

          await safeReply(
            message,
            "❌ Couldn't play that."
          );
        }

        return;
      }

      // ======================================================
      // SKIP
      // ======================================================

      if (
        command ===
        "skip"
      ) {
        const data =
          musicQueues.get(
            message.guild.id
          );

        if (
          !data?.current
        ) {
          await safeReply(
            message,
            "❌ Nothing is playing."
          );
          return;
        }

        data.player.stop();

        await safeReply(
          message,
          "⏭️ Skipped."
        );

        return;
      }

      // ======================================================
      // STOP
      // ======================================================

      if (
        command ===
        "stop"
      ) {
        const data =
          musicQueues.get(
            message.guild.id
          );

        if (!data) {
          await safeReply(
            message,
            "❌ Nothing is playing."
          );

          return;
        }

        data.queue = [];
        data.current =
          null;
        data.loop =
          false;

        data.player.stop();

        await safeReply(
          message,
          "⏹️ Music stopped and queue cleared."
        );

        return;
      }

      // ======================================================
      // LOOP
      // ======================================================

      if (
        command ===
        "loop"
      ) {
        const data =
          getMusicData(
            message.guild.id
          );

        data.loop =
          !data.loop;

        await safeReply(
          message,
          data.loop
            ? "🔁 Loop is now **ON**."
            : "➡️ Loop is now **OFF**."
        );

        return;
      }

      // ======================================================
      // QUEUE
      // ======================================================

      if (
        command ===
        "queue"
      ) {
        const data =
          musicQueues.get(
            message.guild.id
          );

        if (
          !data ||
          (
            !data.current &&
            !data.queue.length
          )
        ) {
          await safeReply(
            message,
            "📭 Queue is empty."
          );

          return;
        }

        let text = "";

        if (
          data.current
        ) {
          text +=
            `▶️ **Now Playing:** ${data.current.title}\n\n`;
        }

        if (
          data.queue.length
        ) {
          text +=
            data.queue
              .map(
                (
                  track,
                  index
                ) =>
                  `**${index + 1}.** ${track.title}`
              )
              .join(
                "\n"
              );
        } else {
          text +=
            "No songs waiting.";
        }

        await safeReply(
          message,
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
// AI MENTION
// ============================================================

client.on(
  "messageCreate",
  async (
    message
  ) => {
    try {
      if (
        message.author.bot
      ) {
        return;
      }

      if (
        message.guildId !==
        GUILD_ID
      ) {
        return;
      }

      if (
        !client.user ||
        !message.mentions.has(
          client.user.id
        )
      ) {
        return;
      }

      if (
        message.content.startsWith(
          PREFIX
        )
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
        await safeReply(
          message,
          "Yo, what do you need?"
        );

        return;
      }

      if (!openai) {
        await safeReply(
          message,
          "❌ AI isn't configured."
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

        if (answer) {
          await safeReply(
            message,
            answer.slice(
              0,
              1900
            )
          );
        }
      } catch (error) {
        console.error(
          "❌ OpenAI error:",
          error
        );

        await safeReply(
          message,
          "❌ AI error. Check your OPENAI_API_KEY and OPENAI_MODEL."
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
// LEAVE OTHER SERVERS
// ============================================================

async function leaveOtherGuilds() {
  console.log(
    "🔎 Checking guilds..."
  );

  for (
    const guild of
    client.guilds.cache.values()
  ) {
    if (
      guild.id ===
      GUILD_ID
    ) {
      console.log(
        `✅ Keeping guild: ${guild.name} (${guild.id})`
      );

      continue;
    }

    console.log(
      `🚪 Leaving unauthorized guild: ${guild.name} (${guild.id})`
    );

    try {
      await guild.leave();

      console.log(
        `✅ Left ${guild.name}`
      );
    } catch (error) {
      console.error(
        `❌ Couldn't leave ${guild.name}:`,
        error
      );
    }
  }
}

// ============================================================
// IF SOMEONE INVITES IT TO ANOTHER SERVER
// ============================================================

client.on(
  "guildCreate",
  async (guild) => {
    console.log(
      `📥 Bot joined: ${guild.name} (${guild.id})`
    );

    if (
      guild.id !==
      GUILD_ID
    ) {
      console.log(
        `🚪 ${guild.name} is not Erts United. Leaving...`
      );

      try {
        await guild.leave();

        console.log(
          `✅ Left unauthorized guild.`
        );
      } catch (error) {
        console.error(
          "❌ Couldn't leave unauthorized guild:",
          error
        );
      }

      return;
    }

    console.log(
      "✅ This is the authorized Erts United guild."
    );
  }
);

// ============================================================
// READY
// ============================================================

client.once(
  "ready",
  async () => {
    console.log(
      "======================================"
    );

    console.log(
      `🤖 Logged in as ${client.user.tag}`
    );

    console.log(
      `🆔 Bot ID: ${client.user.id}`
    );

    console.log(
      `🎯 Allowed Guild: ${GUILD_ID}`
    );

    console.log(
      `👤 Hoster Role: ${FRIENDLY_HOSTER_ROLE_ID}`
    );

    console.log(
      "⌨️ Prefix: !"
    );

    console.log(
      "🚫 Slash commands disabled"
    );

    console.log(
      "======================================"
    );

    // LEAVE EVERY OTHER SERVER
    await leaveOtherGuilds();

    // Check Erts United
    try {
      const guild =
        await client.guilds.fetch(
          GUILD_ID
        );

      console.log(
        `✅ Connected to: ${guild.name}`
      );

      const role =
        guild.roles.cache.get(
          FRIENDLY_HOSTER_ROLE_ID
        );

      if (role) {
        console.log(
          `✅ Friendly Hoster role found: ${role.name}`
        );
      } else {
        console.error(
          "❌ FRIENDLY HOSTER ROLE NOT FOUND."
        );
      }

      const resultChannel =
        await client.channels.fetch(
          RESULTS_CHANNEL_ID
        );

      if (
        resultChannel
      ) {
        console.log(
          "✅ Results channel found."
        );
      } else {
        console.error(
          "❌ Results channel not found."
        );
      }
    } catch (error) {
      console.error(
        "❌ Couldn't access Erts United guild:",
        error
      );
    }

    // AUTO JOIN FIXED VC
    try {
      const channel =
        await client.channels.fetch(
          FIXED_VC_ID
        );

      if (
        channel &&
        (
          channel.type ===
            ChannelType.GuildVoice ||
          channel.type ===
            ChannelType.GuildStageVoice
        )
      ) {
        try {
          const connection =
            await connectToVoice(
              channel
            );

          const data =
            getMusicData(
              GUILD_ID
            );

          data.connection =
            connection;

          connection.subscribe(
            data.player
          );

          console.log(
            `🔊 Joined fixed VC: ${channel.name}`
          );
        } catch (error) {
          console.log(
            "⚠️ Couldn't auto-join fixed VC:",
            error.message
          );
        }
      }
    } catch (error) {
      console.log(
        "⚠️ Fixed VC check failed:",
        error.message
      );
    }

    console.log(
      "======================================"
    );

    console.log(
      "✅ erts United Bot is READY"
    );

    console.log(
      "✅ ! prefix commands enabled"
    );

    console.log(
      "✅ Friendly button system enabled"
    );

    console.log(
      "======================================"
    );
  }
);

// ============================================================
// CLEANUP EXPIRED DM REQUESTS
// ============================================================

setInterval(
  () => {
    const now =
      Date.now();

    for (
      const [
        userId,
        data,
      ] of pendingRobloxDMs
    ) {
      if (
        data.expires <=
        now
      ) {
        pendingRobloxDMs.delete(
          userId
        );
      }
    }
  },
  60_000
).unref();

// ============================================================
// ERRORS
// ============================================================

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

// ============================================================
// LOGIN
// ============================================================

console.log(
  "🚀 Starting erts United Bot..."
);

client.login(TOKEN).catch(
  (error) => {
    console.error(
      "❌ Login failed:",
      error
    );

    process.exit(1);
  }
);