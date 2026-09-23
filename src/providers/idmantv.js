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
// Times are Baku wall time.  Baku is UTC+4 year-round: Azerbaijan abolished
// DST in 2016 (tzdb Asia/Baku: 4:00 Azer %z since 1997, RULES Azer 1997..2015
// — no DST after the 2016 cancellation).  Stamping the page's HH:MM with the
// Turkish +03:00 would mislabel every instant by one hour, so this provider
// stamps +04:00.  Mixed offsets are safe end to end: the XMLTV writer and
// reader compare start/stop as absolute instants, not as strings.  Providers
// must never emit bare UTC offsets or fractional seconds.
//
// A programme's stop is derived from the next slot's start (24:00 for the
// last slot), matching the mynet/beinsports/digiturkburada convention.

import { decodeEntities } from '../entities.js';
import { fetchText, createPoliteFetch } from '../http.js';
import {
  isRealCalendarDate,
  parseClockMinutes,
  deriveStartOnlyProgrammes,
  normalizeChannelKey,
  finishResult,
  defaultDates,
  splitDate,
} from './shared.js';

export { normalizeChannelKey };

export const BASE_URL = 'https://idmantv.az';

// Baku's fixed offset for the page's wall times.  Azerbaijan abolished DST in
// 2016 (tzdb Asia/Baku), so +04:00 applies year-round — stamping the shared
// Turkish +03:00 here would mislabel every instant by one hour.
export const BAKU_ISO_OFFSET = '+04:00';

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

// One IDMAN TV brand logo for the whole site (single-channel provider).
const BRAND_LOGO_RE =
  /<a[^>]*class="[^"]*\bw-nav-brand\b[^"]*"[^>]*>\s*<img[^>]*\ssrc="([^"]+)"[^>]*>/i;

// Extract the site header's brand logo (the navbar `w-nav-brand` image,
// served from admin.aztv.az).  Degrades to undefined when absent — the
// channel simply stays logoless.
export function parseBrandLogo(html) {
  const source = html == null ? '' : String(html);
  const match = BRAND_LOGO_RE.exec(source);
  if (!match) return undefined;
  const src = decodeEntities(match[1]).trim();
  if (!/^https?:\/\//i.test(src) || src.includes('|')) return undefined;
  return src;
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
    const startMin = parseClockMinutes(Number(match[1]), Number(match[2]), {
      allowEndOfDay: true,
    });
    if (startMin == null) continue;
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
    slotsByDay[dayIndex].push({ startMin, title });
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
  fetchOptions: inputFetchOptions = {},
  maxChannels = Infinity,
} = {}) {
  const fetchOptions = {
    ...inputFetchOptions,
    fetchImpl: createPoliteFetch(fetchImpl, politenessDelayMs),
  };
  const activeDates = dates && dates.length > 0 ? dates : defaultDates('Asia/Baku');
  const channels = CHANNELS.slice(0, maxChannels);
  const programmes = [];
  const channel = channels[0];
  let failures = 0;

  if (!channel) {
    return finishResult({ channels: [], programmes, days: activeDates.length, failures, log });
  }

  const url = weekPageUrl();
  let html;
  try {
    html = await fetchText(url, { fetchImpl, ...fetchOptions });
  } catch (error) {
    failures++;
    log(`warn: ${channel.name} weekly page fetch failed: ${error.message}`);
    return finishResult({ channels, programmes, days: activeDates.length, failures, log });
  }

  const { weekStart, weekEnd, days } = parseWeeklyPage(html);
  if (!weekStart || !weekEnd) {
    failures++;
    log(`warn: ${channel.name} page carried no parseable weekly schedule`);
    return finishResult({ channels, programmes, days: activeDates.length, failures, log });
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
    const slots = day.slots;
    programmes.push(
      ...deriveStartOnlyProgrammes(slots, {
        channel: channel.id,
        year,
        month,
        day: dayNum,
        offset: BAKU_ISO_OFFSET,
      })
    );
    log(`ok:   ${day.dayName} (${date}): ${slots.length} programmes`);
  }

  // Dedupe exact repeats and return in the canonical (channel, start) order.
  const icon = parseBrandLogo(html);
  return finishResult({
    channels: channels.map((c) => (icon ? { ...c, icon } : c)),
    programmes,
    days: activeDates.length,
    failures,
    log,
  });
}
