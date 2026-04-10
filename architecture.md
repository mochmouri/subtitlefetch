# Architecture — Arabic Subtitle Overlay

## Overview

Most Arabic-language streaming content lacks good subtitle support in Western apps. Netflix and YouTube occasionally provide Arabic subtitles, but they are often absent for older content, regional releases, or less mainstream titles. OpenSubtitles is a large community-maintained subtitle database with solid Arabic coverage, but it has no native integration with streaming players.

This extension bridges that gap. It lets you search OpenSubtitles directly from your browser toolbar, download a subtitle file, and have it appear overlaid on whatever video is playing on the current page — with real-time sync, adjustable timing, and no changes required to the streaming site itself.

The core challenge is that browser extensions cannot modify how streaming sites render their video players. Instead, the extension injects its own transparent overlay div that sits on top of the page, tracks the position of the video element, and updates the displayed subtitle text in sync with playback. The streaming site is unaware any of this is happening.

---

## Extension Components

A browser extension is made up of several distinct execution contexts that run in different environments and communicate by passing messages. Understanding why each part exists where it does is key to understanding the architecture.

### The Manifest

`manifest.json` is the extension's declaration file. It tells Firefox what the extension is called, what permissions it needs, which files to load as background scripts or content scripts, and what to show in the browser toolbar popup. Without the manifest, Firefox would not know the extension exists.

The manifest requests three meaningful permissions. `storage` allows the extension to save settings and history locally in the browser. `tabs` allows the popup to read the title of the active tab (used to pre-fill the search box). `<all_urls>` allows the content script to be injected into any website, which is necessary because the extension has no way of knowing in advance which streaming sites a user will visit.

There is also a `manifest.chromium.json` for Chrome — explained in its own section below.

### The Popup

The popup (`popup/popup.html`, `popup.css`, `popup.js`) is the small UI that appears when you click the extension icon in the toolbar. It lives in its own isolated browser context — separate from both the page you are viewing and the background script.

The popup owns the user-facing logic: reading the active tab's title, sending search queries, displaying results, showing loaded subtitle state, managing the sync offset slider, and rendering the settings and history panels. It is the orchestrator. When the user clicks a result, the popup asks the background script to download the file, parses the result itself, and then passes the parsed cue data on to the content script.

The popup is destroyed and recreated every time it is opened or closed. It has no persistent memory of its own — anything that needs to survive between popup opens (the sync offset, appearance settings, history, API key) is stored in `browser.storage.local`.

### The Background Script

`background/background.js` runs persistently in the background as long as the extension is loaded. Its job is narrow but important: it is the only part of the extension that can make network requests to the OpenSubtitles API.

This separation exists because of cross-origin restrictions. Web pages (including content scripts injected into them) are subject to CORS — a browser security policy that blocks requests to foreign domains unless that domain explicitly permits them. Background scripts are not subject to the same restriction when the extension has the appropriate host permissions declared in its manifest. By routing all API calls through the background script, the extension avoids CORS entirely.

The background script also manages the API key, history storage, and history pruning. It runs on extension load, which makes it a natural place to perform the cleanup of history entries older than seven days.

### The Content Script

`content/content.js` is injected directly into the web page you are watching. It runs in the same visual context as the page — it can read the DOM, find the video element, and add new elements to the page. However, it runs in an isolated JavaScript scope, meaning it cannot access the page's own JavaScript variables and the page cannot access the extension's variables.

The content script's job is purely presentational: create and manage the subtitle overlay div, track the video's position on screen, run the animation loop that reads the video's current playback time, and display the correct subtitle text at the correct moment.

It receives its cue data from the popup via message passing — it does not fetch anything from the network itself.

### Utils

`utils/srt-parser.js` and `utils/time-utils.js` are shared utility modules. They have no extension-specific logic — they just parse SRT subtitle files into structured data. They are imported by the popup (which runs as an ES module and can use `import`), making the parsing happen in the popup process rather than the content script, which keeps the content script lighter.

---

## Message Passing Flow

Because the popup, background script, and content script run in separate execution contexts, they cannot call each other's functions directly. Instead, they communicate by sending messages — structured objects passed through the browser's extension messaging system. A message has an `action` field describing what to do, plus any relevant data. The recipient handles it asynchronously and sends back a response.

The full flow from a user search to subtitles appearing on screen proceeds as follows.

When the user types a title and clicks Search, the popup sends a `searchSubtitles` message to the background script. The background script calls the OpenSubtitles `/subtitles` API endpoint and returns a list of results. The popup renders these as a clickable list.

When the user clicks a result, the popup sends a `downloadSubtitle` message with the file ID to the background script. The background script calls the OpenSubtitles `/download` endpoint, which returns a temporary URL for the actual subtitle file. The background script fetches that file and returns its raw text content to the popup.

The popup then parses the raw SRT text into an array of cue objects — each cue has a start time, end time, and text. This parsing happens in the popup, not the content script, to keep the content script's responsibilities minimal.

Finally, the popup sends a `loadSubtitles` message to the content script running in the active tab, including the full array of cue objects. The content script stores them, finds the video element, attaches the overlay, and begins the render loop.

If the content script is not yet running in the tab (for example, if the page was already open before the extension was loaded), the popup catches the failed message, programmatically injects the content script and its CSS, waits briefly for it to initialise, and retries the message.

---

## Video Detection and Overlay

When the content script loads, it immediately scans the page for `<video>` elements. If multiple videos exist, it selects the one with the largest rendered area — the assumption being that the main player will be the largest. This heuristic works well in practice. It also sets a retry after 2.5 seconds to catch video elements that load after the page's initial render, which is common on single-page apps like Netflix and YouTube.

The overlay is a `<div>` with a fixed position layered above everything else on the page (using the maximum possible z-index value). It is styled using flexbox to pin its content to the bottom-centre of its bounding box, which is where subtitles conventionally appear. The overlay's position and dimensions are kept in sync with the video element using a `ResizeObserver`, which fires whenever the video element changes size, plus scroll and resize event listeners on the window for when the video moves without resizing. This means the subtitles follow the video whether the user resizes the browser window, scrolls the page, or the player changes layout.

When the user enters fullscreen, standard browser fullscreen behaviour places the fullscreen element in a separate compositing layer, which means fixed-position elements from the main document are no longer visible above it. The content script listens for the `fullscreenchange` event and responds by physically moving the overlay div inside the fullscreen element. Once inside, the overlay is switched from `position: fixed` to `position: absolute`, and its coordinates are recalculated relative to the video within the fullscreen context. When fullscreen exits, the overlay is moved back to `document.body`.

---

## Subtitle Sync Logic

SRT is a plain-text subtitle format. Each entry (called a cue) has a sequential index number, a timing line in the format `HH:MM:SS,mmm --> HH:MM:SS,mmm`, and one or more lines of text. The parser in `utils/srt-parser.js` splits the file on blank lines, finds the timing line in each block, converts both timestamps to plain seconds, strips any HTML formatting tags or ASS override codes that some subtitle files include, and produces a flat array of `{ index, start, end, text }` objects.

The render loop uses `requestAnimationFrame` — a browser API that calls a function on every display refresh, typically 60 times per second. On each frame, the loop reads the video element's `currentTime` property (the current playback position in seconds), adds the user's sync offset, and does a linear scan through the cue array to find a cue whose start–end window contains that time. If the cue text has changed since the last frame, the overlay is updated; if it has not changed, the DOM is left untouched to avoid unnecessary repaints.

Pause and seek are handled automatically by this design — there is no special handling required. When the video is paused, `currentTime` stops advancing, so the same cue (or no cue) is found on every frame and the overlay does not change. When the user seeks, `currentTime` jumps to a new value and the next frame immediately finds the correct cue for that position.

The sync offset slider allows the user to shift all subtitle timings forwards or backwards by up to ten seconds in half-second steps. The offset is applied at lookup time — it is added to `currentTime` before the cue search — so changing it takes effect on the next rendered frame without any need to re-parse the subtitle file.

---

## Settings and Storage

Everything that needs to persist beyond a single popup session is saved to `browser.storage.local` — the browser's built-in key-value store for extension data. This storage is local to the user's device and is not synced to any server.

The extension stores four things: the OpenSubtitles API key (`osApiKey`), the last-used sync offset (`subtitleOffset`), the subtitle history (`subHistory`), and the appearance settings (`subAppearance`).

Appearance settings cover font size, text colour, background opacity, font family, and whether to apply a text shadow. They are saved to storage every time the user moves a slider, picks a colour, or changes a dropdown in the settings panel — with no explicit save button, so the experience feels immediate.

The content script applies appearance settings by reading them from storage when it first loads, and then listening to `browser.storage.onChanged` for subsequent changes. This is a storage change event that fires in all extension contexts whenever a storage value is written. When the popup saves new appearance settings, the content script's listener fires automatically, updates its in-memory appearance state, and forces the next animation frame to re-render the overlay with the new styles. The effect is that dragging the font size slider in the popup updates the subtitle text on screen in real time, with no explicit communication between the popup and content script required.

Appearance values are applied to subtitle span elements using `element.style.setProperty(property, value, 'important')`. The `important` flag is necessary because the overlay CSS stylesheet already uses `!important` declarations to prevent streaming sites' CSS from overriding the subtitle styles — and inline styles without the flag cannot override `!important` stylesheet rules.

---

## History System

Every time a subtitle is successfully downloaded and applied, the popup saves a history entry to `browser.storage.local`. Each entry stores the show or film title, the subtitle filename, the language code, the source URL, a Unix timestamp, and the full raw SRT text of the downloaded file.

Storing the raw SRT text is a deliberate choice. OpenSubtitles enforces a download quota on free accounts (five files per day). If the history stored only metadata, re-applying a subtitle from history would require a fresh download and consume quota. By storing the content itself, re-applying from history is completely free — the popup parses the stored SRT text and sends it to the content script exactly as it would a fresh download.

The history is capped at fifty entries to avoid filling storage. Within those fifty entries, entries are deduplicated by filename — if the same subtitle file is applied again, the old entry is replaced with a fresh one at the top of the list rather than accumulating duplicates.

History pruning runs in two places: in the background script each time the extension loads (which removes stale entries before any user interaction), and implicitly in the `getHistory` function which always filters before returning results. Entries older than seven days are considered stale and are discarded.

---

## API Integration

OpenSubtitles provides a REST API. Searching uses a GET request to `/subtitles` with the title as a query parameter and `languages=ar` to filter for Arabic results. The response is a JSON array of subtitle metadata objects, each containing details about the film or show, the release name, download count, and an array of files with their numeric IDs.

Downloading uses a two-step process. First, a POST request to `/download` with a file ID returns a temporary signed URL pointing to the actual subtitle file, along with the remaining download quota for the day. Second, a plain GET request to that URL fetches the raw subtitle text. The two-step design is the API's own — the temporary URL approach means download counts can be tracked on the API side even though the file itself is served from a CDN.

All of this runs in the background script rather than the content script or popup for the CORS reason described earlier. The background script has `<all_urls>` host permission, which means Firefox allows it to make requests to any domain. The popup and content script do not have this permission and would be blocked.

The API key is stored exclusively in `browser.storage.local` and is never written into any source file. When the user first installs the extension, no key is configured and any attempt to search will return a clear error message prompting them to add one via the settings panel. The key is read from storage at the time of each request in the background script and placed in the `Api-Key` request header. It is never logged, never passed to the content script, and is not visible in any part of the UI other than the settings input where the user typed it.

---

## Why Firefox MV2

Browser extensions come in two manifest versions: Manifest V2 (MV2) and Manifest V3 (MV3). MV3 is a newer standard introduced by Google that imposes additional restrictions — most significantly, it replaces persistent background pages with short-lived service workers that can be stopped by the browser at any time between events.

This extension targets Firefox as its primary browser and uses MV2. Firefox supports MV2 fully and has indicated it will continue to do so. MV2 background pages are persistent, which simplifies the history pruning logic (it runs once on load and is guaranteed to complete) and avoids the subtle bugs that arise from service workers being terminated mid-operation.

A `manifest.chromium.json` file is included for users who want to load the extension in Chrome or Chromium-based browsers. It uses MV3 with a service worker instead of a background page and adds the `scripting` permission required for programmatic content script injection under MV3. The functional behaviour is identical, but the service worker may be stopped and restarted between popup opens, which can cause slightly slower first responses on some machines.

---

## Known Limitations and Future Considerations

The extension injects its content script into all frames on a page (`all_frames: true` in the manifest), which covers most embedded video players. However, cross-origin iframes — iframes that load content from a different domain than the parent page — present a harder problem. When a YouTube video is embedded on a third-party site, the iframe is served from `youtube.com` while the parent page may be on a completely different domain. The popup's `sendMessage` call targets the top-level tab by default and will not reach a content script running inside a cross-origin iframe. Solving this properly would require querying all frames via `browser.webNavigation.getAllFrames` and sending the message to each frame by ID.

Some streaming services use a Content Security Policy (CSP) — a security header that restricts what can be injected into their pages. On most sites this is not a problem because the extension injects a simple div with no external resources. However, very aggressive CSP configurations could potentially prevent the overlay CSS from applying correctly. This has not been observed in practice on major streaming services.

On heavily protected players — particularly those that use a canvas element or native DRM rendering layer on top of the video — the subtitle overlay may be obscured despite having the highest possible z-index. This is a fundamental limitation of the browser's rendering model and cannot be worked around from an extension context.

Single-page app navigation (common on Netflix and YouTube) does not trigger a full page reload when you move from one title to another. The content script remains alive across navigation, which means subtitles from a previous title can persist on a new one if the user does not click Remove first. A future improvement would be to listen for URL change events and automatically clear any loaded subtitles when navigation is detected.

The SRT parser also accepts VTT (WebVTT) files with minor differences in timestamp format, since the timestamp parsing function handles both the comma and dot separator variants. Full VTT support — including cue settings, region definitions, and chapter markers — is not implemented.
