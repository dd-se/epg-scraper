// DigiturkBurada provider — beIN Sports 5, beIN Sports Max 1-2, GS TV.
//
// Source: https://www.digiturkburada.com.tr/{page}.html
// (e.g. https://www.digiturkburada.com.tr/bein-sports-5-hd-yayin-akisi-154.html)
//
// Digiturk's own site (digiturk.com.tr) blocks datacenter IPs outright (Azure
// Application Gateway WAF, 403 on every path), and beinsports.com.tr only
// publishes beIN Sports 1-4.  DigiturkBurada is a third-party mirror of the
// Digiturk guide with static, plain-HTML per-channel pages (discovered via
// chrome-devtools + the project's stealth browser):
//
//   - the page shows one day's schedule as a <table> of
//     <td><strong>NAME</strong></td><td><strong>HH:MM</strong></td> rows
//   - the "Sonraki Gün" (next day) form POSTs the same page with
//     `yayin=DD.MM.YYYY`, which the server honors for any requested date
//   - the served date is echoed in an <h2> like "8 Eylül 2026 - Salı"
//
// Times are Istanbul wall time (fixed +03:00); a programme's stop is the
// next programme's start (24:00 for the last slot), matching mynet.
//
// NOTE: this provider POSTs form data, so it is plain-HTTP only — do not run
// it with --browser (the Playwright fetcher renders pages and cannot POST).

import { decodeEntities } from '../entities.js';
import { fetchResponseWithRetry, DEFAULT_UA } from '../http.js';
import { wallToIso, finishResult, defaultDates } from './shared.js';

export const BASE_URL = 'https://www.digiturkburada.com.tr';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Curated channel table: display name -> page slug + XMLTV id (normalized to
// the epgshare01 reference where the reference carries the channel).
export const CHANNELS = [
  {
    name: 'beIN Sports 5',
    page: '/bein-sports-5-hd-yayin-akisi-154.html',
    id: 'beIN.SPORTS.5.tr',
  },
  {
    name: 'beIN Sports Max 1',
    page: '/bein-sports-max-1-hd-yayin-akisi-64.html',
    id: 'beIN.SPORTS.MAX.1.tr',
  },
  {
    name: 'beIN Sports Max 2',
    page: '/bein-sports-max-2-hd-yayin-akisi-65.html',
    id: 'beIN.SPORTS.MAX.2.tr',
  },
  {
    name: 'GS TV',
    page: '/gs-tv-hd-yayin-akisi-58.html',
    id: 'GS.TV.tr',
  },
];

// name -> XMLTV id, exported so test/reference.test.mjs can enforce that
// every curated id exists in the vendored epgshare01 snapshot.
export const CHANNEL_ID_MAP = Object.fromEntries(CHANNELS.map((c) => [c.name, c.id]));

export function normalizeChannelKey(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toUpperCase();
}

export function mapChannelId(name) {
  const entry = CHANNELS.find((c) => normalizeChannelKey(c.name) === normalizeChannelKey(name));
  return entry ? entry.id : undefined;
}

export function channelPage(name) {
  const entry = CHANNELS.find((c) => normalizeChannelKey(c.name) === normalizeChannelKey(name));
  return entry ? entry.page : undefined;
}

export function dayPageUrl(page) {
  return `${BASE_URL}${page}`;
}

// ---- Pure parsers (fixture-testable, no I/O) ----

const TURKISH_MONTHS = {
  Ocak: 1,
  Şubat: 2,
  Mart: 3,
  Nisan: 4,
  Mayıs: 5,
  Haziran: 6,
  Temmuz: 7,
  Ağustos: 8,
  Eylül: 9,
  Ekim: 10,
  Kasım: 11,
  Aralık: 12,
};

// Parse the served-date heading ("8 Eylül 2026 - Salı") into YYYY-MM-DD.
export function parseServedDate(text) {
  if (typeof text !== 'string') return undefined;
  const match = /^(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})\b/.exec(text.trim());
  if (!match) return undefined;
  const month = TURKISH_MONTHS[match[2]];
  if (!month) return undefined;
  const day = Number(match[1]);
  if (day < 1 || day > 31) return undefined;
  return `${match[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Parse one day page into { date: "YYYY-MM-DD", slots: [{ startMin, title }] }.
// Missing/malformed markup degrades to an empty result, never a crash.
export function parseDayPage(html) {
  const source = html == null ? '' : String(html);
  const heading = /<h2>([^<]+)<\/h2>/.exec(source);
  const date = heading ? parseServedDate(decodeEntities(heading[1])) : undefined;

  const slots = [];
  const rowPattern =
    /<td style="padding:2px"><strong>([\s\S]*?)<\/strong><\/td>\s*<td style="padding:2px"><strong>(\d{1,2}):(\d{2})<\/strong><\/td>/g;
  let match;
  while ((match = rowPattern.exec(source)) !== null) {
    const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
    const hours = Number(match[2]);
    const minutes = Number(match[3]);
    if (!title || hours > 24 || minutes > 59) continue;
    slots.push({ startMin: hours * 60 + minutes, title });
  }
  return { date, slots };
}

// ---- Form transport (plain HTTP only; the browser fetcher cannot POST) ----
// Goes through fetchResponseWithRetry: hard timeout, bounded retries with
// backoff, transient 5xx/429 tolerated.

export function formPost(url, body, { fetchImpl, userAgent = DEFAULT_UA, ...retryOptions } = {}) {
  return fetchResponseWithRetry(url, {
    ...retryOptions,
    fetchImpl,
    userAgent,
    headers: {
      accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
      'content-type': 'application/x-www-form-urlencoded',
      referer: url,
    },
    method: 'POST',
    body: new URLSearchParams(body).toString(),
  });
}

// ---- scrape ----

// Scrape the requested dates for every configured channel.  Each channel-day
// is one POST with `yayin=DD.MM.YYYY`; a page whose served date does not
// match the requested date is skipped (never stamped with the wrong date).
export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  politenessDelayMs = 400,
  fetchOptions = {},
  maxChannels = Infinity,
} = {}) {
  const activeDates = dates && dates.length > 0 ? dates : defaultDates();

  const channels = CHANNELS.slice(0, maxChannels);
  const programmes = [];
  let failures = 0;

  for (const channel of channels) {
    const url = dayPageUrl(channel.page);
    for (const date of activeDates) {
      const [y, m, d] = date.split('-').map(Number);
      const body = { yayin: `${d}.${String(m).padStart(2, '0')}.${y}` };
      let response;
      try {
        response = await formPost(url, body, { fetchImpl, ...fetchOptions });
      } catch (error) {
        failures++;
        log(`warn: ${channel.name} (${date}) failed: ${error.message}`);
        continue;
      }
      const html = await response.text();
      const { date: servedDate, slots } = parseDayPage(html);
      if (servedDate && servedDate !== date) {
        log(`warn: ${channel.name} (${date}) served ${servedDate} — skipped`);
        continue;
      }
      const [year, month, day] = date.split('-').map(Number);
      for (let s = 0; s < slots.length; s++) {
        const slot = slots[s];
        const start = wallToIso(year, month, day, slot.startMin);
        const endMin = s + 1 < slots.length ? slots[s + 1].startMin : 24 * 60;
        // Repeated times on a page (same slot listed twice) would make a
        // zero-length programme — skip it instead of emitting garbage.
        if (endMin <= slot.startMin) continue;
        const stop = wallToIso(year, month, day, endMin);
        programmes.push({ channel: channel.id, start, stop, title: slot.title });
      }
      log(`ok:   ${channel.name} (${date}): ${slots.length} programmes`);
      await sleep(politenessDelayMs);
    }
  }

  // Dedupe exact repeats and return in the canonical (channel, start) order.
  return finishResult({
    channels: channels.map((c) => ({ id: c.id, name: c.name })),
    programmes,
    days: activeDates.length,
    failures,
  });
}