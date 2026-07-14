# Landing screenshot harness

Automated capture of the **real React app UI** for the landing page, with the
Tauri backend stubbed and curated fixture data. Touches no production source.

## What it produces

| File | Slot |
|---|---|
| `landing/assets/editor.png` | hero poster + `MEDIA.editor` (big feature card) |
| `landing/assets/speaker.png` | `MEDIA.features.speaker` (subtitle list, speaker labels) |
| `landing/assets/batch.png` | `MEDIA.features.batch` (job queue) |
| `landing/assets/models.png` | `MEDIA.features.models` (model manager) |
| `landing/og-image.png` | social preview (1200×630, cropped from editor) |

These are already wired into the `MEDIA` block of `landing/index.html`.

## How it works

- **`mock-init.js`** — injected via Playwright `addInitScript` before the app
  boots. Defines `window.__TAURI_INTERNALS__` so `@tauri-apps/api` `invoke` /
  `convertFileSrc` / event-listen resolve against in-page fixtures (config,
  dashboard jobs, subtitles, models, …) instead of a real Tauri backend.
- **`capture.mjs`** — starts Vite (real app), drives Chromium through the app
  (dashboard → settings/models → editor), and writes the stills + OG image.
  The sample clip is served via a Playwright route, so `convertFileSrc` can
  point anywhere and the **waveform is decoded from real audio**.
- **`gen-sample.mjs`** — regenerates `assets/sample.mp4` (needs ffmpeg).

## Run

```bash
node landing/shots/gen-sample.mjs   # once (or if sample.mp4 is missing)
node landing/shots/capture.mjs      # produces all 5 images
```

## Limitation

This is the genuine UI rendered with **curated mock data**, not a screenshot of
a real end-to-end pipeline run. That's intentional for clean marketing shots.
To keep one job visibly "processing" with a live progress bar you'd need the
real backend — the app flips saved `processing` jobs to `failed` on load
(restart recovery), so the fixtures use `completed`/`pending` only.
