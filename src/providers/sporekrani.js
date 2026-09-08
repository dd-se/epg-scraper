// Sporekrani provider — tabii spor 1-8, S Sport Plus.
//
// Source: https://www.sporekrani.com/home/channel/{slug}  (Spor Ekranı, the
// "hangi maç hangi kanalda" aggregator — yayinekrani.com serves the same data)
//
// Each channel page is a Quasar SSR app with the schedule embedded in a
// `window.__INITIAL_STATE__` JSON script tag (discovered via chrome-devtools):
//
//   state.common.events — the channel's rolling ~30-day event list, each
//     { name, date_time: "YYYY-MM-DD HH:MM:SS" (Istanbul wall time),
//       sport_name, league_name, channels: [{ name, ... }, ...] }
//
// An event can air on several channels (e.g. a Champions League match on
// tabii Spor 1 AND CBC Sport), so the parser keeps only events whose
// channels[] includes the page's own channel.  tabii spor 1-8 are match-day
// simulcast feeds — most days most of them carry no events at all, which is
// correct (an empty page means nothing is scheduled, not a scrape failure).
//
// Times are Istanbul wall time with the fixed +03:00 offset.  The source
// publishes **event start times only**; a programme's stop is derived from
// the next event on the page (chained across day boundaries, 24:00 for the
// last event), matching the mynet/beinsports/digiturkburada convention.
// The rolling window covers ~30 days from the server's "today"; requested
// dates outside the window are silently skipped (one fetch per channel).

import { fetchText } from '../http.js';
import {
  wallToIso,
  normalizeChannelKey,
  isRealCalendarDate,
  finishResult,
  defaultDates,
  splitDate,
} from './shared.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export { normalizeChannelKey };

export const BASE_URL = 'https://www.sporekrani.com';

// Curated channel table: display name -> page slug + XMLTV id.  None of these
// channels exist in the epgshare01 reference yet, so ids use the generic slug
// from the site's own display name (acknowledged in reference.json
// `knownGaps`).  `name` is the exact spelling the site uses in
// event.channels[].name so the parser can match events to the page's channel.
export const CHANNELS = [
  { name: 'tabii Spor 1', slug: 'tabii-spor-1', id: 'TABII.SPOR.1.tr' },
  { name: 'tabii Spor 2', slug: 'tabii-spor-2', id: 'TABII.SPOR.2.tr' },
  { name: 'tabii Spor 3', slug: 'tabii-spor-3', id: 'TABII.SPOR.3.tr' },
  { name: 'tabii Spor 4', slug: 'tabii-spor-4', id: 'TABII.SPOR.4.tr' },
  { name: 'tabii Spor 5', slug: 'tabii-spor-5', id: 'TABII.SPOR.5.tr' },
  { name: 'tabii Spor 6', slug: 'tabii-spor-6', id: 'TABII.SPOR.6.tr' },
  { name: 'tabii Spor 7', slug: 'tabii-spor-7', id: 'TABII.SPOR.7.tr' },
  { name: 'tabii Spor 8', slug: 'tabii-spor-8', id: 'TABII.SPOR.8.tr' },
  { name: 'S Sport Plus', slug: 's-sport-plus', id: 'S.SPORT.PLUS.tr' },
];

// name -> XMLTV id, exported so test/reference.test.mjs can enforce that
// every curated id exists in the vendored epgshare01 snapshot (or is an
// acknowledged gap).  Keys are normalized (uppercased) like the other
// providers' maps; the site's exact spelling lives in CHANNELS[].name.
export const CHANNEL_ID_MAP = Object.fromEntries(
  CHANNELS.map((c) => [normalizeChannelKey(c.name), c.id])
);

export function mapChannelId(name) {
  return CHANNEL_ID_MAP[normalizeChannelKey(name)];
}

export function channelPageUrl(slug) {
  return `${BASE_URL}/home/channel/${slug}`;
}

// ---- Pure parsers (fixture-testable, no I/O) ----

// Pull the `window.__INITIAL_STATE__` JSON out of the page.  The assignment
// is one JSON object (brace-balanced scan is string-aware so `{`/`}` inside
// string values can't derail it).  Degrades to undefined on missing markup.
export function extractInitialState(html) {
  const source = html == null ? '' : String(html);
  const marker = 'window.__INITIAL_STATE__=';
  const start = source.indexOf(marker);
  if (start === -1) return undefined;
  const jsonStart = start + marker.length;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;
  for (let i = jsonStart; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return undefined;
  try {
    return JSON.parse(source.slice(jsonStart, end + 1));
  } catch {
    return undefined;
  }
}

// Parse one channel page into the events that air on `channelName`:
// [{ date: "YYYY-MM-DD", startMin, title, category }].  Events are kept only
// when the page's own channel appears in the event's channels[] — the same
// match often airs on other channels too.  A missing or malformed page
// degrades to an empty result, never a crash.
export function parseChannelPage(html, channelName) {
  const state = extractInitialState(html);
  const events = Array.isArray(state?.common?.events) ? state.common.events : [];
  const key = normalizeChannelKey(channelName);
  const out = [];
  for (const event of events) {
    if (!Array.isArray(event?.channels)) continue;
    const onChannel = event.channels.some((c) => normalizeChannelKey(c?.name) === key);
    if (!onChannel) continue;
    const title = typeof event.name === 'string' ? event.name.replace(/\s+/g, ' ').trim() : '';
    const dt = typeof event.date_time === 'string' ? event.date_time.trim() : '';
    const timeMatch = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$/.exec(dt);
    if (!title || !timeMatch) continue;
    const hours = Number(timeMatch[4]);
    const minutes = Number(timeMatch[5]);
    if (hours > 24 || minutes > 59) continue;
    // Impossible calendar dates (month 13, Feb 30) would silently roll into
    // a different month via wallToIso — validate like the other parsers.
    if (!isRealCalendarDate(Number(timeMatch[1]), Number(timeMatch[2]), Number(timeMatch[3]))) {
      continue;
    }
    const category =
      typeof event.sport_name === 'string' && event.sport_name.trim()
        ? event.sport_name.replace(/\s+/g, ' ').trim()
        : undefined;
    out.push({
      date: `${timeMatch[1]}-${timeMatch[2]}-${timeMatch[3]}`,
      startMin: hours * 60 + minutes,
      title,
      category,
    });
  }
  return { events: out };
}

// ---- scrape ----

// Scrape the requested window.  Each channel page carries the full rolling
// ~30-day list, so one fetch per channel covers every requested date inside
// the window (dates outside it are silently skipped — the source cannot
// serve arbitrary past/future days).  A failed page degrades to a warning.
export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  politenessDelayMs = 500,
  maxChannels = Infinity,
  fetchOptions = {},
} = {}) {
  const activeDates =
    dates && dates.length > 0 ? dates : defaultDates();
  const requested = new Set(activeDates);

  const channels = CHANNELS.slice(0, maxChannels);
  const programmes = [];
  let failures = 0;

  for (const channel of channels) {
    const url = channelPageUrl(channel.slug);
    let html;
    try {
      html = await fetchText(url, { fetchImpl, ...fetchOptions });
    } catch (error) {
      failures++;
      log(`warn: ${channel.name} fetch failed: ${error.message}`);
      continue;
    }

    const { events } = parseChannelPage(html, channel.name);
    // Events are already sorted by the site, but sort defensively so stops
    // chain from the chronologically next event across day boundaries.
    events.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin);

    let inWindow = 0;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!requested.has(event.date)) continue;
      inWindow++;
      const next = events[i + 1];
      const { year, month, day } = splitDate(event.date);
      const nextParts = next ? splitDate(next.date) : { year, month, day };
      const start = wallToIso(year, month, day, event.startMin);
      const stop = wallToIso(nextParts.year, nextParts.month, nextParts.day, next ? next.startMin : 24 * 60);
      // Two events with the same start time (simulcast listing duplicated)
      // would make a zero-length programme — skip it instead of emitting
      // garbage.  ISO strings compare correctly at a fixed +03:00 offset.
      if (stop <= start) continue;
      programmes.push({
        channel: channel.id,
        start,
        stop,
        title: event.title,
        category: event.category,
      });
    }
    log(`ok:   ${channel.name}: ${events.length} events in page, ${inWindow} in window`);
    await sleep(politenessDelayMs);
  }

  // Dedupe exact repeats and return in the canonical (channel, start) order.
  return finishResult({
    channels: channels.map((c) => ({ id: c.id, name: c.name })),
    programmes,
    days: activeDates.length,
    failures,
  });
}