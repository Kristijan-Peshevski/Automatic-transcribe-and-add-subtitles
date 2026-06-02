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
    transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-base');
  }

  return transcriberPromise;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const errorMessage = stderr.trim() || `Command failed with exit code ${code}`;
      reject(new Error(errorMessage));
    });
  });
}

async function extractAudio(videoPath, audioPath) {
  const ffmpegExecutable = ffmpegPath || 'ffmpeg';
  
  try {
    // Attempt direct extraction
    await runCommand(ffmpegExecutable, [
      '-y',
      '-err_detect',
      'ignore_err',
      '-fflags',
      '+discardcorrupt',
      '-i',
      videoPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-max_error_rate',
      '1.0',
      '-f',
      'wav',
      audioPath,
    ]);
  } catch (directError) {
    console.warn('Direct audio extraction failed. Checking if partial audio was written...', directError.message);
    
    // Check if a substantial audio file was already written before the crash
    try {
      const stats = await import('fs/promises').then(({ stat }) => stat(audioPath));
      if (stats.size > 10240) {
        console.warn(`Partial audio file found (${stats.size} bytes). Fixing WAV headers and continuing...`);
        const tempWavPath = audioPath.replace(/\.wav$/, '.temp.wav');
        await import('fs/promises').then(({ rename }) => rename(audioPath, tempWavPath));
        await runCommand(ffmpegExecutable, [
          '-y',
          '-i',
          tempWavPath,
          '-c:a',
          'copy',
          audioPath,
        ]);
        await rm(tempWavPath, { force: true }).catch(() => {});
        return; // Success!
      }
    } catch (statError) {
      console.warn('No substantial partial audio file found. Trying two-step fallback...');
    }

    // Fallback: Extract raw stream first to strip buggy container metadata, then decode
    const tempAacPath = audioPath.replace(/\.wav$/, '.aac');
    try {
      // Step 1: Copy audio stream to raw AAC file without decoding (safe from decoder aborts)
      await runCommand(ffmpegExecutable, [
        '-y',
        '-i',
        videoPath,
        '-vn',
        '-c:a',
        'copy',
        tempAacPath,
      ]);

      // Step 2: Decode raw AAC file to target WAV file
      await runCommand(ffmpegExecutable, [
        '-y',
        '-err_detect',
        'ignore_err',
        '-fflags',
        '+discardcorrupt',
        '-i',
        tempAacPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-max_error_rate',
        '1.0',
        '-f',
        'wav',
        audioPath,
      ]);
    } catch (fallbackError) {
      // If even fallback fails, check if fallback wrote a partial wav file
      try {
        const stats = await import('fs/promises').then(({ stat }) => stat(audioPath));
        if (stats.size > 10240) {
          console.warn(`Fallback produced a partial audio file (${stats.size} bytes). Fixing WAV headers and continuing...`);
          const tempWavPath = audioPath.replace(/\.wav$/, '.temp.wav');
          await import('fs/promises').then(({ rename }) => rename(audioPath, tempWavPath));
          await runCommand(ffmpegExecutable, [
            '-y',
            '-i',
            tempWavPath,
            '-c:a',
            'copy',
            audioPath,
          ]);
          await rm(tempWavPath, { force: true }).catch(() => {});
          return; // Success!
        }
      } catch (fallbackStatError) {}

      throw new Error(`Audio extraction failed.\nDirect method error: ${directError.message}\nFallback method error: ${fallbackError.message}`);
    } finally {
      // Clean up the temporary raw AAC file if it was created
      await rm(tempAacPath, { force: true }).catch(() => {});
    }
  }
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

function escapeAssText(text) {
  return String(text)
    .replaceAll('{', '\\{')
    .replaceAll('}', '\\}')
    .replaceAll(/\r?\n/g, ' ');
}

function formatAssTime(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const centiseconds = Math.floor((total - Math.floor(total)) * 100);

  return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}`;
}

function toAssColor(hex) {
  const normalized = String(hex || '#ffffff').replace('#', '').trim();
  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);
  const safeRed = Number.isFinite(red) ? red : 255;
  const safeGreen = Number.isFinite(green) ? green : 255;
  const safeBlue = Number.isFinite(blue) ? blue : 255;
  
  const bHex = safeBlue.toString(16).padStart(2, '0').toUpperCase();
  const gHex = safeGreen.toString(16).padStart(2, '0').toUpperCase();
  const rHex = safeRed.toString(16).padStart(2, '0').toUpperCase();
  
  return `&H00${bHex}${gHex}${rHex}&`;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  }

  return fallback;
}

function buildAssFile(cues, options) {
  const {
    fontName,
    fontSize,
    subtitleColor,
    activeWordColor,
    borderColor,
    borderWidth,
    activeWordDifferentColor,
    showBackground,
    showBorder,
  } = options;

  const outlineWidth = borderWidth;
  const borderStyle = showBackground ? 3 : 1;
  const backColour = showBackground ? '&H7F000000&' : '&H00000000&';
  const primaryColour = toAssColor(subtitleColor);
  const secondaryColour = toAssColor(subtitleColor);
  const outlineColour = toAssColor(borderColor);
  const style = [
    'Style: Default',
    fontName,
    fontSize,
    primaryColour,
    secondaryColour,
    outlineColour,
    backColour,
    '0',
    '0',
    '0',
    '0',
    '100',
    '100',
    '0',
    '0',
    String(borderStyle),
    String(outlineWidth),
    '1',
    '2',
    '30',
    '30',
    '42',
    '1',
  ].join(',');

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1920',
    'PlayResY: 1080',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    style,
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
  ];

  const events = [];

  for (const cue of cues) {
    if (activeWordDifferentColor && Array.isArray(cue.words) && cue.words.length > 0) {
      const activeWordAssColor = toAssColor(activeWordColor);
      const defaultAssColor = toAssColor(subtitleColor);

      for (let i = 0; i < cue.words.length; i++) {
        const activeWord = cue.words[i];
        
        // Start time of this word highlight interval
        const startSec = i === 0 ? cue.start : activeWord.start;
        
        // End time of this word highlight interval
        const nextWord = cue.words[i + 1];
        const endSec = nextWord ? nextWord.start : Math.max(cue.end, activeWord.end);

        const start = formatAssTime(startSec);
        const end = formatAssTime(Math.max(endSec, startSec + 0.1));

        const textParts = cue.words.map((w) => {
          if (w === activeWord) {
            return `{\\c${activeWordAssColor}}${escapeAssText(w.text)}{\\c${defaultAssColor}}`;
          }
          return escapeAssText(w.text);
        });

        // Rejoin with spaces, fixing punctuation spacing if necessary
        const text = textParts.join(' ').replace(/\s+([.,!?;:…])/g, '$1');
        events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
      }
    } else {
      const start = formatAssTime(cue.start);
      const end = formatAssTime(Math.max(cue.end, cue.start + 0.2));
      const text = escapeAssText(cue.text || '');
      events.push(`Dialogue: 0,${start},${end},Default,,0,0,0,,${text}`);
    }
  }

  return `${header.join('\n')}\n${events.join('\n')}`;
}

function runRenderCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
    }

    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const errorMessage = stderr.trim() || `Video render failed with exit code ${code}`;
      reject(new Error(errorMessage));
    });
  });
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
    console.error('Transcription error details:', error);
    const message = error instanceof Error ? error.message : 'Transcription failed.';
    response.status(500).json({ error: message });
  } finally {
    await Promise.allSettled([
      rm(request.file.path, { force: true }),
      rm(workspace, { recursive: true, force: true }),
    ]);
  }
});

app.post('/api/render-video', upload.single('video'), async (request, response) => {
  if (!request.file) {
    response.status(400).json({ error: 'Please upload a video file.' });
    return;
  }

  const cuesRaw = String(request.body?.cues ?? '[]');
  let cues = [];

  try {
    cues = JSON.parse(cuesRaw);
  } catch (_error) {
    response.status(400).json({ error: 'Invalid subtitle cue payload.' });
    return;
  }

  if (!Array.isArray(cues) || cues.length === 0) {
    response.status(400).json({ error: 'No subtitle cues available for rendering.' });
    return;
  }

  const workspace = await mkdtemp(path.join(tmpdir(), 'subtitle-render-'));
  const assPath = path.join(workspace, 'subtitles.ass');
  const outputPath = path.join(workspace, 'subtitled.mp4');
  const ffmpegExecutable = ffmpegPath || 'ffmpeg';
  const fontName = String(request.body?.fontName || 'Segoe UI');
  const fontSize = Number(request.body?.fontSize || 48);
  const subtitleColor = String(request.body?.subtitleColor || '#F8FAFC');
  const activeWordColor = String(request.body?.activeWordColor || '#FFB703');
  const borderColor = String(request.body?.borderColor || '#000000');
  const borderWidth = Number(request.body?.borderWidth || 2);
  const activeWordDifferentColor = parseBoolean(request.body?.activeWordDifferentColor, true);
  const showBackground = parseBoolean(request.body?.showBackground, true);
  const showBorder = parseBoolean(request.body?.showBorder, false);

  try {
    const assFile = buildAssFile(cues, {
      fontName,
      fontSize,
      subtitleColor,
      activeWordColor,
      borderColor,
      borderWidth,
      activeWordDifferentColor,
      showBackground,
      showBorder,
    });

    await mkdir(workspace, { recursive: true });
    await import('fs/promises').then(({ writeFile }) => writeFile(assPath, assFile, 'utf8'));

    await runRenderCommand(ffmpegExecutable, [
      '-y',
      '-i',
      request.file.path,
      '-vf',
      'subtitles=subtitles.ass',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-preset',
      'veryfast',
      '-crf',
      '18',
      '-c:a',
      'copy',
      '-movflags',
      '+faststart',
      outputPath,
    ], { cwd: workspace });

    const downloadName = `${path.parse(request.file.originalname).name}-subtitled.mp4`;
    response.download(outputPath, downloadName, async () => {
      await Promise.allSettled([
        rm(request.file.path, { force: true }),
        rm(workspace, { recursive: true, force: true }),
      ]);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Video rendering failed.';
    response.status(500).json({ error: message });
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