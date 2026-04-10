import { parseSRT } from '../utils/srt-parser.js';

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// ── State ──────────────────────────────────────────────────────────────────────

let activeTabId     = null;
let currentOffset   = 0;
let subtitlesLoaded = false;

// ── DOM refs ───────────────────────────────────────────────────────────────────

const searchInput       = document.getElementById('search-input');
const searchBtn         = document.getElementById('search-btn');
const statusBar         = document.getElementById('status-bar');
const resultsSection    = document.getElementById('results-section');
const resultsList       = document.getElementById('results-list');
const loadedSection     = document.getElementById('loaded-section');
const loadedName        = document.getElementById('loaded-name');
const removeBtn         = document.getElementById('remove-btn');
const offsetSlider      = document.getElementById('offset-slider');
const offsetDisplay     = document.getElementById('offset-display');
const settingsBtn       = document.getElementById('settings-btn');
const mainView          = document.getElementById('main-view');
const settingsView      = document.getElementById('settings-view');
const apiKeyInput       = document.getElementById('api-key-input');
const saveKeyBtn        = document.getElementById('save-key-btn');
const cancelSettingsBtn = document.getElementById('cancel-settings-btn');

// ── Messaging helpers ──────────────────────────────────────────────────────────

function sendToBackground(message) {
  return new Promise((resolve, reject) => {
    browserAPI.runtime.sendMessage(message, response => {
      if (browserAPI.runtime.lastError) {
        reject(new Error(browserAPI.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

function sendToContent(message) {
  return new Promise((resolve, reject) => {
    browserAPI.tabs.sendMessage(activeTabId, message, response => {
      if (browserAPI.runtime.lastError) {
        reject(new Error(browserAPI.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// ── UI helpers ─────────────────────────────────────────────────────────────────

function setStatus(msg, isError = false) {
  statusBar.textContent   = msg;
  statusBar.className     = isError ? 'error' : '';
}

function formatOffset(val) {
  const sign = val >= 0 ? '+' : '';
  return `${sign}${val.toFixed(1)} s`;
}

/**
 * Strip site-name suffixes from a tab title to get a clean search query.
 * e.g. "Inception | Netflix" → "Inception"
 */
function cleanTitle(title) {
  return title
    .replace(
      /\s*[|\-–—]\s*(Netflix|YouTube|Disney\+|Hulu|Prime Video|Amazon Prime Video|Shahid|OSN|Watch Online|Stream|Full Episode|HD|4K|S\d+\s*E\d+|Season \d+|Episode \d+).*$/i,
      ''
    )
    .replace(/\s*\(?\d{4}\)?$/, '')  // trailing year
    .trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Search ─────────────────────────────────────────────────────────────────────

async function doSearch() {
  const query = searchInput.value.trim();
  if (!query) return;

  setStatus('Searching…');
  searchBtn.disabled = true;
  resultsSection.hidden = true;
  resultsList.innerHTML = '';

  try {
    const res = await sendToBackground({ action: 'searchSubtitles', query });
    if (!res.ok) throw new Error(res.error);

    const { results } = res;
    if (!results.length) {
      setStatus('No Arabic subtitles found for that title.');
      return;
    }

    setStatus(`${results.length} result${results.length !== 1 ? 's' : ''} — click one to load.`);
    renderResults(results);

  } catch (err) {
    setStatus(`Search error: ${err.message}`, true);
  } finally {
    searchBtn.disabled = false;
  }
}

function renderResults(results) {
  resultsList.innerHTML = '';

  for (const item of results) {
    const attrs    = item.attributes || {};
    const details  = attrs.feature_details || {};
    const title    = details.title || attrs.movie_name || 'Unknown title';
    const year     = details.year  || '';
    const release  = attrs.release || '';
    const downloads = attrs.download_count ?? 0;
    const fileId   = attrs.files?.[0]?.file_id;

    if (!fileId) continue;

    const li = document.createElement('li');
    li.innerHTML = `
      <div class="result-title">${escapeHtml(title)}${year ? ` (${year})` : ''}</div>
      <div class="result-meta">${escapeHtml(release.slice(0, 60)) || '—'} &middot; ${downloads.toLocaleString()} dl</div>
    `;
    li.addEventListener('click', () => loadSubtitle(fileId, title));
    resultsList.appendChild(li);
  }

  resultsSection.hidden = false;
}

// ── Load subtitle ──────────────────────────────────────────────────────────────

async function loadSubtitle(fileId, title) {
  setStatus('Downloading subtitle…');
  resultsSection.hidden = true;
  searchBtn.disabled = true;

  try {
    // 1. Ask background to download the file
    const dlRes = await sendToBackground({ action: 'downloadSubtitle', fileId });
    if (!dlRes.ok) throw new Error(dlRes.error);

    // 2. Parse the SRT content in popup (no need to pass raw text to content script)
    const cues = parseSRT(dlRes.content);
    if (!cues.length) {
      throw new Error('Could not parse subtitle file — possibly not SRT format.');
    }

    setStatus(`Parsed ${cues.length} cues. Loading…`);

    // 3. Send cues to the content script
    let contentRes;
    try {
      contentRes = await sendToContent({
        action: 'loadSubtitles',
        cues,
        offset: currentOffset,
      });
    } catch (err) {
      // Content script may not be alive yet on this tab — try injecting it first
      await injectContentScript();
      contentRes = await sendToContent({
        action: 'loadSubtitles',
        cues,
        offset: currentOffset,
      });
    }

    if (!contentRes?.ok) {
      throw new Error(contentRes?.error || 'Content script did not respond.');
    }

    // 4. Update UI to loaded state
    subtitlesLoaded = true;
    loadedName.textContent = `${title} — ${cues.length} cues`;
    loadedSection.hidden = false;

    const note = dlRes.remaining != null
      ? `Loaded. ${dlRes.remaining} downloads remaining today.`
      : 'Loaded.';
    setStatus(note);

  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
    resultsSection.hidden = false;
  } finally {
    searchBtn.disabled = false;
  }
}

/** Programmatically inject content script for pages not already covered. */
async function injectContentScript() {
  await new Promise((resolve, reject) => {
    browserAPI.tabs.executeScript(activeTabId, { file: 'content/content.js' }, () => {
      if (browserAPI.runtime.lastError) reject(new Error(browserAPI.runtime.lastError.message));
      else resolve();
    });
  });
  await new Promise((resolve, reject) => {
    browserAPI.tabs.insertCSS(activeTabId, { file: 'content/overlay.css' }, () => {
      if (browserAPI.runtime.lastError) reject(new Error(browserAPI.runtime.lastError.message));
      else resolve();
    });
  });
  // Small pause to let the script initialise
  await new Promise(r => setTimeout(r, 150));
}

// ── Remove ─────────────────────────────────────────────────────────────────────

async function removeSubtitles() {
  try {
    await sendToContent({ action: 'removeSubtitles' });
  } catch (_) {}
  subtitlesLoaded = false;
  loadedSection.hidden = true;
  setStatus('Subtitles removed.');
}

// ── Offset ─────────────────────────────────────────────────────────────────────

function onOffsetChange() {
  currentOffset = parseFloat(offsetSlider.value);
  offsetDisplay.textContent = formatOffset(currentOffset);

  browserAPI.storage.local.set({ subtitleOffset: currentOffset });

  if (subtitlesLoaded) {
    sendToContent({ action: 'setOffset', offset: currentOffset }).catch(() => {});
  }
}

// ── Settings ───────────────────────────────────────────────────────────────────

async function showSettings() {
  const res = await sendToBackground({ action: 'getApiKey' });
  apiKeyInput.value = res.apiKey || '';
  mainView.hidden    = true;
  settingsView.hidden = false;
}

function hideSettings() {
  mainView.hidden     = false;
  settingsView.hidden = true;
}

async function saveApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  await sendToBackground({ action: 'setApiKey', apiKey: key });
  hideSettings();
  setStatus('API key saved.');
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  // Resolve active tab
  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab.id;

  // Pre-fill search from page title
  if (tab.title) {
    searchInput.value = cleanTitle(tab.title);
  }

  // Restore saved offset
  await new Promise(resolve => {
    browserAPI.storage.local.get('subtitleOffset', result => {
      if (result.subtitleOffset != null) {
        currentOffset = result.subtitleOffset;
        offsetSlider.value        = currentOffset;
        offsetDisplay.textContent = formatOffset(currentOffset);
      }
      resolve();
    });
  });

  // Quick ping to check content script is alive on this tab
  try {
    await sendToContent({ action: 'ping' });
  } catch (_) {
    // Not an error — script will be injected on-demand when subtitles are loaded
  }
}

// ── Event listeners ────────────────────────────────────────────────────────────

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

removeBtn.addEventListener('click', removeSubtitles);

offsetSlider.addEventListener('input', onOffsetChange);

settingsBtn.addEventListener('click', showSettings);
cancelSettingsBtn.addEventListener('click', hideSettings);
saveKeyBtn.addEventListener('click', saveApiKey);
apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey(); });

// Kick off
init().catch(err => setStatus(`Init error: ${err.message}`, true));
