// content.js — injected into streaming pages.
// Handles video detection, overlay creation, subtitle sync, and fullscreen.

(function () {
  'use strict';

  // Guard against double-injection
  if (window.__arabicSubOverlayLoaded) return;
  window.__arabicSubOverlayLoaded = true;

  const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

  // ── State ──────────────────────────────────────────────────────────────────

  let cues = [];          // [{ index, start, end, text }]
  let offset = 0;         // seconds, applied to currentTime before cue lookup
  let videoEl = null;
  let overlay = null;
  let rafId = null;
  let resizeObserver = null;
  let lastText = null;    // tracks last rendered text to avoid redundant DOM writes

  // ── Appearance ─────────────────────────────────────────────────────────────

  const DEFAULT_APPEARANCE = {
    fontSize:   24,
    textColor:  '#ffffff',
    bgOpacity:  60,
    fontFamily: 'system',
    textShadow: false,
  };

  let appearance = Object.assign({}, DEFAULT_APPEARANCE);

  const FONT_FAMILY_MAP = {
    system:        "'Cairo', 'Segoe UI', Tahoma, Arial, sans-serif",
    Arial:         'Arial, sans-serif',
    Georgia:       'Georgia, serif',
    'Courier New': "'Courier New', Courier, monospace",
    Verdana:       'Verdana, sans-serif',
  };

  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r}, ${g}, ${b}`;
  }

  function applyAppearanceToSpan(span) {
    const fontFamily = FONT_FAMILY_MAP[appearance.fontFamily] || FONT_FAMILY_MAP.system;
    const bgAlpha    = (appearance.bgOpacity / 100).toFixed(2);
    const rgb        = hexToRgb(appearance.textColor || '#ffffff');
    const shadow     = appearance.textShadow
      ? '1px 1px 3px rgba(0,0,0,0.9), -1px -1px 3px rgba(0,0,0,0.9)'
      : 'none';

    // Use setProperty with 'important' priority to beat the stylesheet's !important rules.
    span.style.setProperty('font-size',   `${appearance.fontSize}px`, 'important');
    span.style.setProperty('color',       `rgb(${rgb})`,              'important');
    span.style.setProperty('background',  `rgba(0,0,0,${bgAlpha})`,   'important');
    span.style.setProperty('font-family', fontFamily,                 'important');
    span.style.setProperty('text-shadow', shadow,                     'important');
  }

  function loadAppearance() {
    browserAPI.storage.local.get('subAppearance', result => {
      if (result.subAppearance) {
        appearance = Object.assign({}, DEFAULT_APPEARANCE, result.subAppearance);
      }
      // Invalidate last rendered text so next frame re-renders with new styles
      lastText = null;
    });
  }

  // ── Overlay ────────────────────────────────────────────────────────────────

  function createOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.id = 'arabic-sub-overlay';
    setOverlayPosition(false);
    document.body.appendChild(overlay);
  }

  function setOverlayPosition(insideFullscreen) {
    if (!overlay) return;
    overlay.style.cssText = [
      `position: ${insideFullscreen ? 'absolute' : 'fixed'}`,
      'pointer-events: none',
      'z-index: 2147483647',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'justify-content: flex-end',
      'padding-bottom: 3%',
      'box-sizing: border-box',
      'overflow: hidden',
      'left: 0',
      'top: 0',
    ].join('; ');
  }

  function updateOverlayRect() {
    if (!overlay || !videoEl) return;
    const rect = videoEl.getBoundingClientRect();
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;

    if (fsEl && fsEl !== document.body) {
      const fsRect = fsEl.getBoundingClientRect();
      overlay.style.left   = (rect.left - fsRect.left) + 'px';
      overlay.style.top    = (rect.top  - fsRect.top)  + 'px';
    } else {
      overlay.style.left = rect.left + 'px';
      overlay.style.top  = rect.top  + 'px';
    }

    overlay.style.width  = rect.width  + 'px';
    overlay.style.height = rect.height + 'px';
  }

  // ── Video detection ────────────────────────────────────────────────────────

  function findLargestVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return null;
    return videos.reduce((best, v) => {
      return v.offsetWidth * v.offsetHeight > best.offsetWidth * best.offsetHeight ? v : best;
    });
  }

  // ── Cue lookup ─────────────────────────────────────────────────────────────

  function findCue(t) {
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (t >= c.start && t <= c.end) return c;
    }
    return null;
  }

  // ── Render loop ────────────────────────────────────────────────────────────

  function renderFrame() {
    rafId = requestAnimationFrame(renderFrame);

    if (!videoEl || !overlay) return;

    updateOverlayRect();

    const cue  = findCue(videoEl.currentTime + offset);
    const text = cue ? cue.text : '';

    if (text === lastText) return;
    lastText = text;

    overlay.innerHTML = '';
    if (!text) return;

    text.split('\n').forEach(line => {
      if (!line.trim()) return;
      const span = document.createElement('span');
      span.className = 'arabic-sub-line';
      span.textContent = line;
      applyAppearanceToSpan(span);
      overlay.appendChild(span);
    });
  }

  function startRender() {
    if (rafId) return;
    rafId = requestAnimationFrame(renderFrame);
  }

  function stopRender() {
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (overlay) overlay.innerHTML = '';
    lastText = null;
  }

  // ── Attach to video ────────────────────────────────────────────────────────

  function attach(video) {
    videoEl = video;
    createOverlay();

    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(updateOverlayRect);
    resizeObserver.observe(video);

    window.addEventListener('scroll', updateOverlayRect, { passive: true });
    window.addEventListener('resize', updateOverlayRect, { passive: true });

    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);

    startRender();
  }

  // ── Fullscreen ─────────────────────────────────────────────────────────────

  function onFullscreenChange() {
    if (!overlay) return;
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;

    if (fsEl && fsEl.contains(videoEl)) {
      setOverlayPosition(true);
      fsEl.appendChild(overlay);
    } else {
      setOverlayPosition(false);
      document.body.appendChild(overlay);
    }
    updateOverlayRect();
  }

  // ── Storage listener (appearance changes) ─────────────────────────────────

  browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.subAppearance) {
      appearance = Object.assign({}, DEFAULT_APPEARANCE, changes.subAppearance.newValue || {});
      lastText = null; // force re-render on next RAF tick
    }
  });

  // ── Message listener ───────────────────────────────────────────────────────

  browserAPI.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    switch (message.action) {

      case 'ping':
        sendResponse({ ok: true });
        return true;

      case 'getPageTitle':
        sendResponse({ title: document.title });
        return true;

      case 'loadSubtitles': {
        cues   = message.cues   || [];
        offset = message.offset || 0;
        lastText = null;

        const video = findLargestVideo();
        if (!video) {
          sendResponse({ ok: false, error: 'No video element found on this page.' });
          return true;
        }

        attach(video);
        sendResponse({ ok: true, cueCount: cues.length });
        return true;
      }

      case 'setOffset':
        offset   = message.offset;
        lastText = null;
        sendResponse({ ok: true });
        return true;

      case 'removeSubtitles':
        stopRender();
        cues = [];
        sendResponse({ ok: true });
        return true;
    }
  });

  // ── Boot ───────────────────────────────────────────────────────────────────

  loadAppearance();
  videoEl = findLargestVideo();

  setTimeout(() => {
    if (!videoEl) videoEl = findLargestVideo();
  }, 2500);

})();
