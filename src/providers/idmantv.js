// iDMAN TV provider — İdman Televiziyası (Azerbaijan's first sports channel).
//
// Source: https://idmantv.az/az/program (the old idmantv.com.tr domain is
// dead; the real site is idmantv.az).
//
// The page is static server-rendered HTML (Webflow) carrying the whole
// current Mon–Sun week inline — no JS rendering, no API, no login:
//
//   <header><h1>İDMAN TELEVİZİYASI</h1>
//     <p>Həftənin bütün günlərinin TV proqramları (07.09.2026 - 13.09.2026)</p>
//   </header>
//   <div class="week-grid">
//     <div class="day-card">
//       <h3 class="day-title">Bazar ertəsi / 07.09.2026</h3>
//       <div class="programs-list">
//         <div class="prog-row">
//           <span class="prog-time">01:00</span>
//           <span class="prog-name">Bədii film.”Döyüşçü”</span>
//         </div>
//         ...
//
// Like beinsports, the site publishes exactly one Mon–Sun week — a static
// fixture that is only swapped when the week rolls over — so any requested
// window is served from that week and dates outside it are skipped with a
// warning.  One fetch covers all seven days.  Programme titles are
// Azerbaijani; the site occasionally appends a cross-channel note to the
// last slots of a day (e.g. "… (canlı) Mədəniyyət TV"), which is emitted
// verbatim — it is what the page actually shows.
//
// Times are Baku wall time; Baku is UTC+4 except the month-long DST shift
// (late March → late October) when it is UTC+5.  The repo standardizes on
// the fixed +03:00 offset used across the Turkish guide (Turkey has no
// DST), which for Baku is off by one hour while Azerbaijan observes summer
// time.  wallToIso() stamps +03:00 like every other provider so the merged
// guide keeps a single fixed offset; providers must never emit bare UTC
// offsets or fractional seconds.
//
// A programme's stop is derived from the next slot's start (24:00 for the
// last slot), matching the mynet/beinsports/digiturkburada convention.

import { decodeEntities } from '../entities.js';
import { fetchText } from '../http.js';
import {
  wallToIso,
  isRealCalendarDate,
  normalizeChannelKey,
  finishResult,
  defaultDates,
  splitDate,
} from './shared.js';

export { normalizeChannelKey };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const BASE_URL = 'https://idmantv.az';

// The weekly page path — the only endpoint this provider talks to.
export const WEEK_PAGE_PATH = '/az/program';

export function weekPageUrl() {
  return `${BASE_URL}${WEEK_PAGE_PATH}`;
}

// Curated channel table: display name -> XMLTV id.  The reference carries no
// iDMAN TV entry, so the id follows the generic slug of the Latin brand
// "iDMAN TV" (the dotted capital İ in "İDMAN TELEVİZİYASI" would not survive
// the ASCII slug rule); the id is acknowledged in reference.json knownGaps.
export const CHANNELS = [
  {
    name: 'İdman TV',
    id: 'IDMAN.TV.tr',
  },
];

// name -> XMLTV id, exported so test/reference.test.mjs can enforce that
// every curated id exists in the vendored epgshare01 snapshot.  Both the
// "İdman TV" brand and the site's "İDMAN TELEVİZİYASI" name map to one id.
export const CHANNEL_ID_MAP = {
  'İDMAN TV': 'IDMAN.TV.tr',
  'İDMAN TELEVİZİYASI': 'IDMAN.TV.tr',
};

export function mapChannelId(name) {
  return CHANNEL_ID_MAP[normalizeChannelKey(name)];
}

// ---- Pure parsers (fixture-testable, no I/O) ----

const DAY_TITLE_RE = /<h3[^>]*class="day-title"[^>]*>([\s\S]*?)<\/h3>/g;
const PROG_ROW_RE =
  /<div class="prog-row">\s*<span class="prog-time">(\d{1,2}):(\d{2})<\/span>\s*<span class="prog-name">([\s\S]*?)<\/span>\s*<\/div>/g;

// "Bazar ertəsi / 07.09.2026" -> { dayName, date } or undefined.
export function parseDayTitle(label) {
  if (typeof label !== 'string') return undefined;
  const parts = label.split('/').map((part) => part.trim());
  if (parts.length < 2) return undefined;
  const dayName = parts[0];
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(parts[parts.length - 1]);
  if (!match || !dayName) return undefined;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  // Impossible dates (month 13, Feb 30, day 32) are rejected with a
  // round-trip, not a bare range check — Date.UTC silently normalizes
  // overflow, so "31.02.2026" would land on March 3 without it.
  if (!isRealCalendarDate(year, month, day)) return undefined;
  return {
    dayName,
    date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

// Parse the weekly program page into { weekStart, weekEnd, days } where
// each day is { dayName, date: "YYYY-MM-DD", slots: [{ startMin, title }] }.
// Missing/malformed markup, out-of-clock wall times and impossible dates
// degrade to an empty result (or drop just the offending entry), never a
// crash.
export function parseWeeklyPage(html) {
  const source = html == null ? '' : String(html);

  // First pass: day-card headings — ordered, each carries its own date.
  const markers = [];
  let match;
  DAY_TITLE_RE.lastIndex = 0;
  while ((match = DAY_TITLE_RE.exec(source)) !== null) {
    const parsed = parseDayTitle(decodeEntities(match[1]).replace(/\s+/g, ' ').trim());
    if (!parsed) continue;
    markers.push({ index: match.index, dayName: parsed.dayName, date: parsed.date });
  }
  if (markers.length === 0) return { weekStart: undefined, weekEnd: undefined, days: [] };

  // Second pass: rows bucket to the last day-card that precedes them.
  const slotsByDay = markers.map(() => []);
  PROG_ROW_RE.lastIndex = 0;
  while ((match = PROG_ROW_RE.exec(source)) !== null) {
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    // Out-of-clock wall times (25:10, 24:30, ...) are rejected before
    // wallToIso — Date.UTC would silently roll them into another day.
    if (hours > 24 || minutes > 59 || (hours === 24 && minutes > 0)) continue;
    const title = decodeEntities(match[3]).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    let dayIndex = -1;
    for (let i = markers.length - 1; i >= 0; i--) {
      if (markers[i].index < match.index) {
        dayIndex = i;
        break;
      }
    }
    if (dayIndex === -1) continue;
    slotsByDay[dayIndex].push({ startMin: hours * 60 + minutes, title });
  }

  const days = markers.map((marker, i) => ({
    dayName: marker.dayName,
    date: marker.date,
    slots: slotsByDay[i],
  }));
  days.sort((a, b) => a.date.localeCompare(b.date));

  const dates = days.map((d) => d.date);
  return {
    weekStart: dates[0],
    weekEnd: dates[dates.length - 1],
    days,
  };
}

// ---- scrape ----

// Fetch the weekly page once and serve the requested dates that fall inside
// the published Mon–Sun week.  A failed fetch or a page with no parseable
// schedule degrades to a warning and an empty result, never a crash.
export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  politenessDelayMs = 250,
  fetchOptions = {},
  maxChannels = Infinity,
} = {}) {
  const activeDates = dates && dates.length > 0 ? dates : defaultDates();
  const channels = CHANNELS.slice(0, maxChannels);
  const programmes = [];
  const channel = channels[0];
  let failures = 0;

  if (!channel) {
    return finishResult({ channels: [], programmes, days: activeDates.length, failures });
  }

  const url = weekPageUrl();
  let html;
  try {
    html = await fetchText(url, { fetchImpl, ...fetchOptions });
  } catch (error) {
    failures++;
    log(`warn: ${channel.name} weekly page fetch failed: ${error.message}`);
    return finishResult({ channels, programmes, days: activeDates.length, failures });
  }
  await sleep(politenessDelayMs);

  const { weekStart, weekEnd, days } = parseWeeklyPage(html);
  if (!weekStart || !weekEnd) {
    failures++;
    log(`warn: ${channel.name} page carried no parseable weekly schedule`);
    return finishResult({ channels, programmes, days: activeDates.length, failures });
  }
  log(`ok:   ${channel.name} published week ${weekStart}..${weekEnd} (${days.length} day-card(s))`);

  const dayByDate = new Map(days.map((day) => [day.date, day]));

  for (const date of activeDates) {
    const day = dayByDate.get(date);
    if (!day) {
      log(`note: ${date} is outside the published ${weekStart}..${weekEnd} week — skipped`);
      continue;
    }
    const { year, month, day: dayNum } = splitDate(date);
    for (let s = 0; s < day.slots.length; s++) {
      const slot = day.slots[s];
      const start = wallToIso(year, month, dayNum, slot.startMin);
      const endMin = s + 1 < day.slots.length ? day.slots[s + 1].startMin : 24 * 60;
      // A repeated time on a day (same slot listed twice) would make a
      // zero-length programme — skip it instead of emitting garbage.
      if (endMin <= slot.startMin) continue;
      const stop = wallToIso(year, month, dayNum, endMin);
      programmes.push({ channel: channel.id, start, stop, title: slot.title });
    }
    log(`ok:   ${day.dayName} (${date}): ${day.slots.length} programmes`);
  }

  // Dedupe exact repeats and return in the canonical (channel, start) order.
  return finishResult({
    channels: channels.map((c) => ({ id: c.id, name: c.name })),
    programmes,
    days: activeDates.length,
    failures,
  });
}
