# LocalSub Landing Page

Single self-contained file: `index.html` (Tailwind CDN + vanilla JS, no build step).
Open it directly in a browser, or host the folder anywhere static.

## Activating downloads

Edit the `CONFIG` block near the bottom of `index.html`:

```js
const CONFIG = {
  REPO_URL:    "https://github.com/<owner>/localsub",
  RELEASE_URL: "https://github.com/<owner>/localsub/releases/latest",
  VERSION:     "v1.0.0",
  SIZE:        "약 48 MB",
};
```

Empty `RELEASE_URL` → the download buttons show "곧 출시 / Coming soon" (disabled).
Empty `REPO_URL` → the "GitHub에서 보기" links are hidden.

## Adding screenshots / video (media slots)

Every media slot has a graceful fallback: with nothing set, the page shows its
built-in design (cue card / waveform / icon cards). Drop files into this folder
(e.g. `landing/assets/`) and fill the `MEDIA` block in `index.html`:

```js
const MEDIA = {
  heroVideo:  "assets/hero-demo.mp4",   // replaces the hero cue card
  heroPoster: "assets/hero-poster.jpg", // shown before the video / if no video
  editor:     "assets/editor.png",      // editor cover still (big feature card)
  features: {
    speaker: "assets/speaker.png",
    batch:   "assets/batch.png",
    models:  "assets/models.png",
  },
};
```

`.mp4` / `.webm` / `.mov` are rendered as autoplaying muted loops; anything else as an image.

### Recommended captures (priority order)

| Slot | What to capture | Format | Ratio / size |
|---|---|---|---|
| `heroVideo` | Drop file → subtitles stream in → translation appears → export | MP4/WebM, muted, ~10–15s loop | **16:10**, ≥1280px wide, keep small (a few MB) |
| `editor` | Editor: waveform + subtitle list + speaker labels + dual language | PNG | **16:10**, ≥1600px wide |
| `features.speaker` | Speaker-labeled subtitle list | PNG | 16:10 |
| `features.batch` | Multiple files processing in the queue | PNG | 16:10 |
| `features.models` | Model manager with download progress | PNG | 16:10 |
| **OG image** | The editor cover still works well | PNG/JPG | **1200×630** (see below) |

Capture tips: use the app's **dark theme** (the page is dark), show **Korean + English**
together where possible, clean window chrome, slow clear cursor movement.

## Social preview (OG image)

Social/chat crawlers do **not** run JavaScript, so the OG image is a static tag in
`<head>` — not part of `MEDIA`. Put a `1200×630` image next to `index.html` as
`og-image.png` (or edit the path), and set `og:url` to the deployed URL.
