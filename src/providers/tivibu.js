// Tivibu provider — Tivibu Spor 1, Tivibu Spor 2, Tivibu Spor 3, Tivibu Spor 4.
//
// Source: https://www.tivibu.com.tr/kanallar/{slug}  (Tivibu GO, Türk Telekom)
//
// The old `tivibu.com.tr/yayin-akisi` path is dead (404); the new site moved
// to `/kanallar/<slug>` pages whose day-grid date switcher is client-side.
// Behind it is a plain-HTTP JSON API (discovered via chrome-devtools):
//
//   1. GET the channel page → the antiforgery cookie (Set-Cookie
//      `X-CSRF-TOKEN-*`), the hidden-input request token (`class="token"`),
//      and the channel's code (`ch…` inside the `/rv?i=2|ch…` links).
//   2. POST /Channel/GetPrevueList with
//      `{ channelCode, channelDateBegin, channelDateEnd }` (both
//      "YYYY.MM.DD HH:MM:SS" — any past/future day) plus the
//      `RequestVerificationToken` header + cookie → JSON with
//      `mobilPrevueViewModel[]` of
//      `{ prevueName, genre, beginTime, endTime, description, … }`.
//
// Times are Istanbul wall time with the fixed +03:00 offset and explicit
// start/stop on every slot (no derivation needed).  The response for a day
// also carries the tail of the previous day's last programme (begins before
// the window, e.g. 23:30 → 01:15 across midnight), so slots are kept only
// when their begin date equals the requested date — each programme belongs
// to the day it starts on.
//
// NOTE: this provider POSTs form data + sends an antiforgery cookie, so it
// is plain-HTTP only — do not run it with --browser.

import { wallToIso } from './hurriyet.js';

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const BASE_URL = 'https://www.tivibu.com.tr';
const PREVUE_URL = `${BASE_URL}/Channel/GetPrevueList`;

// Curated channel table: display name -> page slug + XMLTV id.  None of
// these channels exist in the epgshare01 reference yet, so ids use the
// generic slug from the display name (acknowledged in reference.json
// `knownGaps`).  The channel code is discovered from the page itself
// (`/rv?i=2|ch…` link), never hardcoded.
export const CHANNELS = [
  { name: 'Tivibu Spor 1', slug: 'tivibu-spor-1', id: 'TIVIBU.SPOR.1.tr' },
  { name: 'Tivibu Spor 2', slug: 'tivibu-spor-2', id: 'TIVIBU.SPOR.2.tr' },
  { name: 'Tivibu Spor 3', slug: 'tivibu-spor-3', id: 'TIVIBU.SPOR.3.tr' },
  { name: 'Tivibu Spor 4', slug: 'tivibu-spor-4', id: 'TIVIBU.SPOR.4.tr' },
];

export function normalizeChannelKey(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toUpperCase();
}

// name -> XMLTV id, exported so test/reference.test.mjs can enforce that
// every curated id exists in the vendored epgshare01 snapshot (or is an
// acknowledged gap).  Keys are normalized (uppercased) like the other
// providers' maps.
export const CHANNEL_ID_MAP = Object.fromEntries(
  CHANNELS.map((c) => [normalizeChannelKey(c.name), c.id])
);

export function mapChannelId(name) {
  return CHANNEL_ID_MAP[normalizeChannelKey(name)];
}

export function channelPageUrl(slug) {
  return `${BASE_URL}/kanallar/${slug}`;
}

// ---- Pure parsers (fixture-testable, no I/O) ----

// "2026.09.08 23:30:00" (Istanbul wall time) -> { date: "YYYY-MM-DD", min }.
function parseWallTime(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4})\.(\d{2})\.(\d{2})\s+(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(value.trim());
  if (!match) return undefined;
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (hours > 24 || minutes > 59) return undefined;
  // Out-of-clock garbage (25:00, 10:99) or impossible calendar dates
  // (month 13, Feb 30, day 32) would otherwise silently roll into a
  // different instant via wallToIso — reject them like the other providers
  // do.  Date.UTC normalizes, so a round-trip comparison catches every
  // overflow at once (same technique as toXmltvTimestamp).
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    return undefined;
  }
  return { date: `${match[1]}-${match[2]}-${match[3]}`, min: hours * 60 + minutes };
}

// Parse a channel page into { channelCode, token }.  Degrades to undefined
// fields on missing/malformed markup, never a crash.
export function parseChannelPage(html) {
  const source = html == null ? '' : String(html);
  const tokenMatch = /class="token"[^>]*value="([^"]+)"/.exec(source);
  const codeMatch = /\/rv\?i=[^"]*?(ch\d{20})/.exec(source);
  return {
    token: tokenMatch ? tokenMatch[1] : undefined,
    channelCode: codeMatch ? codeMatch[1] : undefined,
  };
}

// Parse a GetPrevueList response into slots:
// [{ beginDate, beginMin, endDate, endMin, title, category, desc }].
// Missing/malformed JSON degrades to an empty result, never a crash.
export function parsePrevueResponse(json) {
  const items = Array.isArray(json?.mobilPrevueViewModel) ? json.mobilPrevueViewModel : [];
  const slots = [];
  for (const item of items) {
    const title = typeof item?.prevueName === 'string' ? item.prevueName.replace(/\s+/g, ' ').trim() : '';
    const begin = parseWallTime(item?.beginTime);
    const end = parseWallTime(item?.endTime);
    if (!title || !begin || !end) continue;
    // A corrupt response can give an end that precedes its begin (same-day
    // rollback); such a slot would become a negative-duration programme.
    // Drop it instead of emitting garbage.
    if (end.date < begin.date || (end.date === begin.date && end.min <= begin.min)) {
      continue;
    }
    const category =
      typeof item?.genre === 'string' && item.genre.trim() ? item.genre.trim() : undefined;
    const desc =
      typeof item?.description === 'string' && item.description.trim()
        ? item.description.replace(/\s+/g, ' ').trim()
        : undefined;
    slots.push({
      beginDate: begin.date,
      beginMin: begin.min,
      endDate: end.date,
      endMin: end.min,
      title,
      category,
      desc,
    });
  }
  return { slots };
}

// ---- Form transport (plain HTTP only; the browser fetcher cannot POST) ----

// Extract `name=value` pairs from a Set-Cookie header value so they can be
// sent back on the POST (ASP.NET antiforgery pairs the request token with a
// cookie set on the first page load).
function cookiePairs(setCookieHeader) {
  const pairs = [];
  if (typeof setCookieHeader === 'string' && setCookieHeader) {
    for (const match of setCookieHeader.matchAll(/([^=;,\s]+)=([^;,\s]*)/g)) {
      pairs.push(`${match[1]}=${match[2]}`);
    }
  }
  return pairs;
}

// GET a page and capture the antiforgery cookie(s) for the session.
export async function sessionGet(url, { fetchImpl, userAgent = DEFAULT_UA } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const response = await doFetch(url, {
    headers: { 'user-agent': userAgent, accept: 'text/html,*/*' },
    redirect: 'follow',
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const html = await response.text();
  const setCookie = typeof response.headers?.get === 'function' ? response.headers.get('set-cookie') : '';
  return { html, cookie: cookiePairs(setCookie).join('; ') };
}

// POST GetPrevueList for one channel-day and return the parsed JSON.
export async function prevuePost(url, payload, { fetchImpl, userAgent = DEFAULT_UA } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  // The API takes the site's own dotted format ("2026.09.09 00:00:00").
  const dotted = payload.date.replaceAll('-', '.');
  const body = new URLSearchParams({
    channelCode: payload.channelCode,
    channelDateBegin: `${dotted} 00:00:00`,
    channelDateEnd: `${dotted} 23:59:59`,
  }).toString();
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      'user-agent': userAgent,
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'x-requested-with': 'XMLHttpRequest',
      'RequestVerificationToken': payload.token,
      cookie: payload.cookie,
      referer: payload.referer,
    },
    body,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`invalid JSON from ${url}`);
  }
}

// ---- scrape ----

// Scrape the requested dates for every configured channel.  One session GET
// per channel (cookie + token + channel code), then one POST per channel-day.
// A failed request degrades to a warning; the guide is never empty because
// of a single bad day.
export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  politenessDelayMs = 400,
  maxChannels = Infinity,
  fetchOptions = {},
} = {}) {
  const activeDates =
    dates && dates.length > 0
      ? dates
      : [new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)];

  const channels = CHANNELS.slice(0, maxChannels);
  const programmes = [];
  let failures = 0;

  for (const channel of channels) {
    const pageUrl = channelPageUrl(channel.slug);
    let session;
    try {
      session = await sessionGet(pageUrl, { fetchImpl });
    } catch (error) {
      failures++;
      log(`warn: ${channel.name} session failed: ${error.message}`);
      continue;
    }
    const { channelCode, token } = parseChannelPage(session.html);
    if (!channelCode || !token) {
      failures++;
      log(`warn: ${channel.name} page missing channel code or token`);
      continue;
    }
    await sleep(politenessDelayMs);

    for (const date of activeDates) {
      let json;
      try {
        json = await prevuePost(
          PREVUE_URL,
          {
            channelCode,
            token,
            cookie: session.cookie,
            referer: pageUrl,
            date,
          },
          { fetchImpl }
        );
      } catch (error) {
        failures++;
        log(`warn: ${channel.name} (${date}) failed: ${error.message}`);
        continue;
      }
      const { slots } = parsePrevueResponse(json);
      let kept = 0;
      for (const slot of slots) {
        // Each programme belongs to the day it starts on — drop the
        // previous day's cross-midnight tail the API includes.
        if (slot.beginDate !== date) continue;
        kept++;
        const [y, m, d] = slot.beginDate.split('-').map(Number);
        const [ey, em, ed] = slot.endDate.split('-').map(Number);
        const start = wallToIso(y, m, d, slot.beginMin);
        const stop = wallToIso(ey, em, ed, slot.endMin);
        programmes.push({
          channel: channel.id,
          start,
          stop,
          title: slot.title,
          category: slot.category,
          desc: slot.desc,
        });
      }
      log(`ok:   ${channel.name} (${date}): ${kept} programmes`);
      await sleep(politenessDelayMs);
    }
  }

  // Dedupe exact (channel, start, stop, title) repeats, keep first.
  const seen = new Set();
  const deduped = programmes.filter((p) => {
    const key = [p.channel, p.start, p.stop, p.title].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  deduped.sort((a, b) => a.channel.localeCompare(b.channel) || a.start.localeCompare(b.start));

  log(
    `done:  ${channels.length} channels, ${deduped.length} programmes, ` +
      `${failures} failed request(s)`
  );

  return {
    channels: channels.map((c) => ({ id: c.id, name: c.name })),
    programmes: deduped,
    days: activeDates.length,
    failures,
  };
}