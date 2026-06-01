# Subtitle Studio

Upload a video, transcribe the audio with a local Whisper model, preview the subtitles, and tune the subtitle and highlight colors.

## Features

- Video upload and preview.
- Automatic transcription with word-level timestamps.
- Subtitle overlay that reveals words as they are spoken.
- Subtitle text color and highlighted word color controls.
- WebVTT export.

## Run it

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start the app:

   ```bash
   npm start
   ```

3. Open `http://localhost:3000`.

## Notes

- The first transcription can take longer because the Whisper model is downloaded on demand.
- `ffmpeg-static` bundles the audio extraction binary, so there is no manual ffmpeg setup.