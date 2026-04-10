/**
 * Convert an SRT/VTT timestamp string to seconds.
 * Accepts both comma and dot as the millisecond separator.
 * e.g. "00:01:23,456" → 83.456
 *      "00:01:23.456" → 83.456
 *
 * @param {string} timeStr
 * @returns {number}
 */
export function srtTimeToSeconds(timeStr) {
  const match = timeStr.trim().match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!match) return 0;
  const [, h, m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}
