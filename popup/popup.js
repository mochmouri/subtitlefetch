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
const localFileInput    = document.getElementById('local-file-input');
const uploadLabel       = document.getElementById('upload-label');

// Header buttons
const historyBtn        = document.getElementById('history-btn');
const settingsBtn       = document.getElementById('settings-btn');

// Views
const mainView          = document.getElementById('main-view');
const historyView       = document.getElementById('history-view');
const settingsView      = document.getElementById('settings-view');

// History view
const historyList       = document.getElementById('history-list');
const historyEmpty      = document.getElementById('history-empty');
const closeHistoryBtn   = document.getElementById('close-history-btn');

// Settings — API key
const apiKeyInput       = document.getElementById('api-key-input');
const saveKeyBtn        = document.getElementById('save-key-btn');
const cancelSettingsBtn = document.getElementById('cancel-settings-btn');

// Settings — appearance
const fontSizeInput     = document.getElementById('font-size-input');
const fontSizeDisplay   = document.getElementById('font-size-display');
const textColorInput    = document.getElementById('text-color-input');
const bgOpacityInput    = document.getElementById('bg-opacity-input');
const bgOpacityDisplay  = document.getElementById('bg-opacity-display');
const fontFamilyInput   = document.getElementById('font-family-input');
const textShadowInput   = document.getElementById('text-shadow-input');

// ── Default appearance ─────────────────────────────────────────────────────────

const DEFAULT_APPEARANCE = {
  fontSize:   24,
  textColor:  '#ffffff',
  bgOpacity:  60,
  fontFamily: 'system',
  textShadow: false,
};

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

function cleanTitle(title) {
  return title
    .replace(
      /\s*[|\-–—]\s*(Netflix|YouTube|Disney\+|Hulu|Prime Video|Amazon Prime Video|Shahid|OSN|Watch Online|Stream|Full Episode|HD|4K|S\d+\s*E\d+|Season \d+|Episode \d+).*$/i,
      ''
    )
    .replace(/\s*\(?\d{4}\)?$/, '')
    .trim();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showView(view) {
  mainView.hidden    = view !== 'main';
  historyView.hidden = view !== 'history';
  settingsView.hidden = view !== 'settings';
}

function formatTimestamp(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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
    const fileName = attrs.files?.[0]?.file_name || 'subtitle.srt';
    const url      = attrs.url || '';

    if (!fileId) continue;

    const li = document.createElement('li');
    li.innerHTML = `
      <div class="result-title">${escapeHtml(title)}${year ? ` (${year})` : ''}</div>
      <div class="result-meta">${escapeHtml(release.slice(0, 60)) || '—'} &middot; ${downloads.toLocaleString()} dl</div>
    `;
    li.addEventListener('click', () => loadSubtitle(fileId, title, fileName, url));
    resultsList.appendChild(li);
  }

  resultsSection.hidden = false;
}

// ── Load subtitle ──────────────────────────────────────────────────────────────

async function loadSubtitle(fileId, title, fileName, sourceUrl) {
  setStatus('Downloading subtitle…');
  resultsSection.hidden = true;
  searchBtn.disabled = true;

  try {
    const dlRes = await sendToBackground({ action: 'downloadSubtitle', fileId });
    if (!dlRes.ok) throw new Error(dlRes.error);

    // Save to history immediately after download, regardless of whether apply succeeds
    sendToBackground({
      action: 'saveHistoryEntry',
      entry: {
        title,
        fileName:   dlRes.fileName || fileName,
        language:   'ar',
        sourceUrl:  sourceUrl || '',
        timestamp:  Date.now(),
        content:    dlRes.content,
      },
    }).catch(() => {});

    await applySubtitleContent(dlRes.content, title, dlRes.fileName || fileName);

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

/**
 * Parse and send subtitle content to the content script.
 * Used by both fresh downloads and history re-apply.
 */
async function applySubtitleContent(srtContent, title, fileName) {
  const cues = parseSRT(srtContent);
  if (!cues.length) {
    throw new Error('Could not parse subtitle file — possibly not SRT format.');
  }

  setStatus(`Parsed ${cues.length} cues. Loading…`);

  let contentRes;
  try {
    contentRes = await sendToContent({
      action: 'loadSubtitles',
      cues,
      offset: currentOffset,
    });
  } catch (_) {
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

  subtitlesLoaded = true;
  loadedName.textContent = `${title} — ${cues.length} cues`;
  loadedSection.hidden = false;
}

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

// ── History ────────────────────────────────────────────────────────────────────

async function showHistory() {
  showView('history');
  historyList.innerHTML = '';

  const res = await sendToBackground({ action: 'getHistory' });
  const entries = (res.ok && res.entries) ? res.entries : [];

  if (!entries.length) {
    historyEmpty.hidden = false;
    historyList.hidden  = true;
    return;
  }

  historyEmpty.hidden = true;
  historyList.hidden  = false;

  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `
      <div class="history-item-top">
        <span class="history-title">${escapeHtml(entry.title)}</span>
        <button class="history-reapply">Re-apply</button>
      </div>
      <div class="history-meta">${escapeHtml(entry.fileName)} &middot; ${formatTimestamp(entry.timestamp)}</div>
    `;
    li.querySelector('.history-reapply').addEventListener('click', async () => {
      showView('main');
      setStatus('Re-applying…');
      try {
        await applySubtitleContent(entry.content, entry.title, entry.fileName);
        setStatus('Re-applied from history.');
      } catch (err) {
        setStatus(`Error: ${err.message}`, true);
      }
    });
    historyList.appendChild(li);
  }
}

// ── Appearance settings ────────────────────────────────────────────────────────

async function loadAppearanceControls() {
  await new Promise(resolve => {
    browserAPI.storage.local.get('subAppearance', result => {
      const a = Object.assign({}, DEFAULT_APPEARANCE, result.subAppearance || {});
      fontSizeInput.value    = a.fontSize;
      fontSizeDisplay.textContent = `${a.fontSize}px`;
      textColorInput.value   = a.textColor;
      bgOpacityInput.value   = a.bgOpacity;
      bgOpacityDisplay.textContent = `${a.bgOpacity}%`;
      fontFamilyInput.value  = a.fontFamily;
      textShadowInput.checked = a.textShadow;
      resolve();
    });
  });
}

function readAppearanceControls() {
  return {
    fontSize:   parseInt(fontSizeInput.value, 10),
    textColor:  textColorInput.value,
    bgOpacity:  parseInt(bgOpacityInput.value, 10),
    fontFamily: fontFamilyInput.value,
    textShadow: textShadowInput.checked,
  };
}

function onAppearanceChange() {
  fontSizeDisplay.textContent  = `${fontSizeInput.value}px`;
  bgOpacityDisplay.textContent = `${bgOpacityInput.value}%`;
  const appearance = readAppearanceControls();
  browserAPI.storage.local.set({ subAppearance: appearance });
  // Content script picks up the change via storage.onChanged — no explicit message needed.
}

// ── Settings ───────────────────────────────────────────────────────────────────

async function showSettings() {
  const res = await sendToBackground({ action: 'getApiKey' });
  apiKeyInput.value = res.apiKey || '';
  await loadAppearanceControls();
  showView('settings');
}

async function saveApiKey() {
  const key = apiKeyInput.value.trim();
  if (!key) return;
  await sendToBackground({ action: 'setApiKey', apiKey: key });
  showView('main');
  setStatus('API key saved.');
}

// ── Local file upload ──────────────────────────────────────────────────────────

function handleLocalFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    const content = e.target.result;
    const title   = file.name.replace(/\.[^.]+$/, '');
    setStatus('Loading local file…');
    resultsSection.hidden = true;
    try {
      await applySubtitleContent(content, title, file.name);
      sendToBackground({
        action: 'saveHistoryEntry',
        entry: {
          title,
          fileName:  file.name,
          language:  'ar',
          sourceUrl: '',
          timestamp: Date.now(),
          content,
        },
      }).catch(() => {});
      setStatus('Loaded from local file.');
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
    }
  };
  reader.readAsText(file);
}

// ── Init ───────────────────────────────────────────────────────────────────────

async function init() {
  const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab.id;

  if (tab.title) {
    searchInput.value = cleanTitle(tab.title);
  }

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

  try {
    await sendToContent({ action: 'ping' });
  } catch (_) {}
}

// ── Event listeners ────────────────────────────────────────────────────────────

searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

uploadLabel.addEventListener('click', () => localFileInput.click());
localFileInput.addEventListener('change', () => handleLocalFile(localFileInput.files[0]));

removeBtn.addEventListener('click', removeSubtitles);
offsetSlider.addEventListener('input', onOffsetChange);

historyBtn.addEventListener('click', showHistory);
closeHistoryBtn.addEventListener('click', () => showView('main'));

settingsBtn.addEventListener('click', showSettings);
cancelSettingsBtn.addEventListener('click', () => showView('main'));
saveKeyBtn.addEventListener('click', saveApiKey);
apiKeyInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveApiKey(); });

fontSizeInput.addEventListener('input', onAppearanceChange);
textColorInput.addEventListener('input', onAppearanceChange);
bgOpacityInput.addEventListener('input', onAppearanceChange);
fontFamilyInput.addEventListener('change', onAppearanceChange);
textShadowInput.addEventListener('change', onAppearanceChange);

// Kick off
init().catch(err => setStatus(`Init error: ${err.message}`, true));
