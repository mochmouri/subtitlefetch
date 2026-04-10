# Arabic Subtitle Overlay

A Firefox-first browser extension that fetches Arabic subtitles from OpenSubtitles and overlays them directly on any streaming video — Netflix, YouTube, Disney+, and others.

Subtitles sync in real time with the video. They pause when the video pauses, seek when you seek, and stay positioned over the video in fullscreen.

> **Private repository.** This repo is private. The OpenSubtitles API key is stored locally in your browser's `storage.local` only — it is never written into the source code or committed to the repository.

---

## Getting an OpenSubtitles API key

1. Create a free account at [opensubtitles.com](https://www.opensubtitles.com)
2. Go to your profile → API section → generate a consumer key
3. Free tier: 5 subtitle downloads per day

After installing, open the extension popup, click ⚙ Settings, and paste your API key. It is saved to browser storage on your device only — it never leaves the browser and is not present in any source file.

---

## Loading in Firefox

1. Open Firefox and go to `about:debugging`
2. Click **This Firefox** in the left sidebar
3. Click **Load Temporary Add-on…**
4. Navigate to the `subtitlefetch/` folder and select `manifest.json`

The extension loads until Firefox restarts. To make it permanent, it would need to be signed via AMO (addons.mozilla.org).

---

## Loading in Chrome / Chromium

1. Rename `manifest.chromium.json` to `manifest.json` (back up the original first)
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top right toggle)
4. Click **Load unpacked** and select the `subtitlefetch/` folder

Note: Chrome MV3 service workers do not persist between popup opens — the extension still works but may have slightly slower first responses.

---

## How to use

1. Navigate to a streaming page with a video playing (Netflix, YouTube, etc.)
2. Click the extension icon in the toolbar
3. The search box is pre-filled with the page title — edit it if needed
4. Click **Search** — results from OpenSubtitles will appear
5. Click a result to download and load the subtitles onto the video
6. If the subtitles are out of sync, drag the **Sync offset** slider

To remove subtitles, click the **Remove** button in the popup.

---

## Sync offset

The slider adjusts timing from −10 s to +10 s in 0.5 s steps.

- If subtitles appear **too early**, drag the slider **left** (negative)
- If subtitles appear **too late**, drag the slider **right** (positive)

The last offset is remembered between popup opens.

---

## Changing the API key

Click the ⚙ settings button in the popup header, paste your key, and click Save.

---

## File structure

```
subtitlefetch/
  manifest.json              Firefox MV2
  manifest.chromium.json     Chrome MV3 variant
  popup/
    popup.html               Extension popup
    popup.css                Popup styles
    popup.js                 Popup logic — search, download, orchestration
  content/
    content.js               Injected into streaming pages — overlay and sync
    overlay.css              Subtitle text appearance
  background/
    background.js            OpenSubtitles API calls (background page / service worker)
  utils/
    srt-parser.js            Parses SRT text into cue objects
    time-utils.js            Converts SRT timestamps to seconds
  icons/
    icon.svg                 Extension icon (SVG; replace with PNG for Chrome if needed)
```

---

## Known limitations

- **Cross-origin iframes**: some players (e.g. embedded YouTube in third-party sites) run in a separate iframe origin. The content script cannot access those iframes.
- **DRM overlays**: on heavily protected players, the video element may be hidden behind a canvas or native layer. Subtitles will still appear but may be obscured.
- **Download quota**: the free OpenSubtitles tier allows 5 downloads per day per API key. The popup shows the remaining count after each download.
- **Format**: only SRT is fully supported. VTT usually works too since the timestamp format is similar.
- **SPA navigation**: on single-page apps (Netflix, YouTube), navigating to a new title without a page reload will not auto-clear the subtitles — click Remove and search again.
