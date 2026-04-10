// background.js — handles all OpenSubtitles API calls.
// Runs in the extension background page (MV2) or service worker (MV3).

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_API_KEY = '2lqB8Lx34EEBfcwNBJmrhIY262fpEZM3';
const API_BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'ArabicSubtitleOverlay v1.0';

// ── API key ───────────────────────────────────────────────────────────────────

function getApiKey() {
  return new Promise(resolve => {
    browserAPI.storage.local.get('osApiKey', result => {
      resolve(result.osApiKey || DEFAULT_API_KEY);
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
  }
});
