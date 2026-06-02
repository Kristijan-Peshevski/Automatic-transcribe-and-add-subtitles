const form = document.getElementById('uploadForm');
const fileInput = document.getElementById('videoFile');
const video = document.getElementById('video');
const subtitleLine = document.getElementById('subtitleLine');
const transcriptText = document.getElementById('transcriptText');
const statusText = document.getElementById('statusText');
const downloadVttButton = document.getElementById('downloadVtt');
const transcribeButton = document.getElementById('transcribeBtn');
const subtitleColorInput = document.getElementById('subtitleColor');
const highlightColorInput = document.getElementById('highlightColor');
const useActiveWordColorInput = document.getElementById('useActiveWordColor');
const subtitleSizeInput = document.getElementById('subtitleSize');
const subtitleOffsetInput = document.getElementById('subtitleOffset');
const subtitleBackgroundInput = document.getElementById('subtitleBackground');
const subtitleBorderInput = document.getElementById('subtitleBorder');
const subtitleBorderColorInput = document.getElementById('subtitleBorderColor');
const subtitleBorderWidthInput = document.getElementById('subtitleBorderWidth');
const highlightBackgroundInput = document.getElementById('highlightBackground');
const highlightBackgroundColorInput = document.getElementById('highlightBackgroundColor');
const highlightBackgroundOpacityInput = document.getElementById('highlightBackgroundOpacity');
const subtitleFontInput = document.getElementById('subtitleFont');
const downloadVideoButton = document.getElementById('downloadVideo');

const state = {
  objectUrl: null,
  words: [],
  cues: [],
  transcript: '',
};

function setStatus(message) {
  statusText.textContent = message;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function hexToRgb(hex) {
  const normalized = hex.replace('#', '').trim();
  if (normalized.length !== 6) {
    return { red: 255, green: 183, blue: 3 };
  }

  return {
    red: Number.parseInt(normalized.slice(0, 2), 16),
    green: Number.parseInt(normalized.slice(2, 4), 16),
    blue: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

function formatTimestamp(seconds) {
  const total = Math.max(0, seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = Math.floor(total % 60);
  const millis = Math.round((total - Math.floor(total)) * 1000);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function clampEnd(cue, nextCue) {
  if (!nextCue) {
    return cue.end + 0.4;
  }

  return Math.max(cue.end, Math.max(cue.start + 0.18, nextCue.start - 0.02));
}

function buildVtt(cues) {
  const body = cues
    .map((cue, index) => {
      const nextCue = cues[index + 1] ?? null;
      const end = clampEnd(cue, nextCue);
      return `${index + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(end)}\n${cue.text}\n`;
    })
    .join('\n');

  return `WEBVTT\n\n${body}`;
}

function downloadText(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function findActiveCue(time) {
  return state.cues.find((cue) => time >= cue.start && time <= cue.end) ?? null;
}

function renderSubtitle() {
  if (!state.cues.length || !video.src) {
    subtitleLine.innerHTML = '';
    return;
  }

  const cue = findActiveCue(video.currentTime);
  if (!cue) {
    subtitleLine.innerHTML = '';
    return;
  }

  const activeWords = cue.words.filter((word) => word.start <= video.currentTime + 0.04);
  if (!activeWords.length) {
    subtitleLine.innerHTML = '';
    return;
  }

  const activeWord = [...activeWords].reverse().find((word) => video.currentTime >= word.start) ?? activeWords[activeWords.length - 1];
  const subtitleColor = subtitleColorInput.value;
  const highlightColor = highlightColorInput.value;
  const useActiveWordColor = useActiveWordColorInput.checked;
  const subtitleSize = subtitleSizeInput.value;
  const subtitleOffset = subtitleOffsetInput.value;
  const subtitleFont = subtitleFontInput.value;
  const hasBackground = subtitleBackgroundInput.checked;
  const hasBorder = subtitleBorderInput.checked;
  const hasHighlightBackground = highlightBackgroundInput.checked;
  const highlightBackgroundColor = highlightBackgroundColorInput.value;
  const highlightBackgroundOpacity = Number(highlightBackgroundOpacityInput.value) / 100;
  const subtitleBorderColor = subtitleBorderColorInput.value;
  const subtitleBorderWidth = subtitleBorderWidthInput.value;

  const { red, green, blue } = hexToRgb(highlightBackgroundColor);
  const highlightBackground = hasHighlightBackground ? `rgba(${red}, ${green}, ${blue}, ${highlightBackgroundOpacity})` : 'transparent';

  subtitleLine.style.setProperty('--subtitle-size', `${subtitleSize}rem`);
  subtitleLine.style.setProperty('--subtitle-bottom', `${subtitleOffset}px`);
  subtitleLine.style.setProperty('--subtitle-font', subtitleFont);
  subtitleLine.style.setProperty('--subtitle-background', hasBackground ? 'rgba(0, 0, 0, 0.42)' : 'transparent');
  subtitleLine.style.setProperty('--subtitle-border', hasBorder ? 'rgba(255, 255, 255, 0.22)' : 'transparent');
  subtitleLine.style.setProperty('--subtitle-shadow', hasBackground || hasBorder ? '0 16px 40px rgba(0, 0, 0, 0.3)' : 'none');
  subtitleLine.style.setProperty('--highlight-word-background', highlightBackground);
  subtitleLine.style.setProperty('--subtitle-border-color', subtitleBorderColor);
  subtitleLine.style.setProperty('--subtitle-border-width', `${subtitleBorderWidth}px`);

  subtitleLine.innerHTML = cue.words
    .map((word) => {
      const className = word === activeWord ? 'subtitle-word active' : 'subtitle-word';
      const wordColor = word === activeWord && useActiveWordColor ? highlightColor : subtitleColor;
      return `<span class="${className}" style="color:${wordColor}">${escapeHtml(word.text)}</span>`;
    })
    .join('');
}

function resetTranscript() {
  state.words = [];
  state.cues = [];
  state.transcript = '';
  transcriptText.textContent = 'Your transcript will appear here after the first run.';
  subtitleLine.innerHTML = '';
  downloadVttButton.disabled = true;
}

subtitleColorInput.addEventListener('input', renderSubtitle);
highlightColorInput.addEventListener('input', renderSubtitle);
useActiveWordColorInput.addEventListener('input', () => {
  highlightColorInput.disabled = !useActiveWordColorInput.checked;
  renderSubtitle();
});
subtitleSizeInput.addEventListener('input', renderSubtitle);
subtitleOffsetInput.addEventListener('input', renderSubtitle);
subtitleBackgroundInput.addEventListener('input', renderSubtitle);
subtitleBorderInput.addEventListener('input', renderSubtitle);
subtitleBorderColorInput.addEventListener('input', renderSubtitle);
subtitleBorderWidthInput.addEventListener('input', renderSubtitle);
highlightBackgroundInput.addEventListener('input', renderSubtitle);
highlightBackgroundColorInput.addEventListener('input', renderSubtitle);
highlightBackgroundOpacityInput.addEventListener('input', renderSubtitle);
subtitleFontInput.addEventListener('input', renderSubtitle);

highlightColorInput.disabled = !useActiveWordColorInput.checked;

fileInput.addEventListener('change', () => {
  const [file] = fileInput.files ?? [];

  if (!file) {
    return;
  }

  if (state.objectUrl) {
    URL.revokeObjectURL(state.objectUrl);
  }

  state.objectUrl = URL.createObjectURL(file);
  video.src = state.objectUrl;
  video.load();
  setStatus(`Loaded ${file.name}. Ready to transcribe.`);
  resetTranscript();
});

video.addEventListener('timeupdate', renderSubtitle);
video.addEventListener('seeked', renderSubtitle);
video.addEventListener('play', renderSubtitle);
video.addEventListener('pause', renderSubtitle);

downloadVttButton.addEventListener('click', () => {
  if (!state.cues.length) {
    return;
  }

  downloadText('subtitles.vtt', buildVtt(state.cues), 'text/vtt');
});

downloadVideoButton.addEventListener('click', async () => {
  const [file] = fileInput.files ?? [];

  if (!file || !state.cues.length) {
    setStatus('Transcribe a video first, then download the subtitled video.');
    return;
  }

  const formData = new FormData();
  formData.append('video', file);
  formData.append('cues', JSON.stringify(state.cues));
  formData.append('fontName', subtitleFontInput.value);
  formData.append('fontSize', String(Math.round(Number(subtitleSizeInput.value) * 28)));
  formData.append('subtitleColor', subtitleColorInput.value);
  formData.append('activeWordColor', highlightColorInput.value);
  formData.append('activeWordDifferentColor', String(useActiveWordColorInput.checked));
  formData.append('borderColor', subtitleBorderColorInput.value);
  formData.append('borderWidth', subtitleBorderWidthInput.value);
  formData.append('showBackground', String(subtitleBackgroundInput.checked));
  formData.append('showBorder', String(subtitleBorderInput.checked));

  downloadVideoButton.disabled = true;
  setStatus('Rendering the subtitled video. This may take a bit longer than the preview.');

  try {
    const response = await fetch('/api/render-video', {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error || 'Video rendering failed.');
    }

    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const originalName = file.name.replace(/\.[^.]+$/, '');
    anchor.href = objectUrl;
    anchor.download = `${originalName}-subtitled.mp4`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
    setStatus('Subtitled video is downloading.');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Video rendering failed.';
    setStatus(message);
  } finally {
    downloadVideoButton.disabled = false;
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  const [file] = fileInput.files ?? [];
  if (!file) {
    setStatus('Choose a video file first.');
    return;
  }

  const formData = new FormData();
  formData.append('video', file);

  transcribeButton.disabled = true;
  downloadVttButton.disabled = true;
  setStatus('Extracting audio and running the transcription model. The first run can take a little longer while the model downloads.');
  transcriptText.textContent = 'Transcribing...';
  subtitleLine.innerHTML = '';

  try {
    const response = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || 'Transcription failed.');
    }

    state.words = Array.isArray(payload.words) ? payload.words : [];
    state.cues = Array.isArray(payload.cues) ? payload.cues : [];
    state.transcript = String(payload.text ?? '');

    transcriptText.textContent = state.transcript || 'No speech was detected in this clip.';
    downloadVttButton.disabled = !state.words.length;
    downloadVideoButton.disabled = !state.words.length;
    setStatus(`Transcription ready. ${state.words.length} words detected.`);
    renderSubtitle();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Transcription failed.';
    setStatus(message);
    transcriptText.textContent = `The transcription could not be completed.\nReason: ${message}`;
  } finally {
    transcribeButton.disabled = false;
  }
});

resetTranscript();