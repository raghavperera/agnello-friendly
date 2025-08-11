/* Voice-moderation module for Discord bot (Node.js / ES modules) */
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { pipeline } from 'stream/promises';
import prism from 'prism-media';
import { 
  joinVoiceChannel,
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus
} from '@discordjs/voice';

// CONFIG - adjust to your setup:
const WHISPER_CLI = process.env.WHISPER_CLI || './build/bin/whisper-cli'; // path to whisper.cpp CLI
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small'; // or 'base.en', etc. (how you downloaded it)
const MUTED_ROLE_ID = '1404284095164448810';
const TRANSCRIPT_TMP_DIR = path.join(os.tmpdir(), 'vc-moderation');

// Make sure tmp dir exists
if (!fs.existsSync(TRANSCRIPT_TMP_DIR)) fs.mkdirSync(TRANSCRIPT_TMP_DIR, { recursive: true });

// A small banned-words list for demo (lowercase). Replace with your list.
const BANNED_WORDS = ['examplebadword', 'swear1', 'swear2']; // put lower-case words

function containsBannedWord(transcript) {
  const t = transcript.toLowerCase();
  for (const w of BANNED_WORDS) {
    // match whole words (basic)
    const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\b`, 'i');
    if (re.test(t)) return w;
  }
  return null;
}

/** recordSingleUser: subscribe to a user's audio, write WAV, run whisper, return transcript */
async function recordSingleUser(voiceConnection, userId, guild, onTranscript) {
  try {
    const receiver = voiceConnection.receiver;

    // Subscribe to this user's Opus stream. We'll end after silence by EndBehaviorType
    const opusStream = receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1200 // ms silence before closing chunk
      }
    });

    // Prism decode Opus -> PCM s16le @ 48000 (Discord uses 48k)
    const opusDecoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });

    // Prepare ffmpeg to convert 48k stereo s16le -> 16k mono wav file (whisper.cpp needs 16k 16-bit)
    const tmpFile = path.join(TRANSCRIPT_TMP_DIR, `vc_${Date.now()}_${userId}.wav`);
    const ffmpeg = spawn('ffmpeg', [
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', 'pipe:0',
      '-ar', '16000',
      '-ac', '1',
      '-y',
      tmpFile
    ], { stdio: ['pipe','ignore','inherit'] });

    // Pipe Opus -> OpusDecoder -> ffmpeg.stdin
    opusStream.pipe(opusDecoder).pipe(ffmpeg.stdin);

    // Wait for the ffmpeg process to finish (the opus stream will close on silence)
    await new Promise((resolve, reject) => {
      ffmpeg.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg exited with ${code}`));
      });
      ffmpeg.on('error', reject);
    });

    // Now run whisper.cpp CLI on the WAV file
    // whisper-cli -m models/ggml-small.bin -f file.wav  (adjust your paths/model)
    // You should have a script or path that knows the model location.
    const whisperArgs = ['-f', tmpFile, /* optionally other flags */];
    // If your whisper binary requires model flag, add it, e.g. ['-m','models/ggml-small.bin','-f', tmpFile]
    const whisper = spawn(WHISPER_CLI, whisperArgs);

    let out = '';
    whisper.stdout.on('data', d => { out += d.toString(); });
    whisper.stderr.on('data', d => { /* whisper prints progress to stderr — ignore or capture */ });

    await new Promise((resolve, reject) => {
      whisper.on('close', code => (code === 0) ? resolve() : reject(new Error(`whisper exited ${code}`)));
      whisper.on('error', reject);
    });

    // whisper-cli usually prints the transcription text on stdout (depends on your build/options)
    const transcript = out.trim();
    // call the handler
    await onTranscript(transcript, userId, tmpFile);

  } catch (err) {
    console.error('recordSingleUser error:', err);
  } finally {
    // cleanup file(s) optionally
    // fs.unlinkSync(tmpFile) try/catch if you want
  }
}

/** startListeningOnConnection: wire speaking start -> create recording */
function startListeningOnConnection(voiceConnection, guild) {
  // `receiver.speaking` or `voiceConnection.receiver.speaking` emits when a user starts/stops
  const receiver = voiceConnection.receiver;

  receiver.speaking.on('start', userId => {
    // Avoid recording bots
    if (userId === voiceConnection.joinConfig?.selfDeaf) return;

    // Start recording and transcribing this user's speech chunk
    recordSingleUser(voiceConnection, userId, guild, async (transcript, userId, tmpFile) => {
      if (!transcript) return;
      console.log(`Transcribed for ${userId}:`, transcript);

      const matched = containsBannedWord(transcript);
      if (!matched) return;

      // Fetch guild member and apply muted role
      try {
        const member = await guild.members.fetch(userId);
        if (!member) return;

        // check bot can manage role
        const botMember = guild.members.me; // discord.js v14+
        const mutedRole = guild.roles.cache.get(MUTED_ROLE_ID);
        if (!mutedRole) {
          console.warn('Muted role not found:', MUTED_ROLE_ID); return;
        }
        if (botMember.roles.highest.position <= mutedRole.position) {
          console.warn('Bot role too low to manage muted role');
          return;
        }

        // if member already has it, skip
        if (!member.roles.cache.has(MUTED_ROLE_ID)) {
          await member.roles.add(MUTED_ROLE_ID, `Auto-muted for saying banned word: ${matched}`);
        }

        // DM the user (best effort)
        try {
          await member.send(`You have been muted for saying "${matched}" in voice chat. You will be unmuted in 10 minutes.`).catch(()=>{});
        } catch {}

        // Schedule unmute in 10 minutes (600000 ms)
        setTimeout(async () => {
          try {
            const refreshed = await guild.members.fetch(userId);
            if (refreshed && refreshed.roles.cache.has(MUTED_ROLE_ID)) {
              await refreshed.roles.remove(MUTED_ROLE_ID, 'Auto-unmute after timeout');
            }
          } catch (e) { console.error('Error unmuting:', e); }
        }, 10 * 60 * 1000);
      } catch (e) {
        console.error('Error applying mute role:', e);
      }
    });
  });
}

/** Example: call this when you rightfully join voice with joinVoiceChannel(...) */
async function attachModerationToConnection(voiceConnection) {
  try {
    const guildId = voiceConnection.joinConfig.guildId;
    const guild = await voiceConnection.client.guilds.fetch(guildId);
    startListeningOnConnection(voiceConnection, guild);
  } catch (e) {
    console.error('attachModerationToConnection error', e);
  }
}