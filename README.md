# RoomTone TV EQ

A private, static TV equalizer assistant. The phone or laptop listens to two logarithmic sine sweeps from the normal seating position, averages their response, and suggests practical TV EQ changes. A synchronization burst aligns independent TV and phone clocks; a final pink-noise segment validates the capture.

## Deploy to GitHub Pages

1. Upload everything in this folder to a GitHub repository.
2. In **Settings → Pages**, choose **Deploy from a branch**.
3. Select the branch and `/ (root)`, then save.
4. Open the HTTPS Pages URL on the measuring device and allow microphone access.

The app has no server, analytics, account, or upload endpoint. Measurement summaries are saved only in browser local storage when the user chooses **Save on this device**.

## Calibration files

- `assets/roomtone-tv-calibration-youtube.mp4` — upload this directly to YouTube.
- `assets/roomtone-tv-calibration.wav` — lossless source/reference file.
- `assets/roomtone-tv-calibration.json` — exact signal timing and metadata.

Keep YouTube processing and playback quality at 720p or higher. Do not normalize or edit the audio before upload.

## Local preview

Serve the folder over HTTP rather than opening `index.html` directly. For example:

```sh
python -m http.server 4173
```

Microphone capture requires HTTPS in production; GitHub Pages provides it.
