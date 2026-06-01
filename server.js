import express from 'express';
import multer from 'multer';
import { pipeline } from '@huggingface/transformers';
import { mkdir, mkdtemp, readFile, rm } from 'fs/promises';
import path from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import ffmpegPath from 'ffmpeg-static';
import wavefile from 'wavefile';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const uploadDir = path.join(tmpdir(), 'subtitle-studio-uploads');

await mkdir(uploadDir, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(publicDir));

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 250 * 1024 * 1024,
  },
});

let transcriberPromise;

function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
  }

  return transcriberPromise;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed with exit code ${code}`));
    });
  });
}

async function extractAudio(videoPath, audioPath) {
  const ffmpegExecutable = ffmpegPath || 'ffmpeg';
  await runCommand(ffmpegExecutable, [
    '-y',
    '-i',
    videoPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    'wav',
    audioPath,
  ]);
}

async function loadAudioData(audioPath) {
  const buffer = await readFile(audioPath);
  const wav = new wavefile.WaveFile(buffer);
  wav.toBitDepth('32f');
  wav.toSampleRate(16000);

  let audioData = wav.getSamples();

  if (Array.isArray(audioData)) {
    if (audioData.length > 1) {
      const scalingFactor = Math.sqrt(2);

      for (let index = 0; index < audioData[0].length; index += 1) {
        audioData[0][index] = (scalingFactor * (audioData[0][index] + audioData[1][index])) / 2;
      }
    }

    audioData = audioData[0];
  }

  return audioData;
}

function normalizeTimestamp(timestamp) {
  if (Array.isArray(timestamp) && timestamp.length >= 2) {
    return {
      start: Number(timestamp[0] ?? 0),
      end: Number(timestamp[1] ?? timestamp[0] ?? 0),
    };
  }

  if (typeof timestamp === 'number') {
    return {
      start: timestamp,
      end: timestamp,
    };
  }

  return {
    start: 0,
    end: 0,
  };
}

function extractWords(transcription) {
  if (!Array.isArray(transcription?.chunks)) {
    return [];
  }

  return transcription.chunks
    .map((chunk) => {
      const text = String(chunk?.text ?? '').trim();
      if (!text) {
        return null;
      }

      const timestamps = normalizeTimestamp(chunk?.timestamp);
      return {
        text,
        start: timestamps.start,
        end: timestamps.end,
      };
    })
    .filter(Boolean);
}

function joinCueWords(words) {
  return words
    .map((word) => word.text)
    .join(' ')
    .replace(/\s+([.,!?;:…])/g, '$1');
}

function buildSentenceCues(words) {
  const cues = [];
  let current = [];

  const flush = () => {
    if (!current.length) {
      return;
    }

    cues.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      words: current,
      text: joinCueWords(current),
    });
    current = [];
  };

  for (const word of words) {
    if (!current.length) {
      current.push(word);
      continue;
    }

    const previous = current[current.length - 1];
    const gap = word.start - previous.end;
    current.push(word);

    if (/[.!?…]$/.test(word.text) || gap > 1 || current.length >= 14) {
      flush();
    }
  }

  flush();
  return cues;
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true });
});

app.post('/api/transcribe', upload.single('video'), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: 'Please upload a video file.' });
    return;
  }

  const workspace = await mkdtemp(path.join(tmpdir(), 'subtitle-job-'));
  const audioPath = path.join(workspace, 'audio.wav');

  try {
    await extractAudio(request.file.path, audioPath);
    const audioData = await loadAudioData(audioPath);

    const transcriber = await getTranscriber();
    const transcription = await transcriber(audioData, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    const words = extractWords(transcription);
    const cues = buildSentenceCues(words);

    response.json({
      text: String(transcription?.text ?? '').trim(),
      words,
      cues,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed.';
    response.status(500).json({ error: message });
  } finally {
    await Promise.allSettled([
      rm(request.file.path, { force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  }
});

async function listen(port) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);

    server.once('listening', () => {
      resolve(server);
    });

    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        server.close(() => {
          resolve(listen(port + 1));
        });
        return;
      }

      reject(error);
    });
  });
}

const preferredPort = Number(process.env.PORT || 3000);
const server = await listen(preferredPort);
const address = server.address();
const activePort = typeof address === 'object' && address ? address.port : preferredPort;

console.log(`Subtitle studio running at http://localhost:${activePort}`);