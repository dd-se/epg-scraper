// TV+ (Turkcell) provider — sports + general channels via TV+'s EPG JSON API.
//
// Source: https://tvplus.com.tr/canli-tv/yayin-akisi/{channel}--{id}
// The web app is a Next.js SPA; the schedule data it shows for each day chip
// comes from a plain-HTTP JSON API (discovered via chrome-devtools):
//
//   1. POST https://tvplus.com.tr/get-platform-info
//        body: {"platform":"production"}
//        -> {"https":"https://gbzottvscNN.tvplus.com.tr:33207", ...}
//        (the API host is a load-balanced node that rotates per session)
//   2. POST {base}/EPG/JSON/Authenticate
//        body: {"terminaltype":"webtv","terminalvendor":"...","osversion":
//               "Win32","userType":"3","utcEnable":"1","timezone":
//               "Europe/Istanbul"}
//        -> sets XSESSIONID / JSESSIONID cookies (required by PlayBillList)
//   3. POST {base}/EPG/JSON/PlayBillList
//        body: {"type":"2","channelid":"4399",
//               "begintime":"20260909000000","endtime":"20260909235959",
//               "isFillProgram":1}
//        -> {"counttotal":"13","playbilllist":[{ "starttime":
//             "2026-09-09 00:00:00 UTC+03:00", "endtime": "...",
//             "name":"TRT Spor Yıldız Ortak Yayın", "genres":"Spor", ... }]}
//
// Times come pre-stamped with the fixed +03:00 offset, so the provider emits
// them verbatim (after normalizing the literal " UTC+03:00" suffix).
//
// NOTE: this provider talks to a JSON API, so it is plain-HTTP only — do not
// run it with --browser (the browser fetcher renders pages and cannot POST).

import { wallToIso } from './hurriyet.js';

export const BASE_URL = 'https://tvplus.com.tr';
export const PLATFORM_INFO_URL = `${BASE_URL}/get-platform-info`;

const DEFAULT_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Curated channel table: display name -> { tvId (TV+ numeric id), id (XMLTV
// id normalized to the epgshare01 reference) }.
export const CHANNELS = [
  { name: 'TRT 1', tvId: '144', id: 'TRT.1.tr' },
  { name: 'TRT Spor', tvId: '31', id: 'TRT.SPOR.tr' },
  { name: 'TRT Spor Yıldız', tvId: '205', id: 'TRT.SPOR.YILDIZ.tr' },
  { name: 'A Spor', tvId: '3', id: 'A.SPOR.tr' },
  { name: 'HT Spor', tvId: '4396', id: 'HT.SPOR.tr' },
  { name: 'FB TV', tvId: '148', id: 'FENERBAHÇE.TV.tr' },
  { name: 'tabii spor', tvId: '4399', id: 'TABII.SPOR.tr' },
  { name: 'S Sport', tvId: '11', id: 'SSport.tr' },
  { name: 'S Sport 2', tvId: '170', id: 'SSport.2.tr' },
  { name: 'Eurosport 1', tvId: '77', id: 'EUROSPORT.1.HD.tr' },
  { name: 'Eurosport 2', tvId: '106', id: 'EUROSPORT.2.TR.HD.tr' },
  { name: 'Sports TV', tvId: '173', id: 'SPORTS.TV.tr' },
  { name: 'ATV', tvId: '124', id: 'ATV.tr' },
  { name: 'TV8', tvId: '134', id: 'TV8.tr' },
  { name: 'TV8,5', tvId: '188', id: 'TV8.5.tr' },
  { name: 'A2', tvId: '2', id: 'A2.tr' },
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

export function channelTvId(name) {
  const entry = CHANNELS.find((c) => normalizeChannelKey(c.name) === normalizeChannelKey(name));
  return entry ? entry.tvId : undefined;
}

// ---- Pure parsers (fixture-testable, no I/O) ----

// Parse the /get-platform-info response into the EPG API base URL.
export function parsePlatformInfo(text) {
  if (text == null) return undefined;
  try {
    const data = JSON.parse(String(text));
    return typeof data.https === 'string' && data.https ? data.https : undefined;
  } catch {
    return undefined;
  }
}

// Normalize an API instant ("2026-09-09 00:00:00 UTC+03:00") into wall-clock
// components { year, month, day, minutes }.  Missing/malformed input -> null.
export function parseApiInstant(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})(?::\d{2})?(?: UTC[+-]\d{2}:\d{2})?$/.exec(
    value.trim()
  );
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  return { year: Number(y), month: Number(mo), day: Number(d), minutes: Number(h) * 60 + Number(mi) };
}

// Parse a PlayBillList response body into programme slots.  Degrades to [].
export function parsePlaybill(text) {
  let data;
  try {
    data = JSON.parse(text == null ? '' : String(text));
  } catch {
    return [];
  }
  const list = Array.isArray(data?.playbilllist) ? data.playbilllist : [];
  const slots = [];
  for (const item of list) {
    const name = typeof item?.name === 'string' ? item.name.trim() : '';
    if (!name) continue;
    const start = parseApiInstant(item.starttime);
    const stop = parseApiInstant(item.endtime);
    if (!start || !stop) continue;
    const genre = typeof item.genres === 'string' && item.genres.trim() ? item.genres.trim() : undefined;
    slots.push({
      start: wallToIso(start.year, start.month, start.day, start.minutes),
      stop: wallToIso(stop.year, stop.month, stop.day, stop.minutes),
      title: name,
      ...(genre ? { category: genre } : {}),
    });
  }
  return slots;
}

// Extract session cookies (XSESSIONID/JSESSIONID) from a fetch Response so
// PlayBillList calls carry the session.  Works on real undici Headers
// (getSetCookie, Node >= 18.14) and degrades to get('set-cookie').
export function extractSessionCookie(response) {
  const headers = response && response.headers;
  if (!headers) return undefined;
  let values = [];
  if (typeof headers.getSetCookie === 'function') {
    values = headers.getSetCookie();
  } else if (typeof headers.get === 'function') {
    const single = headers.get('set-cookie');
    if (single) values = [single];
  }
  const pairs = values
    .map((v) => String(v).split(';', 1)[0].trim())
    .filter(Boolean);
  return pairs.length ? pairs.join('; ') : undefined;
}

// ---- JSON transport (plain HTTP only; the browser fetcher cannot POST) ----

export async function jsonPost(url, body, { fetchImpl, headers = {}, userAgent = DEFAULT_UA } = {}) {
  const doFetch = fetchImpl || globalThis.fetch.bind(globalThis);
  const response = await doFetch(url, {
    method: 'POST',
    headers: {
      'user-agent': userAgent,
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: BASE_URL,
      referer: `${BASE_URL}/`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return response;
}

// ---- scrape ----

// Scrape the requested window from TV+.  Each requested date is queried
// per channel with an explicit 00:00..23:59 window, so any date range the
// CLI asks for is honored (the API serves past and future days).
export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  politenessDelayMs = 400,
  fetchOptions = {},
  maxChannels = Infinity,
} = {}) {
  const seen = new Set();
  const programmes = [];

  // 1. Discover the (rotating) API host.
  let apiBase;
  try {
    const response = await jsonPost(PLATFORM_INFO_URL, { platform: 'production' }, { fetchImpl });
    const text = await response.text();
    apiBase = parsePlatformInfo(text);
    if (!apiBase) throw new Error('get-platform-info returned no https base');
    log(`ok:   api base ${apiBase}`);
  } catch (error) {
    log(`error: failed to discover TV+ api base: ${error.message}`);
    return { channels: [], programmes: [], days: 0, failures: 1 };
  }

  // 2. Authenticate and keep the session cookie.
  let sessionCookie;
  try {
    const response = await jsonPost(
      `${apiBase}/EPG/JSON/Authenticate`,
      {
        terminaltype: 'webtv',
        terminalvendor:
          '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/103.0.0.0 Safari/537.36',
        osversion: 'Win32',
        userType: '3',
        utcEnable: '1',
        timezone: 'Europe/Istanbul',
      },
      { fetchImpl }
    );
    await response.text();
    sessionCookie = extractSessionCookie(response);
    if (!sessionCookie) {
      log('warn: Authenticate set no session cookie — PlayBillList may be rejected');
    }
  } catch (error) {
    log(`error: TV+ authentication failed: ${error.message}`);
    return { channels: [], programmes: [], days: 0, failures: 1 };
  }

  const channels = CHANNELS.slice(0, maxChannels);
  // No dates supplied: cover today in Istanbul (UTC+3 year-round).
  const activeDates =
    dates && dates.length > 0
      ? dates
      : [new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10)];

  const cookieHeaders = sessionCookie ? { cookie: sessionCookie } : {};
  let failuresCount = 0;

  for (const channel of channels) {
    for (const date of activeDates) {
      const compact = date.replace(/-/g, ''); // YYYYMMDD
      const body = {
        type: '2',
        channelid: channel.tvId,
        begintime: `${compact}000000`,
        endtime: `${compact}235959`,
        isFillProgram: 1,
      };
      let response;
      try {
        response = await jsonPost(`${apiBase}/EPG/JSON/PlayBillList`, body, {
          fetchImpl,
          headers: cookieHeaders,
        });
      } catch (error) {
        failuresCount++;
        log(`warn: ${channel.name} (${date}) failed: ${error.message}`);
        continue;
      }
      const text = await response.text();
      const slots = parsePlaybill(text);
      for (const slot of slots) {
        const key = [channel.id, slot.start, slot.stop, slot.title].join('|');
        if (seen.has(key)) continue;
        seen.add(key);
        programmes.push({ channel: channel.id, ...slot });
      }
      log(`ok:   ${channel.name} (${date}): ${slots.length} programmes`);
      await sleep(politenessDelayMs);
    }
  }

  programmes.sort((a, b) =>
    a.channel.localeCompare(b.channel) || a.start.localeCompare(b.start)
  );

  const channelEntries = channels.map((c) => ({ id: c.id, name: c.name }));
  log(
    `done:  ${channelEntries.length} channels, ${programmes.length} programmes, ` +
      `${failuresCount} failed request(s)`
  );

  return {
    channels: channelEntries,
    programmes,
    days: activeDates.length,
    failures: failuresCount,
  };
}