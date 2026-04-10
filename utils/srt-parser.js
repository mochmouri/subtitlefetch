import { srtTimeToSeconds } from './time-utils.js';

/**
 * Parse an SRT subtitle file into an array of cue objects.
 * Also handles VTT timestamps (dot separator) since srtTimeToSeconds accepts both.
 *
 * @param {string} srtText - raw SRT file content
 * @returns {{ index: number, start: number, end: number, text: string }[]}
 */
export function parseSRT(srtText) {
  const cues = [];

  const normalized = srtText
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();

  // Split on blank lines (one or more)
  const blocks = normalized.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Find the timing line — it contains "-->"
    let timeIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes('-->')) {
        timeIdx = i;
        break;
      }
    }
    if (timeIdx === -1) continue;

    const timeLine = lines[timeIdx];
    const match = timeLine.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/
    );
    if (!match) continue;

    const start = srtTimeToSeconds(match[1]);
    const end = srtTimeToSeconds(match[2]);

    // Text is everything after the timing line
    const rawText = lines.slice(timeIdx + 1).join('\n');

    const text = rawText
      .replace(/<\/?(i|b|u|s|font|em|strong)[^>]*>/gi, '') // strip common HTML tags
      .replace(/\{[^}]+\}/g, '')                            // strip ASS/SSA override codes
      .trim();

    if (!text) continue;

    const indexLine = timeIdx > 0 ? lines[timeIdx - 1].trim() : '';
    const index = /^\d+$/.test(indexLine) ? parseInt(indexLine, 10) : cues.length + 1;

    cues.push({ index, start, end, text });
  }

  return cues;
}
