import "dotenv/config";
import express from "express";

import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ChannelType,
} from "discord.js";

import {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  entersState,
} from "@discordjs/voice";

import play from "play-dl";
import OpenAI from "openai";

/* =========================================================
   CONFIG
========================================================= */

const TOKEN = String(
  process.env.TOKEN || process.env.DISCORD_TOKEN || ""
).trim();

const OPENAI_API_KEY = String(
  process.env.OPENAI_API_KEY || ""
).trim();

const GUILD_ID = String(
  process.env.GUILD_ID || "1540116399558313995"
).trim();

const FRIENDLY_HOSTER_ROLE_ID = String(
  process.env.FRIENDLY_HOSTER_ROLE_ID || "1541193960041615361"
).trim();

const RESULTS_CHANNEL_ID = String(
  process.env.RESULTS_CHANNEL_ID || "1540136949908770827"
).trim();

const LOG_CHANNEL_ID = String(
  process.env.LOG_CHANNEL_ID || "1362214241091981452"
).trim();

const FIXED_VC_ID = String(
  process.env.FIXED_VC_ID || "1368359914145058956"
).trim();

const INVITE_LINK =
  process.env.INVITE_LINK || "https://discord.gg/ZrNuUKJFfS";

const PORT = Number(process.env.PORT || 10000);

if (!TOKEN) {
  console.error("❌ TOKEN / DISCORD_TOKEN is missing.");
  process.exit(1);
}

/* =========================================================
   ID VALIDATION
========================================================= */

function checkSnowflake(name, value) {
  const valid = /^\d{17,20}$/.test(value);

  console.log(
    `${valid ? "✅" : "❌"} ${name}: "${value}" | length=${value.length}`
  );

  if (!valid) {
    console.error(
      `❌ ${name} is not a valid Discord ID.`
    );
  }

  return valid;
}

checkSnowflake("GUILD_ID", GUILD_ID);
checkSnowflake(
  "FRIENDLY_HOSTER_ROLE_ID",
  FRIENDLY_HOSTER_ROLE_ID
);
checkSnowflake(
  "RESULTS_CHANNEL_ID",
  RESULTS_CHANNEL_ID
);
checkSnowflake(
  "LOG_CHANNEL_ID",
  LOG_CHANNEL_ID
);
checkSnowflake(
  "FIXED_VC_ID",
  FIXED_VC_ID
);

/* =========================================================
   EXPRESS KEEPALIVE
========================================================= */

const app = express();

app.get("/", (_req, res) => {
  res.status(200).send("erts United Bot is online.");
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "online",
    bot: client?.user?.tag || null,
    botId: client?.user?.id || null,
    guildId: GUILD_ID,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Web server listening on port ${PORT}`);
});

/* =========================================================
   DISCORD CLIENT
========================================================= */

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.Reaction,
  ],
});

/* =========================================================
   OPENAI
========================================================= */

const openai = OPENAI_API_KEY
  ? new OpenAI({
      apiKey: OPENAI_API_KEY,
    })
  : null;

/* =========================================================
   FRIENDLY SYSTEM
========================================================= */

const POSITION_NAMES = {
  "1️⃣": "GK",
  "2️⃣": "CB",
  "3️⃣": "CB2",
  "4️⃣": "CM",
  "5️⃣": "LW",
  "6️⃣": "RW",
  "7️⃣": "ST",
};

const POSITION_EMOJIS = Object.keys(POSITION_NAMES);

const activeFriendlies = new Map();
const completedFriendlies = new Map();

/* =========================================================
   MUSIC SYSTEM
========================================================= */

const musicQueues = new Map();

function getMusicData(guildId) {
  if (!musicQueues.has(guildId)) {
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

    player.on(AudioPlayerStatus.Idle, async () => {
      const currentData = musicQueues.get(guildId);

      if (!currentData) return;

      if (currentData.loop && currentData.current) {
        try {
          await playMusicTrack(
            guildId,
            currentData.current
          );
        } catch (error) {
          console.error(
            "❌ Music loop error:",
            error
          );

          currentData.current = null;
          await playNextTrack(guildId);
        }

        return;
      }

      currentData.current = null;
      await playNextTrack(guildId);
    });

    player.on("error", async (error) => {
      console.error(
        "❌ Music player error:",
        error
      );

      const currentData = musicQueues.get(guildId);

      if (!currentData) return;

      currentData.current = null;
      await playNextTrack(guildId);
    });

    musicQueues.set(guildId, data);
  }

  return musicQueues.get(guildId);
}

async function connectToVoice(channel) {
  if (!channel) {
    throw new Error(
      "Voice channel not found."
    );
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator:
      channel.guild.voiceAdapterCreator,
    selfDeaf: true,
    selfMute: false,
  });

  try {
    await entersState(
      connection,
      VoiceConnectionStatus.Ready,
      15_000
    );
  } catch {
    connection.destroy();

    throw new Error(
      "Could not connect to the voice channel."
    );
  }

  return connection;
}

async function getTrackFromQuery(query) {
  const validation = play.yt_validate(query);

  if (validation === "video") {
    const info = await play.video_info(query);
    const video = info.video_details;

    return {
      title:
        video.title || "Unknown title",
      url: video.url || query,
      duration:
        video.durationRaw || "Unknown",
    };
  }

  const results = await play.search(query, {
    limit: 1,
  });

  if (!results.length) {
    throw new Error(
      "I couldn't find that song."
    );
  }

  const video = results[0];

  return {
    title:
      video.title || "Unknown title",
    url: video.url,
    duration:
      video.durationRaw || "Unknown",
  };
}

async function playMusicTrack(guildId, track) {
  const data = getMusicData(guildId);

  if (!data.connection) {
    throw new Error(
      "The bot is not connected to a voice channel."
    );
  }

  const stream = await play.stream(
    track.url,
    {
      quality: 2,
      discordPlayerCompatibility: true,
    }
  );

  const resource = createAudioResource(
    stream.stream,
    {
      inputType: stream.type,
    }
  );

  data.current = track;

  data.player.play(resource);

  data.connection.subscribe(
    data.player
  );
}

async function playNextTrack(guildId) {
  const data = musicQueues.get(guildId);

  if (!data) return;

  const nextTrack =
    data.queue.shift();

  if (!nextTrack) {
    data.current = null;
    return;
  }

  try {
    await playMusicTrack(
      guildId,
      nextTrack
    );

    if (data.textChannel) {
      await data.textChannel.send(
        `▶️ Now playing: **${nextTrack.title}**`
      );
    }
  } catch (error) {
    console.error(
      "❌ Error playing next track:",
      error
    );

    if (data.textChannel) {
      await data.textChannel.send(
        `❌ I couldn't play **${nextTrack.title}**. Skipping it.`
      );
    }

    data.current = null;

    await playNextTrack(guildId);
  }
}

/* =========================================================
   FIXED VC
========================================================= */

let fixedVCReconnectTimer = null;

async function joinFixedVC() {
  try {
    const guild =
      await client.guilds.fetch(
        GUILD_ID
      );

    const channel =
      await guild.channels.fetch(
        FIXED_VC_ID
      );

    if (!channel) {
      console.log(
        "❌ Fixed VC channel was not found."
      );
      return;
    }

    if (
      channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildStageVoice
    ) {
      console.log(
        "❌ FIXED_VC_ID is not a voice/stage channel."
      );
      return;
    }

    const existingConnection =
      getVoiceConnection(GUILD_ID);

    if (existingConnection) {
      return;
    }

    console.log(
      `🔊 Joining fixed VC: ${channel.name}`
    );

    const connection =
      await connectToVoice(channel);

    connection.on(
      VoiceConnectionStatus.Disconnected,
      async () => {
        console.log(
          "⚠️ Bot disconnected from fixed VC."
        );

        if (fixedVCReconnectTimer) {
          clearTimeout(
            fixedVCReconnectTimer
          );
        }

        fixedVCReconnectTimer =
          setTimeout(async () => {
            try {
              await joinFixedVC();
            } catch (error) {
              console.error(
                "❌ Fixed VC reconnect failed:",
                error
              );
            }
          }, 5000);
      }
    );

    const data =
      getMusicData(GUILD_ID);

    data.connection = connection;

    connection.subscribe(
      data.player
    );

    console.log(
      "✅ Connected to fixed VC."
    );
  } catch (error) {
    console.error(
      "❌ Fixed VC join error:",
      error
    );
  }
}

/* =========================================================
   HELPERS
========================================================= */

function isFriendlyHoster(
  interaction
) {
  return (
    interaction.inGuild() &&
    interaction.member?.roles?.cache?.has(
      FRIENDLY_HOSTER_ROLE_ID
    )
  );
}

async function sendLog(message) {
  try {
    const channel =
      await client.channels.fetch(
        LOG_CHANNEL_ID
      );

    if (channel?.isTextBased()) {
      await channel.send(message);
    }
  } catch (error) {
    console.error(
      "❌ Log error:",
      error
    );
  }
}

/* =========================================================
   SLASH COMMANDS
========================================================= */

const commands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription(
      "Show all available bot commands."
    ),

  new SlashCommandBuilder()
    .setName("dmrole")
    .setDescription(
      "DM every member with a selected role."
    )
    .addRoleOption((option) =>
      option
        .setName("role")
        .setDescription(
          "The role to DM."
        )
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("message")
        .setDescription(
          "The message to send."
        )
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("joinvc")
    .setDescription(
      "Join the fixed friendly voice channel."
    ),

  new SlashCommandBuilder()
    .setName("hostfriendly")
    .setDescription(
      "Start a friendly lineup."
    ),

  new SlashCommandBuilder()
    .setName("friendlylink")
    .setDescription(
      "DM the latest friendly lineup players the server link."
    ),

  new SlashCommandBuilder()
    .setName("endfriendly")
    .setDescription(
      "End the friendly and purge the channel."
    ),

  new SlashCommandBuilder()
    .setName("result")
    .setDescription(
      "Post a match result."
    )
    .addStringOption((option) =>
      option
        .setName("opponent")
        .setDescription(
          "Opponent name."
        )
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("score")
        .setDescription(
          "Final score, e.g. 3-1."
        )
        .setRequired(true)
    )
    .addStringOption((option) =>
      option
        .setName("outcome")
        .setDescription(
          "Match outcome."
        )
        .setRequired(true)
        .addChoices(
          {
            name: "Win",
            value: "WIN",
          },
          {
            name: "Draw",
            value: "DRAW",
          },
          {
            name: "Loss",
            value: "LOSS",
          }
        )
    )
    .addStringOption((option) =>
      option
        .setName("details")
        .setDescription(
          "Optional match details."
        )
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("play")
    .setDescription(
      "Play a song in your current voice channel."
    )
    .addStringOption((option) =>
      option
        .setName("query")
        .setDescription(
          "Song name or YouTube URL."
        )
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("skip")
    .setDescription(
      "Skip the current song."
    ),

  new SlashCommandBuilder()
    .setName("stop")
    .setDescription(
      "Stop music and clear the queue."
    ),

  new SlashCommandBuilder()
    .setName("loop")
    .setDescription(
      "Toggle loop mode."
    )
    .addBooleanOption((option) =>
      option
        .setName("enabled")
        .setDescription(
          "Turn looping on or off."
        )
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("queue")
    .setDescription(
      "Show the music queue."
    ),
].map((command) =>
  command.toJSON()
);

/* =========================================================
   🔥 FULL SLASH COMMAND DIAGNOSTIC
========================================================= */

async function diagnoseAndRegisterCommands() {
  console.log("");
  console.log(
    "=================================================="
  );
  console.log(
    "🔎 STARTING SLASH COMMAND DIAGNOSTICS"
  );
  console.log(
    "=================================================="
  );

  console.log(
    "Bot username:",
    client.user?.tag
  );

  console.log(
    "Bot user ID:",
    client.user?.id
  );

  console.log(
    "Application ID:",
    client.application?.id
  );

  console.log(
    "Target Guild ID:",
    JSON.stringify(GUILD_ID)
  );

  console.log(
    "Target Guild ID length:",
    GUILD_ID.length
  );

  console.log(
    "Commands to register:",
    commands.length
  );

  /* -------------------------------------------------------
     TEST 1: CACHE
  ------------------------------------------------------- */

  console.log("");
  console.log(
    "----- TEST 1: GUILD CACHE -----"
  );

  console.log(
    "Guild cache size:",
    client.guilds.cache.size
  );

  if (client.guilds.cache.size === 0) {
    console.log(
      "⚠️ The Gateway cache contains ZERO guilds."
    );
  } else {
    for (const guild of client.guilds.cache.values()) {
      console.log(
        `   • ${guild.name} | ${guild.id}`
      );
    }
  }

  console.log(
    "Target guild in cache:",
    client.guilds.cache.has(
      GUILD_ID
    )
  );

  /* -------------------------------------------------------
     TEST 2: DIRECT GUILD FETCH
  ------------------------------------------------------- */

  console.log("");
  console.log(
    "----- TEST 2: DIRECT GUILD FETCH -----"
  );

  let targetGuild = null;

  try {
    targetGuild =
      await client.guilds.fetch(
        GUILD_ID
      );

    console.log(
      "✅ DIRECT GUILD FETCH WORKED"
    );

    console.log(
      "Guild name:",
      targetGuild.name
    );

    console.log(
      "Guild ID:",
      targetGuild.id
    );
  } catch (error) {
    console.error(
      "❌ DIRECT GUILD FETCH FAILED"
    );

    console.error(
      "Error name:",
      error?.name
    );

    console.error(
      "Error code:",
      error?.code
    );

    console.error(
      "HTTP status:",
      error?.status
    );

    console.error(
      "Error message:",
      error?.message
    );

    console.error(
      "Raw error:",
      error?.rawError
    );
  }

  /* -------------------------------------------------------
     TEST 3: BOT MEMBER FETCH
  ------------------------------------------------------- */

  console.log("");
  console.log(
    "----- TEST 3: BOT MEMBER FETCH -----"
  );

  if (targetGuild) {
    try {
      const me =
        await targetGuild.members.fetchMe();

      console.log(
        "✅ BOT MEMBER FETCH WORKED"
      );

      console.log(
        "Bot member ID:",
        me.id
      );

      console.log(
        "Bot nickname:",
        me.nickname || "(none)"
      );

      console.log(
        "Bot roles:",
        me.roles.cache
          .map((r) => `${r.name} (${r.id})`)
          .join(", ")
      );
    } catch (error) {
      console.error(
        "❌ BOT MEMBER FETCH FAILED"
      );

      console.error(
        "Error name:",
        error?.name
      );

      console.error(
        "Error code:",
        error?.code
      );

      console.error(
        "HTTP status:",
        error?.status
      );

      console.error(
        "Error message:",
        error?.message
      );
    }
  } else {
    console.log(
      "⏭️ Skipped because TEST 2 failed."
    );
  }

  /* -------------------------------------------------------
     TEST 4: APPLICATION FETCH
  ------------------------------------------------------- */

  console.log("");
  console.log(
    "----- TEST 4: APPLICATION FETCH -----"
  );

  try {
    const application =
      await client.application.fetch();

    console.log(
      "✅ APPLICATION FETCH WORKED"
    );

    console.log(
      "Application ID:",
      application.id
    );

    console.log(
      "Application name:",
      application.name
    );

    console.log(
      "Bot user ID:",
      client.user.id
    );

    console.log(
      "Application ID === Bot ID:",
      application.id === client.user.id
    );
  } catch (error) {
    console.error(
      "❌ APPLICATION FETCH FAILED"
    );

    console.error(
      "Error name:",
      error?.name
    );

    console.error(
      "Error code:",
      error?.code
    );

    console.error(
      "HTTP status:",
      error?.status
    );

    console.error(
      "Error message:",
      error?.message
    );
  }

  /* -------------------------------------------------------
     TEST 5: REST GUILD FETCH
  ------------------------------------------------------- */

  console.log("");
  console.log(
    "----- TEST 5: RAW REST GUILD FETCH -----"
  );

  const rest = new REST({
    version: "10",
  }).setToken(TOKEN);

  try {
    const guildData =
      await rest.get(
        Routes.guild(GUILD_ID)
      );

    console.log(
      "✅ RAW REST GUILD FETCH WORKED"
    );

    console.log(
      "REST guild name:",
      guildData?.name
    );

    console.log(
      "REST guild ID:",
      guildData?.id
    );
  } catch (error) {
    console.error(
      "❌ RAW REST GUILD FETCH FAILED"
    );

    console.error(
      "Error name:",
      error?.name
    );

    console.error(
      "Error code:",
      error?.code
    );

    console.error(
      "HTTP status:",
      error?.status
    );

    console.error(
      "Error message:",
      error?.message
    );

    console.error(
      "Raw error:",
      error?.rawError
    );
  }

  /* -------------------------------------------------------
     TEST 6: RAW COMMAND GET
  ------------------------------------------------------- */

  console.log("");
  console.log(
    "----- TEST 6: GET GUILD SLASH COMMANDS -----"
  );

  const applicationId =
    client.application?.id ||
    client.user?.id;

  try {
    const existingCommands =
      await rest.get(
        Routes.applicationGuildCommands(
          applicationId,
          GUILD_ID
        )
      );

    console.log(
      "✅ COMMAND GET WORKED"
    );

    console.log(
      "Existing guild commands:",
      Array.isArray(existingCommands)
        ? existingCommands.length
        : "unknown"
    );

    if (Array.isArray(existingCommands)) {
      for (const command of existingCommands) {
        console.log(
          `   • /${command.name} (${command.id})`
        );
      }
    }
  } catch (error) {
    console.error(
      "❌ COMMAND GET FAILED"
    );

    console.error(
      "Error name:",
      error?.name
    );

    console.error(
      "Error code:",
      error?.code
    );

    console.error(
      "HTTP status:",
      error?.status
    );

    console.error(
      "Error message:",
      error?.message
    );

    console.error(
      "Raw error:",
      error?.rawError
    );
  }

  /* -------------------------------------------------------
     TEST 7: REGISTER COMMANDS
  ------------------------------------------------------- */

  console.log("");
  console.log(
    "----- TEST 7: REGISTER 12 COMMANDS -----"
  );

  try {
    const result =
      await rest.put(
        Routes.applicationGuildCommands(
          applicationId,
          GUILD_ID
        ),
        {
          body: commands,
        }
      );

    console.log(
      "✅✅✅ SLASH COMMAND REGISTRATION WORKED ✅✅✅"
    );

    console.log(
      "Registered commands:",
      Array.isArray(result)
        ? result.length
        : "unknown"
    );

    if (Array.isArray(result)) {
      for (const command of result) {
        console.log(
          `   • /${command.name}`
        );
      }
    }
  } catch (error) {
    console.error("");
    console.error(
      "❌❌❌ SLASH COMMAND REGISTRATION FAILED ❌❌❌"
    );

    console.error(
      "Error name:",
      error?.name
    );

    console.error(
      "Discord error code:",
      error?.code
    );

    console.error(
      "HTTP status:",
      error?.status
    );

    console.error(
      "Error message:",
      error?.message
    );

    console.error(
      "Raw error:",
      error?.rawError
    );

    console.error(
      "Request body:",
      error?.requestBody
    );

    console.error(
      "Application ID used:",
      applicationId
    );

    console.error(
      "Guild ID used:",
      JSON.stringify(GUILD_ID)
    );

    console.error("");
    console.error(
      "========== DIAGNOSIS =========="
    );

    if (error?.code === 50001) {
      console.error(
        "50001 = Discord says this application/token does NOT have access to the requested guild/endpoint."
      );
    } else if (error?.code === 10004) {
      console.error(
        "10004 = Discord says the guild was not found."
      );
    } else if (error?.code === 50013) {
      console.error(
        "50013 = Discord says the bot lacks a required permission."
      );
    } else if (error?.code === 20012) {
      console.error(
        "20012 = Discord says the application does not have the required authorization/scope."
      );
    } else {
      console.error(
        "This is a different Discord API error. The exact code/message above is what we need."
      );
    }

    console.error(
      "================================"
    );
  }

  console.log("");
  console.log(
    "=================================================="
  );
  console.log(
    "🔎 SLASH COMMAND DIAGNOSTICS COMPLETE"
  );
  console.log(
    "=================================================="
  );
}

/* =========================================================
   READY
========================================================= */

client.once("ready", async () => {
  console.log("");
  console.log(
    "=============================================="
  );
  console.log(
    `🤖 LOGGED IN AS: ${client.user.tag}`
  );
  console.log(
    `🆔 BOT ID: ${client.user.id}`
  );
  console.log(
    "=============================================="
  );

  await diagnoseAndRegisterCommands();

  await joinFixedVC();

  console.log(
    "✅ BOT STARTUP COMPLETE"
  );
});

/* =========================================================
   INTERACTIONS
========================================================= */

client.on(
  "interactionCreate",
  async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    try {
      /* ===================================================
         /help
      =================================================== */

      if (interaction.commandName === "help") {
        const embed =
          new EmbedBuilder()
            .setTitle(
              "erts United Bot"
            )
            .setDescription(
              "Available commands:"
            )
            .addFields(
              {
                name: "Friendly",
                value:
                  "`/hostfriendly`\n`/friendlylink`\n`/endfriendly`",
              },
              {
                name:
                  "Utility",
                value:
                  "`/dmrole`\n`/joinvc`\n`/result`",
              },
              {
                name: "Music",
                value:
                  "`/play`\n`/skip`\n`/stop`\n`/loop`\n`/queue`",
              }
            );

        await interaction.reply({
          embeds: [embed],
          ephemeral: true,
        });

        return;
      }

      /* ===================================================
         /dmrole
      =================================================== */

      if (
        interaction.commandName ===
        "dmrole"
      ) {
        if (
          !isFriendlyHoster(
            interaction
          )
        ) {
          await interaction.reply({
            content:
              "❌ You need the Friendly Hoster role to use this command.",
            ephemeral: true,
          });

          return;
        }

        const role =
          interaction.options.getRole(
            "role"
          );

        const message =
          interaction.options.getString(
            "message"
          );

        await interaction.deferReply({
          ephemeral: true,
        });

        const members =
          await interaction.guild.members.fetch();

        let sent = 0;
        let failed = 0;

        for (
          const member
          of members.values()
        ) {
          if (member.user.bot) {
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
              message
            );

            sent++;
          } catch {
            failed++;
          }
        }

        await interaction.editReply(
          `✅ DM sent to **${sent}** member(s).\n❌ Failed to DM **${failed}** member(s).`
        );

        return;
      }

      /* ===================================================
         /joinvc
      =================================================== */

      if (
        interaction.commandName ===
        "joinvc"
      ) {
        await interaction.deferReply({
          ephemeral: true,
        });

        try {
          const guild =
            await client.guilds.fetch(
              GUILD_ID
            );

          const channel =
            await guild.channels.fetch(
              FIXED_VC_ID
            );

          if (!channel) {
            await interaction.editReply(
              "❌ The fixed VC could not be found."
            );

            return;
          }

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

          await interaction.editReply(
            `✅ Joined **${channel.name}**.`
          );
        } catch (error) {
          console.error(
            "❌ /joinvc error:",
            error
          );

          await interaction.editReply(
            "❌ I couldn't join the fixed VC."
          );
        }

        return;
      }

      /* ===================================================
         /hostfriendly
      =================================================== */

      if (
        interaction.commandName ===
        "hostfriendly"
      ) {
        if (
          !isFriendlyHoster(
            interaction
          )
        ) {
          await interaction.reply({
            content:
              "❌ You need the Friendly Hoster role to host a friendly.",
            ephemeral: true,
          });

          return;
        }

        if (
          activeFriendlies.has(
            interaction.channelId
          )
        ) {
          await interaction.reply({
            content:
              "❌ There is already an active friendly in this channel.",
            ephemeral: true,
          });

          return;
        }

        const lineup = {
          GK: null,
          CB: null,
          CB2: null,
          CM: null,
          LW: null,
          RW: null,
          ST: null,
        };

        const friendlyMessage =
          await interaction.channel.send(
            [
              "**FRIENDLY LINEUP**",
              "",
              "React to claim a position.",
              "",
              "1️⃣ GK",
              "2️⃣ CB",
              "3️⃣ CB2",
              "4️⃣ CM",
              "5️⃣ LW",
              "6️⃣ RW",
              "7️⃣ ST",
            ].join("\n")
          );

        for (
          const emoji
          of POSITION_EMOJIS
        ) {
          await friendlyMessage.react(
            emoji
          );
        }

        activeFriendlies.set(
          interaction.channelId,
          {
            message:
              friendlyMessage,
            lineup,
          }
        );

        await interaction.reply({
          content:
            "✅ Friendly lineup opened.",
          ephemeral: true,
        });

        await sendLog(
          `📋 Friendly started by ${interaction.user} in <#${interaction.channelId}>.`
        );

        return;
      }

      /* ===================================================
         /friendlylink
      =================================================== */

      if (
        interaction.commandName ===
        "friendlylink"
      ) {
        if (
          !isFriendlyHoster(
            interaction
          )
        ) {
          await interaction.reply({
            content:
              "❌ You need the Friendly Hoster role to use this command.",
            ephemeral: true,
          });

          return;
        }

        const completed =
          completedFriendlies.get(
            interaction.channelId
          );

        if (!completed) {
          await interaction.reply({
            content:
              "❌ There isn't a completed friendly lineup in this channel.",
            ephemeral: true,
          });

          return;
        }

        await interaction.deferReply({
          ephemeral: true,
        });

        let sent = 0;
        let failed = 0;

        for (
          const userId
          of Object.values(
            completed.lineup
          )
        ) {
          if (!userId) continue;

          try {
            const member =
              await interaction.guild.members.fetch(
                userId
              );

            await member.send(
              `⚽ **erts United Friendly**\n\nYou are in the lineup.\n\nJoin here: ${INVITE_LINK}`
            );

            sent++;
          } catch {
            failed++;
          }
        }

        await interaction.editReply(
          `✅ Friendly link sent to **${sent}** players.\n❌ Failed: **${failed}**.`
        );

        return;
      }

      /* ===================================================
         /endfriendly
      =================================================== */

      if (
        interaction.commandName ===
        "endfriendly"
      ) {
        if (
          !isFriendlyHoster(
            interaction
          )
        ) {
          await interaction.reply({
            content:
              "❌ You need the Friendly Hoster role to end the friendly.",
            ephemeral: true,
          });

          return;
        }

        await interaction.deferReply({
          ephemeral: true,
        });

        try {
          activeFriendlies.delete(
            interaction.channelId
          );

          completedFriendlies.delete(
            interaction.channelId
          );

          let totalDeleted = 0;

          while (true) {
            const messages =
              await interaction.channel.messages.fetch(
                {
                  limit: 100,
                }
              );

            if (!messages.size) {
              break;
            }

            const recent =
              messages.filter(
                (message) =>
                  Date.now() -
                    message.createdTimestamp <
                  14 *
                    24 *
                    60 *
                    60 *
                    1000
              );

            const old =
              messages.filter(
                (message) =>
                  Date.now() -
                    message.createdTimestamp >=
                  14 *
                    24 *
                    60 *
                    60 *
                    1000
              );

            if (
              recent.size > 1
            ) {
              const deleted =
                await interaction.channel.bulkDelete(
                  recent,
                  true
                );

              totalDeleted +=
                deleted.size;
            } else if (
              recent.size === 1
            ) {
              try {
                await recent
                  .first()
                  .delete();

                totalDeleted++;
              } catch {}
            }

            for (
              const message
              of old.values()
            ) {
              try {
                await message.delete();
                totalDeleted++;
              } catch {}
            }

            if (
              messages.size < 100
            ) {
              break;
            }
          }

          await interaction.editReply(
            `✅ Friendly ended and approximately **${totalDeleted}** message(s) were removed.`
          );
        } catch (error) {
          console.error(
            "❌ /endfriendly error:",
            error
          );

          await interaction.editReply(
            "❌ I couldn't completely purge the channel. Discord may prevent deletion of some older messages."
          );
        }

        return;
      }

      /* ===================================================
         /result
      =================================================== */

      if (
        interaction.commandName ===
        "result"
      ) {
        if (
          !isFriendlyHoster(
            interaction
          )
        ) {
          await interaction.reply({
            content:
              "❌ You need the Friendly Hoster role to post results.",
            ephemeral: true,
          });

          return;
        }

        const opponent =
          interaction.options.getString(
            "opponent"
          );

        const score =
          interaction.options.getString(
            "score"
          );

        const outcome =
          interaction.options.getString(
            "outcome"
          );

        const details =
          interaction.options.getString(
            "details"
          );

        const resultsChannel =
          await client.channels.fetch(
            RESULTS_CHANNEL_ID
          );

        if (
          !resultsChannel?.isTextBased()
        ) {
          await interaction.reply({
            content:
              "❌ The results channel could not be found.",
            ephemeral: true,
          });

          return;
        }

        let title =
          "⚽ MATCH RESULT";

        if (
          outcome === "WIN"
        ) {
          title = "🏆 MATCH WIN";
        } else if (
          outcome === "DRAW"
        ) {
          title = "🤝 MATCH DRAW";
        } else if (
          outcome === "LOSS"
        ) {
          title = "❌ MATCH LOSS";
        }

        const embed =
          new EmbedBuilder()
            .setTitle(title)
            .addFields(
              {
                name: "Opponent",
                value: opponent,
                inline: true,
              },
              {
                name: "Score",
                value: score,
                inline: true,
              }
            )
            .setTimestamp()
            .setFooter({
              text: `Posted by ${interaction.user.username}`,
            });

        if (details) {
          embed.addFields({
            name: "Details",
            value: details,
          });
        }

        await resultsChannel.send({
          embeds: [embed],
        });

        await interaction.reply({
          content:
            `✅ Result posted in <#${RESULTS_CHANNEL_ID}>.`,
          ephemeral: true,
        });

        return;
      }

      /* ===================================================
         /play
      =================================================== */

      if (
        interaction.commandName ===
        "play"
      ) {
        const query =
          interaction.options.getString(
            "query"
          );

        const member =
          interaction.member;

        if (
          !member?.voice?.channel
        ) {
          await interaction.reply({
            content:
              "❌ You need to be in a voice channel first.",
            ephemeral: true,
          });

          return;
        }

        await interaction.deferReply();

        try {
          const voiceChannel =
            member.voice.channel;

          const data =
            getMusicData(
              interaction.guildId
            );

          if (
            !data.connection ||
            data.connection.state
              .status ===
              VoiceConnectionStatus.Destroyed
          ) {
            data.connection =
              await connectToVoice(
                voiceChannel
              );

            data.connection.subscribe(
              data.player
            );
          }

          data.textChannel =
            interaction.channel;

          const track =
            await getTrackFromQuery(
              query
            );

          const wasPlaying =
            !!data.current;

          data.queue.push(
            track
          );

          if (!wasPlaying) {
            await playNextTrack(
              interaction.guildId
            );

            await interaction.editReply(
              `▶️ Playing **${track.title}**`
            );
          } else {
            await interaction.editReply(
              `✅ Added **${track.title}** to the queue.`
            );
          }
        } catch (error) {
          console.error(
            "❌ /play error:",
            error
          );

          await interaction.editReply(
            "❌ I couldn't play that song."
          );
        }

        return;
      }

      /* ===================================================
         /skip
      =================================================== */

      if (
        interaction.commandName ===
        "skip"
      ) {
        const data =
          musicQueues.get(
            interaction.guildId
          );

        if (
          !data ||
          !data.current
        ) {
          await interaction.reply({
            content:
              "❌ Nothing is currently playing.",
            ephemeral: true,
          });

          return;
        }

        data.player.stop();

        await interaction.reply(
          "⏭️ Skipped."
        );

        return;
      }

      /* ===================================================
         /stop
      =================================================== */

      if (
        interaction.commandName ===
        "stop"
      ) {
        const data =
          musicQueues.get(
            interaction.guildId
          );

        if (!data) {
          await interaction.reply({
            content:
              "❌ Nothing is playing.",
            ephemeral: true,
          });

          return;
        }

        data.queue = [];
        data.current = null;
        data.loop = false;

        data.player.stop();

        await interaction.reply(
          "⏹️ Music stopped and queue cleared."
        );

        return;
      }

      /* ===================================================
         /loop
      =================================================== */

      if (
        interaction.commandName ===
        "loop"
      ) {
        const data =
          getMusicData(
            interaction.guildId
          );

        const requested =
          interaction.options.getBoolean(
            "enabled"
          );

        if (
          requested === null
        ) {
          data.loop =
            !data.loop;
        } else {
          data.loop =
            requested;
        }

        await interaction.reply(
          data.loop
            ? "🔁 Loop is now **ON**."
            : "➡️ Loop is now **OFF**."
        );

        return;
      }

      /* ===================================================
         /queue
      =================================================== */

      if (
        interaction.commandName ===
        "queue"
      ) {
        const data =
          musicQueues.get(
            interaction.guildId
          );

        if (
          !data ||
          (
            !data.current &&
            !data.queue.length
          )
        ) {
          await interaction.reply(
            "📭 The music queue is empty."
          );

          return;
        }

        let description = "";

        if (data.current) {
          description +=
            `▶️ **Now Playing:** ${data.current.title}\n\n`;
        }

        if (
          data.queue.length
        ) {
          description +=
            data.queue
              .map(
                (track, index) =>
                  `**${index + 1}.** ${track.title}`
              )
              .join("\n");
        } else {
          description +=
            "No songs waiting in the queue.";
        }

        const embed =
          new EmbedBuilder()
            .setTitle(
              "🎵 Music Queue"
            )
            .setDescription(
              description
            );

        await interaction.reply({
          embeds: [embed],
        });

        return;
      }
    } catch (error) {
      console.error(
        `❌ Error handling /${interaction.commandName}:`,
        error
      );

      try {
        if (
          interaction.replied ||
          interaction.deferred
        ) {
          await interaction.followUp({
            content:
              "❌ Something went wrong while running that command.",
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content:
              "❌ Something went wrong while running that command.",
            ephemeral: true,
          });
        }
      } catch {}
    }
  }
);

/* =========================================================
   FRIENDLY REACTIONS
========================================================= */

client.on(
  "messageReactionAdd",
  async (reaction, user) => {
    try {
      if (user.bot) return;

      if (reaction.partial) {
        await reaction.fetch();
      }

      if (
        reaction.message.partial
      ) {
        await reaction.message.fetch();
      }

      const channelId =
        reaction.message.channelId;

      const active =
        activeFriendlies.get(
          channelId
        );

      if (!active) return;

      if (
        reaction.message.id !==
        active.message.id
      ) {
        return;
      }

      const emoji =
        reaction.emoji.name;

      if (
        !emoji ||
        !POSITION_NAMES[emoji]
      ) {
        return;
      }

      const position =
        POSITION_NAMES[emoji];

      if (
        active.lineup[position]
      ) {
        await reaction.users.remove(
          user.id
        );

        return;
      }

      const alreadyHasPosition =
        Object.values(
          active.lineup
        ).includes(user.id);

      if (
        alreadyHasPosition
      ) {
        await reaction.users.remove(
          user.id
        );

        return;
      }

      active.lineup[position] =
        user.id;

      const complete =
        Object.values(
          active.lineup
        ).every(Boolean);

      if (!complete) {
        return;
      }

      const lineup =
        active.lineup;

      const finalLineup = [
        "**FINAL LINEUP**",
        `GK: <@${lineup.GK}>`,
        `CB: <@${lineup.CB}>`,
        `CB2: <@${lineup.CB2}>`,
        `CM: <@${lineup.CM}>`,
        `LW: <@${lineup.LW}>`,
        `RW: <@${lineup.RW}>`,
        `ST: <@${lineup.ST}>`,
      ].join("\n");

      await active.message.edit(
        finalLineup
      );

      try {
        await active.message.reactions.removeAll();
      } catch {}

      completedFriendlies.set(
        channelId,
        {
          lineup: {
            ...lineup,
          },
          messageId:
            active.message.id,
        }
      );

      activeFriendlies.delete(
        channelId
      );

      await sendLog(
        `✅ Friendly lineup completed in <#${channelId}>.`
      );
    } catch (error) {
      console.error(
        "❌ Friendly reaction error:",
        error
      );
    }
  }
);

/* =========================================================
   DIRECT BOT MENTION AI
========================================================= */

client.on(
  "messageCreate",
  async (message) => {
    try {
      if (message.author.bot) {
        return;
      }

      if (!client.user) {
        return;
      }

      if (
        !message.mentions.has(
          client.user.id
        )
      ) {
        return;
      }

      if (
        message.guildId !==
        GUILD_ID
      ) {
        return;
      }

      if (!openai) {
        await message.reply(
          "❌ My AI is not configured. `OPENAI_API_KEY` is missing."
        );

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
          "Yo, what do you need?"
        );

        return;
      }

      await message.channel.sendTyping();

      const response =
        await openai.responses.create(
          {
            model:
              "gpt-5.6-luna",
            instructions:
              "You are the erts United Discord server assistant. Be helpful, casual, concise, and friendly. Do not pretend to be a human. Do not make up server information.",
            input: prompt,
            max_output_tokens: 500,
          }
        );

      const answer =
        response.output_text?.trim();

      if (!answer) {
        await message.reply(
          "❌ I couldn't generate a response."
        );

        return;
      }

      await message.reply(
        answer
      );
    } catch (error) {
      console.error(
        "❌ AI mention error:",
        error
      );

      try {
        await message.reply(
          "❌ I had an error trying to respond."
        );
      } catch {}
    }
  }
);

/* =========================================================
   GLOBAL ERROR HANDLERS
========================================================= */

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
      "❌ Unhandled promise rejection:",
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

/* =========================================================
   LOGIN
========================================================= */

console.log(
  "🚀 Starting erts United Bot..."
);

console.log(
  `🎯 Target guild: ${GUILD_ID}`
);

client.login(TOKEN);