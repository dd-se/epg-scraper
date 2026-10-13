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
//   Channel discovery (used once to enumerate the lineup, 2026-10-13):
//   POST {base}/EPG/JSON/ChannelList {"fromIndex":"0","toIndex":"400"}
//   returns the full platform list — 172 channels, 155 of them with programme
//   data; the 17 without are its movie-collection VOD rails.  Unknown channel
//   ids simply return counttotal 0 from PlayBillList.  Re-run it when looking
//   for newly added channels (see UNSUCCESSFUL.md "Notes for future work").
//
// Times come pre-stamped with the fixed +03:00 offset, so the provider emits
// them verbatim (after normalizing the literal " UTC+03:00" suffix).
//
// Failsafes: the session (rotating host + cookie) is re-established once
// when a PlayBillList call fails mid-run — the load balancer rotates hosts
// and sessions do expire during long scrapes — and every POST is retried
// with backoff by the transport.  A channel-day that still fails after all
// that degrades to a warning, never a crash.
//
// NOTE: this provider talks to a JSON API, so it is plain-HTTP only — do not
// run it with --browser (the browser fetcher renders pages and cannot POST).

import { fetchResponseWithRetry, DEFAULT_UA, createPoliteFetch } from '../http.js';
import {
  wallToIso,
  normalizeChannelKey,
  isRealCalendarDate,
  parseClockMinutes,
  finishResult,
  defaultDates,
} from './shared.js';

export const BASE_URL = 'https://tvplus.com.tr';
export const PLATFORM_INFO_URL = `${BASE_URL}/get-platform-info`;

// Curated channel table: the platform's own display name -> { tvId (TV+ numeric
// id), id (XMLTV id, see src/slug.js for the format) }.
//
// Curated from a live `ChannelList` probe (2026-10-13): the platform publishes
// 172 channels, 155 of them with programme data; the 17 without are its
// movie-collection VOD rails.  This table keeps every channel TV+ serves that
// hurriyet or mynet also curates — so this provider stands alone for that
// lineup — plus Viasat History, which closes the catalog's `history.tr` gap.
// A channel's id is the one the other providers publish, never a new spelling:
// the whole point is that the three guides agree without an alias map.
//
// Five entries exist only because the platform spells a channel differently
// from our guides — `24 HD`, `TVNET HD`, `HABER GLOBAL HD`,
// `NATIONAL GEOGRAPHIC WILD HD` and `NICKELODEON` (mynet's `NICKELODEON SD`).
// A name match alone misses those, so `test/fixtures/tvplus/coverage.json`
// records every TV+ channel our other guides also serve and the id it must land
// on, and the suite fails when the table loses one.
//
// The rest of the platform (pay tiers, the ~85 channels only TV+ carries, the
// two `TV+ Keşet` promo shelves) is deliberately not curated: it would triple
// the per-run request count for channels the other guides do not carry.
export const CHANNELS = [
  // Ulusal genel yayın — the terrestrial platforms, plus the local channels
  // the same sources carry.
  { name: '360 HD', tvId: '86', id: '360.tr' },
  { name: '24 HD', tvId: '32', id: '24TV.tr' },
  { name: 'A NEWS HD', tvId: '101', id: 'ANEWSHD.tr' },
  { name: 'A PARA HD', tvId: '79', id: 'APARA.tr' },
  { name: 'A2 HD', tvId: '2', id: 'A2.tr' },
  { name: 'ATV HD', tvId: '124', id: 'ATV.tr' },
  { name: 'BENGÜTÜRK', tvId: '47', id: 'BENGUTURK.tr' },
  { name: 'BEYAZ TV HD', tvId: '135', id: 'BEYAZTV.tr' },
  { name: 'CNN TÜRK HD', tvId: '158', id: 'CNNTURK.tr' },
  { name: 'DMAX HD', tvId: '180', id: 'DMAX.tr' },
  { name: 'EKOTÜRK HD', tvId: '100', id: 'EKOTURK.tr' },
  { name: 'KANAL 7 HD', tvId: '90', id: 'KANAL7.tr' },
  { name: 'KANAL D HD', tvId: '88', id: 'KANALD.tr' },
  { name: 'MİNİKA GO', tvId: '7', id: 'MINIKAGO.tr' },
  { name: 'NOW', tvId: '93', id: 'NOWTV.tr' },
  { name: 'SHOW TV HD', tvId: '130', id: 'SHOWTV.tr' },
  { name: 'STAR TV HD', tvId: '89', id: 'STARTV.tr' },
  { name: 'SİNEMA TV HD', tvId: '166', id: 'SINEMATVHD.tr' },
  { name: 'TLC', tvId: '174', id: 'TLC.tr' },
  { name: 'TV2 HD', tvId: '95', id: 'TEVE2.tr' },
  { name: 'TV8 HD', tvId: '134', id: 'TV8.tr' },
  { name: 'TV8,5 HD', tvId: '188', id: 'TV85.tr' },
  { name: 'ÜLKE TV HD', tvId: '145', id: 'ULKETV.tr' },

  // Spor — several of these no other provider carries, which is most of why
  // this provider is in the sports profile.
  { name: 'A SPOR HD', tvId: '3', id: 'ASPOR.tr' },
  { name: 'EUROSPORT 1 HD', tvId: '77', id: 'EUROSPORT1.tr' },
  { name: 'EUROSPORT 2 HD', tvId: '106', id: 'EUROSPORT2.tr' },
  { name: 'FB TV', tvId: '148', id: 'FENERBAHCETV.tr' },
  { name: 'HT SPOR', tvId: '4396', id: 'HTSPOR.tr' },
  { name: 'S SPORT', tvId: '11', id: 'SSPORT1.tr' },
  { name: 'S SPORT 2', tvId: '170', id: 'SSPORT2.tr' },
  { name: 'SPORTS TV HD', tvId: '173', id: 'SPORTSTV.tr' },
  { name: 'tabii spor', tvId: '4399', id: 'TABIISPOR.tr' },

  // TRT family.  TRT 3 is the SD twin of TRT Spor (same schedule, one id),
  // as hurriyet already publishes it.
  { name: 'TRT 2 HD', tvId: '83', id: 'TRT2.tr' },
  { name: 'TRT EBA', tvId: '2300', id: 'TRTEBA.tr' },
  { name: 'TRT 3', tvId: '116', id: 'TRTSPOR.tr' },
  { name: 'TRT ARABI', tvId: '76', id: 'TRTARABI.tr' },
  { name: 'TRT AVAZ', tvId: '193', id: 'TRTAVAZHD.tr' },
  { name: 'TRT BELGESEL HD', tvId: '21', id: 'TRTBELGESEL.tr' },
  { name: 'TRT HABER HD', tvId: '30', id: 'TRTHABER.tr' },
  { name: 'TRT KURDİ', tvId: '10', id: 'TRTKURDI.tr' },
  { name: 'TRT MÜZİK', tvId: '159', id: 'TRTMUZIK.tr' },
  { name: 'TRT SPOR HD', tvId: '31', id: 'TRTSPOR.tr' },
  { name: 'TRT SPOR YILDIZ', tvId: '205', id: 'TRTSPORYILDIZ.tr' },
  { name: 'TRT TÜRK', tvId: '156', id: 'TRTTURK.tr' },
  { name: 'TRT World HD', tvId: '38', id: 'TRTWORLDHD.tr' },
  { name: 'TRT ÇOCUK HD', tvId: '99', id: 'TRTCOCUK.tr' },
  { name: 'TRT1 HD', tvId: '144', id: 'TRT1.tr' },

  // Çocuk ve belgesel
  { name: 'BABYTV', tvId: '29', id: 'BABYTV.tr' },
  { name: 'CARTOON NETWORK', tvId: '20', id: 'CARTOONNETWORK.tr' },
  { name: 'CBEEBIES', tvId: '4520', id: 'CBEEBIES.tr' },
  { name: 'DA VINCI HD', tvId: '208', id: 'DAVINCILEARNINGHD.tr' },
  { name: 'DISCOVERY CHANNEL HD', tvId: '8', id: 'DISCOVERYCHANNEL.tr' },
  { name: 'DISNEY JUNIOR', tvId: '149', id: 'DISNEYJUNIOR.tr' },
  { name: 'DİYANET TV', tvId: '175', id: 'DIYANETTV.tr' },
  { name: 'NATIONAL GEOGRAPHIC WILD HD', tvId: '139', id: 'NATIONALGEOGRAPHICWILD.tr' },
  { name: 'NICKELODEON', tvId: '4487', id: 'NICKELODEON.tr' },
  { name: 'NATIONAL GEOGRAPHIC HD', tvId: '2799', id: 'NATIONALGEOGRAPHIC.tr' },
  { name: 'Nick JR', tvId: '4353', id: 'NICKJR.tr' },
  { name: 'TVNET HD', tvId: '92', id: 'TVNET.tr' },
  // Not carried by hurriyet/mynet: this is the one channel TV+ serves that
  // closes a catalog gap (the sources spell the channel "Viasat History",
  // which the catalog's old `History` pattern could never match).
  { name: 'VIASAT HISTORY HD', tvId: '44', id: 'history.tr' },

  // Uluslararası
  { name: 'Bloomberg', tvId: '4459', id: 'BLOOMBERGTV.tr' },
  { name: 'BLOOMBERG HT HD', tvId: '96', id: 'BLOOMBERGHT.tr' },
  { name: 'CNN International', tvId: '4454', id: 'CNNINTERNATIONAL.tr' },
  { name: 'EURONEWS', tvId: '171', id: 'EURONEWS.tr' },

  // Haber ve yerel
  { name: 'A HABER HD', tvId: '160', id: 'AHABER.tr' },
  { name: 'HABERTÜRK HD', tvId: '87', id: 'HABERTURK.tr' },
  { name: 'HALK TV', tvId: '91', id: 'HALKTV.tr' },
  { name: 'KRT TV', tvId: '111', id: 'KRTTV.tr' },
  { name: 'NTV HD', tvId: '81', id: 'NTV.tr' },
  { name: 'HABER GLOBAL HD', tvId: '5', id: 'HABERGLOBAL.tr' },
  { name: 'SÖZCÜ TV', tvId: '4294', id: 'SOZCUTV.tr' },
  { name: 'TARIH TV', tvId: '4253', id: 'TARIHTV.tr' },
  { name: 'TELE1', tvId: '189', id: 'TELE1.tr' },
  { name: 'TGRT HABER HD', tvId: '34', id: 'TGRTHABER.tr' },
  { name: 'TV100', tvId: '179', id: 'TV100.tr' },
  { name: 'VAV TV', tvId: '2859', id: 'VAVTV.tr' },
];

/**
 * The sports subset of `CHANNELS`, by id.  TV+ is a sports-profile provider but
 * now curates general-interest channels too, so the sports merge and the
 * sports-coverage assertions must ask for this list rather than assuming every
 * curated id is a sports feed.  `TRT 3` is deliberately absent: it is the SD
 * twin of TRT Spor and shares its id.
 */
export const SPORTS_CHANNEL_IDS = [
  'ASPOR.tr',
  'EUROSPORT1.tr',
  'EUROSPORT2.tr',
  'FENERBAHCETV.tr',
  'HTSPOR.tr',
  'SPORTSTV.tr',
  'SSPORT1.tr',
  'SSPORT2.tr',
  'TABIISPOR.tr',
  'TRTSPOR.tr',
  'TRTSPORYILDIZ.tr',
];
// name -> XMLTV id.
export const CHANNEL_ID_MAP = Object.fromEntries(CHANNELS.map((c) => [c.name, c.id]));

export { normalizeChannelKey };

// The platform writes its own spelling in the table (`TRT SPOR HD`), so a
// lookup by the bare channel name has to ignore the qualifier — the same rule
// the cross-provider id comparison applies, and the same one ids follow.
function findChannel(name) {
  const key = lookupKey(name);
  return CHANNELS.find((c) => lookupKey(c.name) === key);
}

function lookupKey(name) {
  return normalizeChannelKey(name).replace(/\b(HD|4K)\b/g, '').trim();
}

export function mapChannelId(name) {
  const entry = findChannel(name);
  return entry ? entry.id : undefined;
}

export function channelTvId(name) {
  const entry = findChannel(name);
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
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})(?::\d{2})? UTC([+-])(\d{2}):(\d{2})$/.exec(
    value.trim()
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, sign, offsetHours, offsetMinutes] = match;
  if (
    sign !== '+' ||
    Number(offsetHours) !== 3 ||
    Number(offsetMinutes) !== 0
  ) {
    return null;
  }
  const minutes = parseClockMinutes(Number(h), Number(mi), { allowEndOfDay: true });
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  if (minutes == null) return null;
  // Out-of-clock garbage (25:00, 10:99) or impossible calendar dates
  // (month 13, Feb 30, day 32) would otherwise silently roll into a
  // different instant via wallToIso — reject them like the other providers
  // do.
  if (!isRealCalendarDate(year, month, day)) return null;
  return { year, month, day, minutes };
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
    const startIso = wallToIso(start.year, start.month, start.day, start.minutes);
    const stopIso = wallToIso(stop.year, stop.month, stop.day, stop.minutes);
    // A corrupt response can give an end that precedes its begin (or a
    // zero-length isFillProgram gap): such a slot would become an invalid
    // programme.  Drop it instead of emitting garbage.  The ISO strings
    // share the fixed +03:00 offset, so lexicographic comparison is a true
    // chronological comparison.
    if (stopIso <= startIso) continue;
    const genre = typeof item.genres === 'string' && item.genres.trim() ? item.genres.trim() : undefined;
    slots.push({
      start: startIso,
      stop: stopIso,
      title: name,
      ...(genre ? { category: genre } : {}),
    });
  }
  return slots;
}

// Choose the best channel-logo URL from one ChannelList record's picture
// map.  The picture.* fields were pixel-measured across all 16 curated
// channels (2026-09-15, see /tmp/logocheck samples):
//
//   channelpic — 270x270 square channel wordmark, always under the CMS path
//                /CPS/images/universal/film/logo/…_op.webp; exactly the
//                asset the tvplus.com.tr guide renders as the channel logo
//                (.epg-card__channel-logo).
//   poster     — 170x45 wordmark banner (clean, landscape).
//   icon       — 100x67 landscape logo on most channels, but a 1000x1480
//                PORTRAIT show poster on others (ATV, TV8, TRT Spor,
//                TRT Spor Yıldız, tabii spor, …).
//   ad / still — 495x280 / large programme stills, never a logo.
//
// Dimensions are not recoverable from the URLs (no encoded sizes), so field
// priority — not shape sniffing — picks the logo: channelpic, then poster,
// then icon.  `ad`/`still` are never considered.  Values are comma-joined
// variant lists ("url1,url2" or even "0,0"); the first http(s) part wins
// and pipe-joined garbage is rejected (same rule as beinsports).  Returns
// undefined when nothing usable remains.
export function pickLogoUrl(picture) {
  if (!picture || typeof picture !== 'object') return undefined;
  for (const field of ['channelpic', 'poster', 'icon']) {
    const raw = picture[field];
    if (typeof raw !== 'string') continue;
    for (const part of raw.split(',')) {
      const url = part.trim();
      if (/^https?:\/\//i.test(url) && !url.includes('|')) return url;
    }
  }
  return undefined;
}

// Parse the EPG ChannelList response into tvId -> logo URL — pure and
// fixture-testable.  Missing/malformed input degrades to {}.
export function parseChannelListLogos(text) {
  if (text == null) return {};
  let data;
  try {
    data = JSON.parse(String(text));
  } catch {
    return {};
  }
  const list = Array.isArray(data?.channellist) ? data.channellist : [];
  const out = {};
  for (const item of list) {
    const tvId = item?.id != null ? String(item.id) : undefined;
    if (!tvId || out[tvId]) continue;
    const logo = pickLogoUrl(item?.picture);
    if (logo) out[tvId] = logo;
  }
  return out;
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
//
// Every POST goes through fetchResponseWithRetry: hard timeout, bounded
// retries with backoff, transient 5xx/429 tolerated. The returned object
// buffers the body from the same attempt while preserving Set-Cookie access.

export function jsonPost(url, body, { fetchImpl, headers = {}, userAgent = DEFAULT_UA, ...retryOptions } = {}) {
  return fetchResponseWithRetry(url, {
    ...retryOptions,
    fetchImpl,
    userAgent,
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      origin: BASE_URL,
      referer: `${BASE_URL}/`,
      ...headers,
    },
    method: 'POST',
    retry403: true,
    body: JSON.stringify(body),
  });
}

// ---- Session lifecycle ----

// Authenticate against the discovered API host and return the session
// cookie string (or undefined when the server sets none).
async function authenticate(apiBase, { fetchImpl, log, fetchOptions = {} }) {
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
    { fetchImpl, ...fetchOptions }
  );
  await response.text();
  const cookie = extractSessionCookie(response);
  if (!cookie) {
    log('warn: Authenticate set no session cookie — PlayBillList may be rejected');
  }
  return cookie;
}

// Establish a session: discover the (rotating) API host, then authenticate.
// Returns { apiBase, sessionCookie } or undefined when discovery/auth fails.
async function establishSession({ fetchImpl, log, fetchOptions = {} }) {
  let apiBase;
  try {
    const response = await jsonPost(PLATFORM_INFO_URL, { platform: 'production' }, { fetchImpl, ...fetchOptions });
    const text = await response.text();
    apiBase = parsePlatformInfo(text);
    if (!apiBase) throw new Error('get-platform-info returned no https base');
    log(`ok:   api base ${apiBase}`);
  } catch (error) {
    log(`error: failed to discover TV+ api base: ${error.message}`);
    return undefined;
  }
  try {
    const sessionCookie = await authenticate(apiBase, { fetchImpl, log, fetchOptions });
    return { apiBase, sessionCookie };
  } catch (error) {
    log(`error: TV+ authentication failed: ${error.message}`);
    return undefined;
  }
}

// ---- scrape ----

// Scrape the requested window from TV+.  Each requested date is queried
// per channel with an explicit 00:00..23:59 window, so any date range the
// CLI asks for is honored (the API serves past and future days).
export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  // 65 channels per day is one PlayBillList request each, so the run is ~4x
  // what it was at 16 channels: 500ms between requests (mynet's default) keeps
  // the platform's load as low as the volume allows.
  politenessDelayMs = 500,
  fetchOptions: inputFetchOptions = {},
  maxChannels = Infinity,
} = {}) {
  const fetchOptions = {
    ...inputFetchOptions,
    fetchImpl: createPoliteFetch(fetchImpl, politenessDelayMs),
  };
  const programmes = [];

  // 1. Session: rotating host + auth cookie.  Re-established once mid-run
  //    if a PlayBillList call exhausts its retries (expired session).
  // fetchOptions flows into every transport call (retries, timeoutMs, ...).
  let session = await establishSession({ fetchImpl, log, fetchOptions });
  if (!session) {
    return finishResult({ channels: [], programmes: [], days: 0, failures: 1, log });
  }

  const channels = CHANNELS.slice(0, maxChannels);
  // No dates supplied: cover today in Istanbul (UTC+3 year-round).
  const activeDates = dates && dates.length > 0 ? dates : defaultDates();

  // Channel logos: the ChannelList call (same session handshake as
  // PlayBillList) carries a picture.{channelpic,poster,icon} per channel —
  // one extra call covers all 16 channels, no per-day cost.  A failed
  // lookup degrades to logoless channels, never a failed run.
  let logos = {};
  try {
    const response = await jsonPost(`${session.apiBase}/EPG/JSON/ChannelList`, { fromIndex: '0', toIndex: '200' }, {
      fetchImpl,
      ...fetchOptions,
      headers: session.sessionCookie ? { cookie: session.sessionCookie } : {},
    });
    logos = parseChannelListLogos(await response.text());
    log(`ok:   channel logos for ${Object.keys(logos).length} channels`);
  } catch (error) {
    log(`warn: channel logo lookup failed (${error.message}) — continuing without logos`);
  }

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
      let text;
      try {
        const response = await jsonPost(`${session.apiBase}/EPG/JSON/PlayBillList`, body, {
          fetchImpl,
          ...fetchOptions,
          headers: session.sessionCookie ? { cookie: session.sessionCookie } : {},
        });
        text = await response.text();
      } catch (error) {
        // The load balancer rotates hosts and sessions expire: rebuild the
        // session once and retry this channel-day before giving up on it.
        log(`warn: ${channel.name} (${date}) failed (${error.message}); re-authenticating`);
            const fresh = await establishSession({ fetchImpl, log, fetchOptions });
        if (!fresh) {
          failuresCount++;
          log(`warn: ${channel.name} (${date}) skipped: session re-establishment failed`);
                continue;
        }
        session = fresh;
        try {
          const response = await jsonPost(`${session.apiBase}/EPG/JSON/PlayBillList`, body, {
            fetchImpl,
            ...fetchOptions,
            headers: session.sessionCookie ? { cookie: session.sessionCookie } : {},
          });
          text = await response.text();
        } catch (retryError) {
          failuresCount++;
          log(`warn: ${channel.name} (${date}) failed after re-auth: ${retryError.message}`);
                continue;
        }
      }
      const slots = parsePlaybill(text);
      for (const slot of slots) {
        programmes.push({ channel: channel.id, ...slot });
      }
      log(`ok:   ${channel.name} (${date}): ${slots.length} programmes`);
      }
  }

  const result = finishResult({
    channels: channels.map((c) => ({ id: c.id, name: c.name, ...(logos[c.tvId] ? { icon: logos[c.tvId] } : {}) })),
    programmes,
    days: activeDates.length,
    failures: failuresCount,
    log,
  });
  return result;
}
