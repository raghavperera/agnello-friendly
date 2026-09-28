import "dotenv/config";
import express from "express";
import {
  Client,
  GatewayIntentBits,
  Partials,
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

const TOKEN = process.env.TOKEN || process.env.DISCORD_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const PREFIX = "!";

const GUILD_ID =
  process.env.GUILD_ID || "1540116399558313995";

const FRIENDLY_HOSTER_ROLE_ID =
  process.env.FRIENDLY_HOSTER_ROLE_ID ||
  "1541193960041615361";

const RESULTS_CHANNEL_ID =
  process.env.RESULTS_CHANNEL_ID ||
  "1540136949908770827";

const LOG_CHANNEL_ID =
  process.env.LOG_CHANNEL_ID ||
  "1362214241091981452";

const FIXED_VC_ID =
  process.env.FIXED_VC_ID ||
  "1368359914145058956";

const INVITE_LINK =
  process.env.INVITE_LINK ||
  "https://discord.gg/ZrNuUKJFfS";

const PORT = process.env.PORT || 10000;

if (!TOKEN) {
  console.error("❌ TOKEN is missing.");
  process.exit(1);
}

/* =========================================================
   EXPRESS
========================================================= */

const app = express();

app.get("/", (_req, res) => {
  res.send("erts United Bot is online.");
});

app.get("/health", (_req, res) => {
  res.json({
    status: "online",
    bot: client?.user?.tag || null,
  });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Web server running on port ${PORT}`);
});

/* =========================================================
   DISCORD
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
   FRIENDLY
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
   MUSIC
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
          console.error("Music loop error:", error);
          currentData.current = null;
          await playNextTrack(guildId);
        }

        return;
      }

      currentData.current = null;
      await playNextTrack(guildId);
    });

    player.on("error", async (error) => {
      console.error("Music error:", error);

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
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
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

async function getTrackFromQuery(query) {
  const validation = play.yt_validate(query);

  if (validation === "video") {
    const info = await play.video_info(query);
    const video = info.video_details;

    return {
      title: video.title || "Unknown",
      url: video.url || query,
    };
  }

  const results = await play.search(query, {
    limit: 1,
  });

  if (!results.length) {
    throw new Error("Song not found.");
  }

  return {
    title: results[0].title || "Unknown",
    url: results[0].url,
  };
}

async function playMusicTrack(guildId, track) {
  const data = getMusicData(guildId);

  if (!data.connection) {
    throw new Error("Not connected to voice.");
  }

  const stream = await play.stream(track.url, {
    quality: 2,
    discordPlayerCompatibility: true,
  });

  const resource = createAudioResource(
    stream.stream,
    {
      inputType: stream.type,
    }
  );

  data.current = track;
  data.player.play(resource);
  data.connection.subscribe(data.player);
}

async function playNextTrack(guildId) {
  const data = musicQueues.get(guildId);

  if (!data) return;

  const track = data.queue.shift();

  if (!track) {
    data.current = null;
    return;
  }

  try {
    await playMusicTrack(guildId, track);

    if (data.textChannel) {
      await data.textChannel.send(
        `▶️ Now playing: **${track.title}**`
      );
    }
  } catch (error) {
    console.error("Music playback error:", error);
    data.current = null;
    await playNextTrack(guildId);
  }
}

/* =========================================================
   HELPERS
========================================================= */

function isFriendlyHoster(message) {
  return (
    message.member?.roles?.cache?.has(
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
    console.error("Log error:", error);
  }
}

/* =========================================================
   READY
========================================================= */

client.once("ready", async () => {
  console.log(
    `🤖 Logged in as ${client.user.tag}`
  );

  console.log(
    `🆔 Bot ID: ${client.user.id}`
  );

  console.log(
    `🎯 Guild ID: ${GUILD_ID}`
  );

  console.log(
    "✅ Prefix system enabled. No slash commands will be registered."
  );

  try {
    const guild =
      await client.guilds.fetch(GUILD_ID);

    console.log(
      `✅ Connected to ${guild.name}`
    );
  } catch (error) {
    console.error(
      "❌ Cannot access configured guild:",
      error
    );
  }

  try {
    const channel =
      await client.channels.fetch(
        FIXED_VC_ID
      );

    if (
      channel &&
      (
        channel.type === ChannelType.GuildVoice ||
        channel.type === ChannelType.GuildStageVoice
      )
    ) {
      const connection =
        await connectToVoice(channel);

      const data =
        getMusicData(GUILD_ID);

      data.connection = connection;
      connection.subscribe(data.player);

      console.log(
        `🔊 Joined ${channel.name}`
      );
    }
  } catch (error) {
    console.error(
      "❌ Fixed VC error:",
      error
    );
  }

  console.log("✅ Bot startup complete.");
});

/* =========================================================
   PREFIX COMMANDS
========================================================= */

client.on("messageCreate", async (message) => {
  try {
    if (message.author.bot) return;

    /* ================================================
       AI MENTION
    ================================================ */

    if (
      client.user &&
      message.mentions.has(client.user.id) &&
      message.guildId === GUILD_ID
    ) {
      if (!openai) {
        await message.reply(
          "❌ My AI isn't configured."
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

      try {
        const response =
          await openai.responses.create({
            model: "gpt-5.6-luna",
            instructions:
              "You are the erts United Discord server assistant. Be casual, helpful, concise, and friendly.",
            input: prompt,
            max_output_tokens: 500,
          });

        const answer =
          response.output_text?.trim();

        if (answer) {
          await message.reply(answer);
        }
      } catch (error) {
        console.error(
          "AI error:",
          error
        );

        await message.reply(
          "❌ I had an error trying to respond."
        );
      }

      return;
    }

    /* ================================================
       PREFIX CHECK
    ================================================ */

    if (!message.content.startsWith(PREFIX)) {
      return;
    }

    const args =
      message.content
        .slice(PREFIX.length)
        .trim()
        .split(/\s+/);

    const command =
      args.shift()?.toLowerCase();

    if (!command) return;

    /* ================================================
       !help
    ================================================ */

    if (command === "help") {
      await message.reply(
        [
          "**erts United Bot Commands**",
          "",
          "**Friendly**",
          "`!hostfriendly`",
          "`!friendlylink`",
          "`!endfriendly`",
          "`!result <opponent> <score> <win/draw/loss>`",
          "",
          "**Utility**",
          "`!dmrole @role <message>`",
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

    /* ================================================
       !dmrole
    ================================================ */

    if (command === "dmrole") {
      if (!isFriendlyHoster(message)) {
        await message.reply(
          "❌ You need the Friendly Hoster role."
        );

        return;
      }

      const role =
        message.mentions.roles.first();

      if (!role) {
        await message.reply(
          "Usage: `!dmrole @role your message here`"
        );

        return;
      }

      const rolePosition =
        message.content.indexOf(
          role.id
        );

      const dmText =
        message.content
          .slice(
            rolePosition +
              role.id.length
          )
          .trim();

      if (!dmText) {
        await message.reply(
          "❌ You need to provide a message."
        );

        return;
      }

      const members =
        await message.guild.members.fetch();

      let sent = 0;
      let failed = 0;

      for (
        const member of members.values()
      ) {
        if (member.user.bot) continue;

        if (
          !member.roles.cache.has(
            role.id
          )
        ) {
          continue;
        }

        try {
          await member.send(dmText);
          sent++;
        } catch {
          failed++;
        }
      }

      await message.reply(
        `✅ Sent to **${sent}** member(s).\n❌ Failed: **${failed}**.`
      );

      return;
    }

    /* ================================================
       !joinvc
    ================================================ */

    if (command === "joinvc") {
      try {
        const channel =
          await client.channels.fetch(
            FIXED_VC_ID
          );

        if (!channel) {
          await message.reply(
            "❌ Fixed VC not found."
          );

          return;
        }

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

        await message.reply(
          `🔊 Joined **${channel.name}**.`
        );
      } catch (error) {
        console.error(
          "Join VC error:",
          error
        );

        await message.reply(
          "❌ Couldn't join the VC."
        );
      }

      return;
    }

    /* ================================================
       !hostfriendly
       
       IMPORTANT:
       Only ONE message is created.
       It gets edited when the lineup is complete.
    ================================================ */

    if (command === "hostfriendly") {
      if (!isFriendlyHoster(message)) {
        await message.reply(
          "❌ You need the Friendly Hoster role."
        );

        return;
      }

      if (
        activeFriendlies.has(
          message.channel.id
        )
      ) {
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

      const lineupMessage =
        await message.channel.send(
          [
            "**FRIENDLY LINEUP**",
            "",
            "React below to claim a position.",
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
        const emoji of POSITION_EMOJIS
      ) {
        await lineupMessage.react(
          emoji
        );
      }

      activeFriendlies.set(
        message.channel.id,
        {
          message: lineupMessage,
          lineup,
        }
      );

      await sendLog(
        `📋 Friendly started by ${message.author} in <#${message.channel.id}>.`
      );

      return;
    }

    /* ================================================
       !friendlylink
    ================================================ */

    if (command === "friendlylink") {
      if (!isFriendlyHoster(message)) {
        await message.reply(
          "❌ You need the Friendly Hoster role."
        );

        return;
      }

      const completed =
        completedFriendlies.get(
          message.channel.id
        );

      if (!completed) {
        await message.reply(
          "❌ There isn't a completed friendly lineup here."
        );

        return;
      }

      let sent = 0;
      let failed = 0;

      for (
        const userId of Object.values(
          completed.lineup
        )
      ) {
        if (!userId) continue;

        try {
          const member =
            await message.guild.members.fetch(
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

      await message.reply(
        `✅ Friendly link sent to **${sent}** players.\n❌ Failed: **${failed}**.`
      );

      return;
    }

    /* ================================================
       !endfriendly
    ================================================ */

    if (command === "endfriendly") {
      if (!isFriendlyHoster(message)) {
        await message.reply(
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

      try {
        await message.channel.bulkDelete(
          100,
          true
        );
      } catch (error) {
        console.error(
          "Purge error:",
          error
        );
      }

      return;
    }

    /* ================================================
       !result
    ================================================ */

    if (command === "result") {
      if (!isFriendlyHoster(message)) {
        await message.reply(
          "❌ You need the Friendly Hoster role."
        );

        return;
      }

      const opponent = args[0];
      const score = args[1];
      const outcome =
        args[2]?.toUpperCase();
      const details =
        args.slice(3).join(" ");

      if (
        !opponent ||
        !score ||
        !["WIN", "DRAW", "LOSS"].includes(
          outcome
        )
      ) {
        await message.reply(
          "Usage: `!result <opponent> <score> <win/draw/loss> [details]`"
        );

        return;
      }

      const channel =
        await client.channels.fetch(
          RESULTS_CHANNEL_ID
        );

      if (!channel?.isTextBased()) {
        await message.reply(
          "❌ Results channel not found."
        );

        return;
      }

      let title =
        "⚽ MATCH RESULT";

      if (outcome === "WIN") {
        title = "🏆 MATCH WIN";
      }

      if (outcome === "DRAW") {
        title = "🤝 MATCH DRAW";
      }

      if (outcome === "LOSS") {
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
          .setTimestamp();

      if (details) {
        embed.addFields({
          name: "Details",
          value: details,
        });
      }

      await channel.send({
        embeds: [embed],
      });

      await message.reply(
        `✅ Result posted in <#${RESULTS_CHANNEL_ID}>.`
      );

      return;
    }

    /* ================================================
       !play
    ================================================ */

    if (command === "play") {
      const query =
        args.join(" ");

      if (!query) {
        await message.reply(
          "Usage: `!play <song or YouTube URL>`"
        );

        return;
      }

      if (
        !message.member?.voice?.channel
      ) {
        await message.reply(
          "❌ You need to be in a voice channel."
        );

        return;
      }

      try {
        const voiceChannel =
          message.member.voice.channel;

        const data =
          getMusicData(
            message.guild.id
          );

        if (!data.connection) {
          data.connection =
            await connectToVoice(
              voiceChannel
            );

          data.connection.subscribe(
            data.player
          );
        }

        data.textChannel =
          message.channel;

        const track =
          await getTrackFromQuery(
            query
          );

        const wasPlaying =
          !!data.current;

        data.queue.push(track);

        if (!wasPlaying) {
          await playNextTrack(
            message.guild.id
          );

          await message.reply(
            `▶️ Playing **${track.title}**`
          );
        } else {
          await message.reply(
            `✅ Added **${track.title}** to the queue.`
          );
        }
      } catch (error) {
        console.error(
          "Play error:",
          error
        );

        await message.reply(
          "❌ Couldn't play that."
        );
      }

      return;
    }

    /* ================================================
       !skip
    ================================================ */

    if (command === "skip") {
      const data =
        musicQueues.get(
          message.guild.id
        );

      if (
        !data?.current
      ) {
        await message.reply(
          "❌ Nothing is playing."
        );

        return;
      }

      data.player.stop();

      await message.reply(
        "⏭️ Skipped."
      );

      return;
    }

    /* ================================================
       !stop
    ================================================ */

    if (command === "stop") {
      const data =
        musicQueues.get(
          message.guild.id
        );

      if (!data) {
        await message.reply(
          "❌ Nothing is playing."
        );

        return;
      }

      data.queue = [];
      data.current = null;
      data.loop = false;

      data.player.stop();

      await message.reply(
        "⏹️ Music stopped and queue cleared."
      );

      return;
    }

    /* ================================================
       !loop
    ================================================ */

    if (command === "loop") {
      const data =
        getMusicData(
          message.guild.id
        );

      data.loop =
        !data.loop;

      await message.reply(
        data.loop
          ? "🔁 Loop is now **ON**."
          : "➡️ Loop is now **OFF**."
      );

      return;
    }

    /* ================================================
       !queue
    ================================================ */

    if (command === "queue") {
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
        await message.reply(
          "📭 Queue is empty."
        );

        return;
      }

      let text = "";

      if (data.current) {
        text +=
          `▶️ **Now Playing:** ${data.current.title}\n\n`;
      }

      if (data.queue.length) {
        text += data.queue
          .map(
            (track, index) =>
              `**${index + 1}.** ${track.title}`
          )
          .join("\n");
      } else {
        text +=
          "No songs waiting.";
      }

      await message.reply(text);

      return;
    }
  } catch (error) {
    console.error(
      "❌ Command error:",
      error
    );
  }
});

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

      const active =
        activeFriendlies.get(
          reaction.message.channelId
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

      const position =
        POSITION_NAMES[emoji];

      if (!position) return;

      /* Position already taken */
      if (
        active.lineup[position]
      ) {
        await reaction.users.remove(
          user.id
        );

        return;
      }

      /* Player already has a position */
      if (
        Object.values(
          active.lineup
        ).includes(user.id)
      ) {
        await reaction.users.remove(
          user.id
        );

        return;
      }

      /* Assign position */
      active.lineup[position] =
        user.id;

      /* ==============================================
         IMPORTANT:
         NO MESSAGE IS SENT HERE.
      ============================================== */

      const complete =
        Object.values(
          active.lineup
        ).every(Boolean);

      if (!complete) {
        return;
      }

      /* ==============================================
         ALL POSITIONS FILLED
         EDIT THE ORIGINAL MESSAGE
      ============================================== */

      const lineup =
        active.lineup;

      const finalMessage = [
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
        finalMessage
      );

      try {
        await active.message.reactions.removeAll();
      } catch {}

      completedFriendlies.set(
        reaction.message.channelId,
        {
          lineup: {
            ...lineup,
          },
          messageId:
            active.message.id,
        }
      );

      activeFriendlies.delete(
        reaction.message.channelId
      );

      await sendLog(
        `✅ Friendly lineup completed in <#${reaction.message.channelId}>.`
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
   ERRORS
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

/* =========================================================
   LOGIN
========================================================= */

console.log(
  "🚀 Starting erts United Bot..."
);

client.login(TOKEN);