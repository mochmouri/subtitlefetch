// background.js — handles all OpenSubtitles API calls.
// Runs in the extension background page (MV2) or service worker (MV3).

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const API_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'ArabicSubtitleOverlay v1.0';

// ── API key ───────────────────────────────────────────────────────────────────

function getApiKey() {
  return new Promise(resolve => {
    browserAPI.storage.local.get('osApiKey', result => {
      resolve(result.osApiKey || '');
    });
  });
}

// ── OpenSubtitles helpers ─────────────────────────────────────────────────────

async function apiHeaders() {
  return {
    'Api-Key': await getApiKey(),
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
}

/**
 * Search for Arabic subtitles matching `query`.
 * Returns the raw `data` array from the API response.
 */
async function searchSubtitles(query) {
  const key = await getApiKey();
  if (!key) throw new Error('No API key set. Click ⚙ Settings to add your OpenSubtitles key.');

  const params = new URLSearchParams({
    query,
    languages: 'ar',
    order_by: 'download_count',
    order_direction: 'desc',
    per_page: '10',
  });

  const res = await fetch(`${API_BASE}/subtitles?${params}`, {
    headers: await apiHeaders(),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Search failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = await res.json();
  return json.data || [];
}

/**
 * Request a download link for `fileId`, then fetch the subtitle file content.
 * Returns { content, fileName, remaining, message }.
 */
async function downloadSubtitle(fileId) {
  const key = await getApiKey();
  if (!key) throw new Error('No API key set. Click ⚙ Settings to add your OpenSubtitles key.');

  const res = await fetch(`${API_BASE}/download`, {
    method: 'POST',
    headers: await apiHeaders(),
    body: JSON.stringify({ file_id: fileId }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Download request failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = await res.json();

  if (!json.link) {
    // API may return an error message without a link (e.g. quota exceeded)
    throw new Error(json.message || 'No download link returned');
  }

  // Fetch the actual subtitle file from the temporary link
  const fileRes = await fetch(json.link);
  if (!fileRes.ok) {
    throw new Error(`Failed to fetch subtitle file (${fileRes.status})`);
  }

  const content = await fileRes.text();

  return {
    content,
    fileName: json.file_name || 'subtitle.srt',
    remaining: json.remaining ?? null,
    message: json.message || null,
  };
}

// ── History ───────────────────────────────────────────────────────────────────

const HISTORY_KEY    = 'subHistory';
const HISTORY_DAYS   = 7;
const HISTORY_MAX_MS = HISTORY_DAYS * 24 * 60 * 60 * 1000;

function pruneHistory(entries) {
  const cutoff = Date.now() - HISTORY_MAX_MS;
  return entries.filter(e => e.timestamp >= cutoff);
}

function getHistory() {
  return new Promise(resolve => {
    browserAPI.storage.local.get(HISTORY_KEY, result => {
      resolve(pruneHistory(result[HISTORY_KEY] || []));
    });
  });
}

function saveHistoryEntry(entry) {
  return new Promise(resolve => {
    browserAPI.storage.local.get(HISTORY_KEY, result => {
      const existing = pruneHistory(result[HISTORY_KEY] || []);
      // Deduplicate: remove any existing entry for the same fileName
      const filtered = existing.filter(e => e.fileName !== entry.fileName);
      const updated  = [entry, ...filtered].slice(0, 50); // cap at 50 entries
      browserAPI.storage.local.set({ [HISTORY_KEY]: updated }, resolve);
    });
  });
}

// Prune stale entries on background load
getHistory().then(clean => {
  browserAPI.storage.local.set({ [HISTORY_KEY]: clean });
});

// ── Message handler ───────────────────────────────────────────────────────────

browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case 'searchSubtitles':
      searchSubtitles(message.query)
        .then(results => sendResponse({ ok: true, results }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true; // keep channel open for async response

    case 'downloadSubtitle':
      downloadSubtitle(message.fileId)
        .then(data => sendResponse({ ok: true, ...data }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'getApiKey':
      getApiKey().then(apiKey => sendResponse({ apiKey }));
      return true;

    case 'setApiKey':
      browserAPI.storage.local.set({ osApiKey: message.apiKey }, () => {
        sendResponse({ ok: true });
      });
      return true;

    case 'saveHistoryEntry':
      saveHistoryEntry(message.entry)
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;

    case 'getHistory':
      getHistory()
        .then(entries => sendResponse({ ok: true, entries }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
  }
});
