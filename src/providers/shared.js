import { isRealCalendarDate, parseClockMinutes, wallToInstant } from '../time.js';
import { createGuideResult } from '../model.js';

export { isRealCalendarDate, parseClockMinutes, wallToInstant };

// Shared helpers for provider adapters. Every provider needs the same
// channel-key normalization, validated wall-clock conversion, week/date math,
// start-only slot derivation, and guide-result finalization, so it lives here
// once instead of being copy-pasted per provider. Nothing here does I/O; the transport
// (fetch) stays in src/http.js and the scraping loops stay in the provider
// files.

// ---- Wall-clock <-> ISO conversion (fixed +03:00, Turkey) ----

// Wall-clock date (Y/M/D in the guide's time zone) + validated minutes since
// day start -> ISO instant stamped with the supplied UTC offset. Only
// 00:00 through explicit 24:00 are accepted; invalid dates, negative minutes,
// and values above 1440 return undefined. `offset` defaults to Turkey's fixed
// +03:00; idmantv supplies Baku's fixed +04:00.
export function wallToIso(year, month, day, minutes, offset = '+03:00') {
  return wallToInstant(year, month, day, minutes, offset);
}

// ---- Week math (Mon..Sun week-publishing providers) ----

function zonedDateString(referenceDate, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(referenceDate);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

// Monday..Sunday (wall dates, YYYY-MM-DD) of the week containing the
// reference date (default: now, Istanbul wall time).
export function weekDays(referenceDate = new Date(), timeZone = 'Europe/Istanbul') {
  const anchor = zonedDateString(referenceDate, timeZone);
  const base = new Date(`${anchor}T12:00:00Z`);
  const monday = new Date(base.getTime() - ((base.getUTCDay() + 6) % 7) * 86400000);
  const days = [];
  for (let i = 0; i < 7; i++) {
    days.push(new Date(monday.getTime() + i * 86400000).toISOString().slice(0, 10));
  }
  return days;
}

// Weekday tag index for a YYYY-MM-DD date: Monday=0..Sunday=6.  Providers
// index their own tag tables (DAY_SLUGS / DAY_TAGS) with this.
export function weekdayIndex(date) {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

// ---- Channel-key normalization ----

// Display names vary in case/spacing between sites; keys are compared
// normalized (uppercase, whitespace collapsed).
export function normalizeChannelKey(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toUpperCase();
}

// ---- Date window helpers ----

// The date window a provider should cover when the CLI passes none.
export function defaultDates(timeZone = 'Europe/Istanbul') {
  return [zonedDateString(new Date(), timeZone)];
}

// YYYY-MM-DD -> { year, month, day } numbers.
export function splitDate(date) {
  const [year, month, day] = String(date).split('-').map(Number);
  return { year, month, day };
}

export function deriveStartOnlyProgrammes(slots, { channel, year, month, day, offset = '+03:00' }) {
  const ordered = [...slots].sort((a, b) => a.startMin - b.startMin);
  const programmes = [];
  for (let index = 0; index < ordered.length; index++) {
    const slot = ordered[index];
    const endMin = index + 1 < ordered.length ? ordered[index + 1].startMin : 1440;
    if (endMin <= slot.startMin) continue;
    const start = wallToIso(year, month, day, slot.startMin, offset);
    const stop = wallToIso(year, month, day, endMin, offset);
    if (!start || !stop) continue;
    programmes.push({
      channel,
      start,
      stop,
      title: slot.title,
      ...(slot.category != null ? { category: slot.category } : {}),
    });
  }
  return programmes;
}

// ---- Result finishing (dedupe + canonical order + summary log) ----

const ISSUE_TEXT = {
  'invalid-result': 'invalid result field(s)',
  'invalid-channel': 'invalid channel entr(ies)',
  'duplicate-channel': 'duplicate channel id(s)',
  'invalid-programme': 'invalid programme entr(ies)',
  'unknown-channel': 'programme(s) with unknown channels',
  'duplicate-programme': 'duplicate programme(s)',
  'invalid-metadata': 'invalid result metadata',
  'invalid-language': 'invalid language tag',
};

export function finishResult({
  channels,
  programmes,
  days = 0,
  failures = 0,
  language = 'tr',
  log = () => {},
}) {
  const result = createGuideResult(
    { channels, programmes, days, failures, language },
    {
      onIssue: (code, count) => log(`warn: dropped ${count} ${ISSUE_TEXT[code] || code}`),
    }
  );
  log(
    `done:  ${result.channels.length} channels, ${result.programmes.length} programmes, ` +
      `${result.failures} failed request(s)`
  );
  return result;
}
