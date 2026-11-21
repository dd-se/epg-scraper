// D-Smart Go provider — the Erstream EPG service behind dsmartgo.com.tr.
//
// A channel page such as /tr/tv-izle/spor-smart/246003 is a React shell: the
// schedule is fetched client-side (no SSR data) from
//
//   GET https://global-epg-prod.erstream.com/Epg/GetChannelEpgWithRange
//       ?includeEnding=true&fillResponse=true&key=<public key>
//       &cmsId=<channel id>&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
//       &timezone=03&lang=tr
//
// `key` is a public client value published in the site's `site-config`
// response (data.site_config.servicesConfig.contentConfig.epg.apiKey); it is
// not a user secret.  Every scrape fetches site-config once to read the
// current key, so a rotation needs no code change.  The hardcoded
// `PUBLIC_API_KEY` is only a fallback for a failed config fetch, and
// `DSMART_EPG_KEY` overrides both.
// `timezone=03` makes the returned wall times line up with Turkey's fixed
// UTC+3 offset, so they can be stamped `+03:00` like every other Turkish
// guide (the site itself sends `01`, which shifts the wall clock two hours).
//
// The API serves every channel in D-Smart Go's live lineup (CATALOG_CHANNELS
// below documents the 2026-11-21 probe), but only the two D-Smart sports
// feeds are curated here — adding another channel is one row in CHANNELS plus
// a curated id, not a wholesale adoption of the catalog.  The response has
// no genre fields; start/stop come from `date` + `startHour`/`endHour` and
// `statusCode: 300` rows are filler placeholders.  Channel icons are fetched
// separately from D-Smart's CMS `v1/item/{cmsId}` records (`images[type=Logo]`),
// using the public CMS key delivered in the same `site-config` response.

import { fetchText, createPoliteFetch } from '../http.js';
import { defaultDates, finishResult, normalizeChannelKey, splitDate } from './shared.js';
import { isRealCalendarDate, parseClockMinutes, wallToInstant } from '../time.js';

export const BASE_URL = 'https://global-epg-prod.erstream.com/';
export const CMS_BASE_URL = 'https://iwxa44sbbqmf.merlincdn.net';
export const LANG_CODE = 'tr';
export const API_KEY_ENV = 'DSMART_EPG_KEY';
export const SITE_CONFIG_URL = 'https://bfogwjgq8dbp.merlincdn.net/client/site-config';
export const SITE_CONFIG_TOKEN_ENV = 'DSMART_SITE_CONFIG_TOKEN';

// Public client-side bearer token baked into dsmartgo.com.tr's main.js.  The
// site-config request 401s without it; it is shipped to every browser and is
// not a user credential.  Overridable via the environment if it rotates.
export const SITE_CONFIG_TOKEN = 'EhuPj4n9ZnCa2YPqEIXKrLYuhVtsYggCMRKtfPqP42f3bedb';

// Last-resort fallbacks, used only when the live config fetch fails.  The
// EPG API answers 200 with filler-only rows for a stale key, so a failed
// config fetch is logged as a warning and counted.  Logo lookups are cosmetic:
// a failed item request costs the channel its <icon>, not its schedule.
export const PUBLIC_API_KEY = 'pln1jFxpWu1AMwtH1PIU';
export const PUBLIC_CMS_API_KEY = 'a8fbff0087d146ddbfa26a13ebbf83c6';

const pad2 = (value) => String(value).padStart(2, '0');

// The full channel catalog the EPG endpoint carries (live probe 2026-11-21).
// Documented for coverage; only CHANNELS below is scraped.
export const CATALOG_CHANNELS = Object.freeze([
  { slug: 'kanal-d', cmsId: '245931', name: 'Kanal D' },
  { slug: 'atv', cmsId: '246030', name: 'ATV' },
  { slug: 'sinema-tv', cmsId: '246195', name: 'Sinema TV' },
  { slug: 'sinema-tv-2', cmsId: '246225', name: 'Sinema TV 2' },
  { slug: 'sinema-tv-aksiyon', cmsId: '246201', name: 'Sinema TV Aksiyon' },
  { slug: 'sinema-tv-aksiyon-2', cmsId: '246198', name: 'Sinema TV Aksiyon 2' },
  { slug: 'sinema-tv-aile', cmsId: '246204', name: 'Sinema TV Aile' },
  { slug: 'sinema-tv-aile-2', cmsId: '246207', name: 'Sinema TV Aile 2' },
  { slug: 'sinema-tv-comedy', cmsId: '246210', name: 'Sinema TV Comedy' },
  { slug: 'sinema-tv-comedy-2', cmsId: '246213', name: 'Sinema TV Comedy 2' },
  { slug: 'sinema-tv-1001', cmsId: '246216', name: 'Sinema TV 1001' },
  { slug: 'sinema-tv-1002', cmsId: '246219', name: 'Sinema TV 1002' },
  { slug: 'filmscreen-international', cmsId: '245985', name: 'Filmscreen International' },
  { slug: 'moviesmart-classic', cmsId: '246150', name: 'Moviesmart Classic' },
  { slug: 'moviesmart-turk', cmsId: '246147', name: 'Moviesmart Türk' },
  { slug: 'bbc-first', cmsId: '1314412', name: 'BBC First' },
  { slug: 'fx', cmsId: '246186', name: 'FX' },
  { slug: 'cosmoen', cmsId: '1301767', name: 'Cosmoen' },
  { slug: 'dizismart-max', cmsId: '246015', name: 'Dizismart Max' },
  { slug: 'ulusal-coklu-ekran', cmsId: '246258', name: 'Ulusal Çoklu Ekran' },
  { slug: 'tv2', cmsId: '245991', name: 'TV2' },
  { slug: 'show-tv', cmsId: '245949', name: 'Show TV' },
  { slug: 'star', cmsId: '245994', name: 'Star' },
  { slug: 'trt-1', cmsId: '245943', name: 'TRT 1' },
  { slug: 'kanal-7', cmsId: '246138', name: 'Kanal 7' },
  { slug: 'tv8', cmsId: '246132', name: 'TV8' },
  { slug: 'now', cmsId: '245997', name: 'NOW' },
  { slug: 'haber-coklu-ekran', cmsId: '246261', name: 'Haber Çoklu Ekran' },
  { slug: 'cnn-turk', cmsId: '245940', name: 'CNN Türk' },
  { slug: 'ntv', cmsId: '246120', name: 'NTV' },
  { slug: 'trt-haber', cmsId: '246024', name: 'TRT Haber' },
  { slug: 'haber-turk', cmsId: '246027', name: 'Haber Türk' },
  { slug: '24', cmsId: '246126', name: '24' },
  { slug: 'a-haber', cmsId: '246123', name: 'A Haber' },
  { slug: 'tlc', cmsId: '246069', name: 'TLC' },
  { slug: 'tv-100', cmsId: '246174', name: 'TV100' },
  { slug: 'cnbc-e', cmsId: '343791', name: 'CNBC-e' },
  { slug: 'ekol-tv', cmsId: '246255', name: 'Ekol TV' },
  { slug: 'beyaz-tv', cmsId: '246105', name: 'Beyaz TV' },
  { slug: 'tv-net', cmsId: '246090', name: 'TV Net' },
  { slug: 'haber-global', cmsId: '246144', name: 'Haber Global' },
  { slug: '360', cmsId: '246129', name: '360' },
  { slug: 'bloomberg-ht', cmsId: '246141', name: 'Bloomberg HT' },
  { slug: 'tgrt-haber', cmsId: '246066', name: 'TGRT Haber' },
  { slug: 'dmax', cmsId: '245961', name: 'DMAX' },
  { slug: 'tv-8-5', cmsId: '246159', name: 'TV8,5' },
  { slug: 'ulke-tv', cmsId: '246087', name: 'Ülke TV' },
  { slug: 'cnn-international', cmsId: '245973', name: 'CNN International' },
  { slug: 'bbc-world-news', cmsId: '245970', name: 'BBC World News' },
  { slug: 'a-para', cmsId: '246078', name: 'A Para' },
  { slug: 'gzt-tv', cmsId: '1029208', name: 'GZT TV' },
  { slug: 'bbc-earth', cmsId: '245967', name: 'BBC Earth' },
  { slug: 'viasat-history', cmsId: '246054', name: 'Viasat History' },
  { slug: 'docuscreen', cmsId: '245976', name: 'Docuscreen' },
  { slug: 'love-nature', cmsId: '246189', name: 'Love Nature' },
  { slug: 'discovery-channel', cmsId: '245964', name: 'Discovery Channel' },
  { slug: 'discovery-id', cmsId: '245955', name: 'Discovery ID' },
  { slug: 'national-geographic', cmsId: '246180', name: 'National Geographic' },
  { slug: 'national-geographic-wild', cmsId: '246183', name: 'National Geographic Wild' },
  { slug: 'tarih-tv', cmsId: '246246', name: 'Tarih TV' },
  { slug: 'trt-belgesel', cmsId: '246156', name: 'TRT Belgesel' },
  { slug: 'fashion-tv', cmsId: '245982', name: 'Fashion TV' },
  { slug: 'spor-coklu-ekran', cmsId: '246264', name: 'Spor Çoklu Ekran' },
  { slug: 'cosmosports', cmsId: '246009', name: 'Cosmo Sports' },
  { slug: 'tay-tv', cmsId: '246108', name: 'TAY TV (TJK TV)' },
  { slug: 'eurosport-1', cmsId: '245958', name: 'Eurosport 1' },
  { slug: 'eurosport-2', cmsId: '245979', name: 'Eurosport 2' },
  { slug: 'spor-smart', cmsId: '246003', name: 'Spor Smart' },
  { slug: 'spor-smart-2', cmsId: '246171', name: 'Spor Smart 2' },
  { slug: 'ht-spor', cmsId: '394506', name: 'HT Spor' },
  { slug: 'a-spor', cmsId: '246135', name: 'A Spor' },
  { slug: 'san-pablo-burgos-unicaja', cmsId: '1029214', name: 'San Pablo Burgos - Unicaja' },
  { slug: 'fb-tv', cmsId: '246057', name: 'FB TV' },
  { slug: 'sports-tv', cmsId: '246006', name: 'Sports TV' },
  { slug: 'trt-spor', cmsId: '245946', name: 'TRT Spor' },
]);

// Only these two feeds are curated and scraped.  Their ids are already in
// final form (see the channel-id rule in AGENTS.md).
export const CHANNELS = Object.freeze([
  { name: 'Spor Smart', cmsId: '246003', id: 'SPORSMART.tr' },
  { name: 'Spor Smart 2', cmsId: '246171', id: 'SPORSMART2.tr' },
]);

export const CHANNEL_ID_MAP = Object.freeze(
  Object.fromEntries(CHANNELS.map((channel) => [normalizeChannelKey(channel.name), channel.id]))
);

const ID_BY_CMS_ID = new Map(CHANNELS.map((channel) => [String(channel.cmsId), channel.id]));
const OFFSET = '+03:00';
const TIMEZONE = '03';

function envValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function buildSiteConfigUrl(version = '1.0.6', platform = 'web-desktop', timestamp = Date.now()) {
  const url = new URL(SITE_CONFIG_URL);
  url.searchParams.set('version', version);
  url.searchParams.set('platform', platform);
  url.searchParams.set('timestamp', String(timestamp));
  return url.toString();
}

// Extract the EPG key and the CMS settings used for channel logos from a
// site-config body.  Only the EPG key is mandatory: a config that omits the
// CMS block still yields a usable key (logos then use pinned defaults).
export function parseSiteConfig(text) {
  let payload;
  try {
    payload = JSON.parse(String(text == null ? '' : text));
  } catch {
    return undefined;
  }
  const config = payload?.data?.site_config?.servicesConfig?.contentConfig;
  const key = config?.epg?.apiKey;
  if (typeof key !== 'string' || !key.trim()) return undefined;
  const cmsKey = config?.cms?.apiKey;
  const cmsBase = config?.cms?.serviceBaseUrl;
  return {
    key: key.trim(),
    cmsApiKey: typeof cmsKey === 'string' && cmsKey.trim() ? cmsKey.trim() : undefined,
    cmsBaseUrl: typeof cmsBase === 'string' && /^https?:\/\//i.test(cmsBase.trim()) ? cmsBase.trim() : undefined,
  };
}

// Returns the key, the CMS settings for logo lookups, and whether the
// bootstrap request failed, so a fallback run still reports a failed request.
// The config is fetched even when DSMART_EPG_KEY is set: that override only
// replaces the EPG key, while CMS settings for logos must stay live too.
async function resolveSiteConfig({ env, fetchImpl, log, fetchOptions }) {
  const override = envValue(env, API_KEY_ENV);
  const token = envValue(env, SITE_CONFIG_TOKEN_ENV) || SITE_CONFIG_TOKEN;
  try {
    const text = await fetchText(buildSiteConfigUrl(), {
      fetchImpl,
      ...fetchOptions,
      // No retries override: the shared transport already treats 401 as
      // deterministic, while 5xx/429/network blips get the configured retries.
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${token}`,
        ...(fetchOptions?.headers || {}),
      },
    });
    const config = parseSiteConfig(text);
    if (config) return { ...config, key: override || config.key, failed: false };
    log('warn: D-Smart site config has no EPG key; using the pinned fallbacks');
  } catch (error) {
    log(`warn: D-Smart site config unavailable (${requestErrorSummary(error)}); using the pinned fallbacks`);
  }
  // With an env key the EPG run is still viable, so only the cosmetic CMS
  // settings fall back; otherwise report the failed bootstrap as a failure.
  return { key: override || PUBLIC_API_KEY, failed: !override };
}

export function buildEventsUrl(cmsId, date, { key, env = process.env } = {}) {
  const url = new URL('Epg/GetChannelEpgWithRange', BASE_URL);
  url.searchParams.set('includeEnding', 'true');
  url.searchParams.set('fillResponse', 'true');
  url.searchParams.set('key', key || envValue(env, API_KEY_ENV) || PUBLIC_API_KEY);
  url.searchParams.set('cmsId', String(cmsId));
  url.searchParams.set('startDate', String(date));
  // `endDate` is exclusive, so a one-day request asks for the next day.
  const { year, month, day } = splitDate(date);
  const next = nextDate(year, month, day);
  url.searchParams.set('endDate', `${next.year}-${pad2(next.month)}-${pad2(next.day)}`);
  url.searchParams.set('timezone', TIMEZONE);
  url.searchParams.set('lang', 'tr');
  return url.toString();
}

// The EPG response is a bare JSON array (no envelope).  Malformed bodies
// degrade to an empty list, never a crash.
export function parseApiPayload(text) {
  let payload;
  try {
    payload = JSON.parse(String(text == null ? '' : text));
  } catch {
    return [];
  }
  return Array.isArray(payload) ? payload : [];
}

export function buildChannelItemUrl(cmsId, { baseUrl = CMS_BASE_URL, lang = LANG_CODE } = {}) {
  const base = String(baseUrl || CMS_BASE_URL).replace(/\/+$/, '');
  const url = new URL(`${base}/v1/item/${encodeURIComponent(String(cmsId))}`);
  // The source's query key is misspelled (`langauge`); match it exactly.
  url.searchParams.set('mcdn-langauge-code', lang);
  url.searchParams.set('platform', 'web');
  return url.toString();
}

export function parseCmsItem(text) {
  let payload;
  try {
    payload = JSON.parse(String(text == null ? '' : text));
  } catch {
    return undefined;
  }
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : undefined;
}

// The CMS item carries a `Thumbnail` and a `Logo` image.  Prefer the Logo and
// reject junk URLs so a bad record costs only the icon.
export function parseChannelLogo(item) {
  const images = Array.isArray(item?.images) ? item.images : [];
  const logo = images.find(
    (image) =>
      image?.type === 'Logo' &&
      typeof image.url === 'string' &&
      /^https?:\/\//i.test(image.url) &&
      !image.url.includes('|')
  );
  return logo?.url;
}

function clockMinutes(value, { end = false } = {}) {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(String(value == null ? '' : value).trim());
  if (!match) return undefined;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  if (seconds > 59) return undefined;
  if (end && hours === 24 && minutes === 0 && seconds === 0) return 1440;
  return parseClockMinutes(hours, minutes);
}

function nextDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day + 1));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

// Parse one channel-day response into canonical programmes.  Only exact
// curated owners, real dates, valid wall clocks and real (statusCode 200)
// programmes survive.  A stop earlier than the start wraps to the next day.
export function parseDayEvents(events, expectedDay, cmsId) {
  const id = ID_BY_CMS_ID.get(String(cmsId));
  if (!id) return [];
  const { year, month, day } = splitDate(expectedDay);
  if (!isRealCalendarDate(year, month, day)) return [];
  const programmes = [];
  const seen = new Set();
  for (const item of Array.isArray(events) ? events : []) {
    if (!item || typeof item !== 'object') continue;
    if (Number(item.statusCode) !== 200) continue;
    if (String(item.cmsId) !== String(cmsId)) continue;
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})T00:00:00$/.exec(String(item.date || ''));
    if (
      !dateMatch ||
      !isRealCalendarDate(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3])) ||
      `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}` !== expectedDay
    ) {
      continue;
    }
    const title = typeof item.name === 'string' ? item.name.replace(/\s+/g, ' ').trim() : '';
    if (!title) continue;
    const startMin = clockMinutes(item.startHour);
    let endMin = clockMinutes(item.endHour, { end: true });
    if (startMin == null || endMin == null || endMin === startMin) continue;
    const wraps = endMin < startMin;
    if (wraps) endMin += 1440;
    const start = wallToInstant(year, month, day, startMin, OFFSET);
    const stopDay = wraps ? nextDate(year, month, day) : { year, month, day };
    const stop = wallToInstant(
      stopDay.year,
      stopDay.month,
      stopDay.day,
      wraps ? endMin - 1440 : endMin,
      OFFSET
    );
    if (!start || !stop || stop <= start) continue;
    const key = `${id}|${start}|${stop}`;
    if (seen.has(key)) continue;
    seen.add(key);
    programmes.push({ channel: id, start, stop, title });
  }
  programmes.sort((a, b) => a.channel.localeCompare(b.channel) || a.start.localeCompare(b.start));
  return programmes;
}

function requestErrorSummary(error) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status > 0) return `HTTP ${status}`;
  return 'request failed';
}

export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  politenessDelayMs = 300,
  maxChannels = Infinity,
  fetchOptions: inputFetchOptions = {},
  env = process.env,
} = {}) {
  const activeDates = dates && dates.length > 0 ? dates : defaultDates();
  const selectedChannels = CHANNELS.slice(0, maxChannels);
  const politeFetch = createPoliteFetch(fetchImpl, politenessDelayMs);
  const { key, failed: configFailed, cmsApiKey, cmsBaseUrl } = await resolveSiteConfig({
    env,
    fetchImpl: politeFetch,
    log,
    fetchOptions: inputFetchOptions,
  });
  const programmes = [];
  let failures = configFailed ? 1 : 0;

  // Channel logos come from D-Smart's CMS item records, not the EPG payload.
  // A failed lookup costs only the <icon>; the schedule is unaffected.
  const channelIcons = new Map();
  for (const channel of selectedChannels) {
    try {
      const text = await fetchText(buildChannelItemUrl(channel.cmsId, { baseUrl: cmsBaseUrl }), {
        fetchImpl: politeFetch,
        ...inputFetchOptions,
        headers: {
          accept: 'application/json',
          apiKey: cmsApiKey || PUBLIC_CMS_API_KEY,
          langCode: LANG_CODE,
          ...(inputFetchOptions.headers || {}),
        },
      });
      const icon = parseChannelLogo(parseCmsItem(text));
      if (icon) channelIcons.set(channel.id, icon);
      else log(`warn: no logo in D-Smart metadata for ${channel.name}`);
    } catch (error) {
      log(`warn: ${channel.name} logo lookup failed: ${requestErrorSummary(error)}`);
    }
  }

  for (const day of activeDates) {
    let dayCount = 0;
    for (const channel of selectedChannels) {
      const url = buildEventsUrl(channel.cmsId, day, { key });
      let text;
      try {
        text = await fetchText(url, {
          fetchImpl: politeFetch,
          ...inputFetchOptions,
          headers: { accept: 'application/json', ...(inputFetchOptions.headers || {}) },
        });
      } catch (error) {
        failures++;
        log(`warn: ${day} / ${channel.name} request failed: ${requestErrorSummary(error)}`);
        continue;
      }
      const parsed = parseDayEvents(parseApiPayload(text), day, channel.cmsId);
      programmes.push(...parsed);
      dayCount += parsed.length;
    }
    log(`ok:   ${day}: ${dayCount} programme(s)`);
  }

  return finishResult({
    channels: selectedChannels.map((channel) => {
      const icon = channelIcons.get(channel.id);
      return icon ? { id: channel.id, name: channel.name, icon } : { id: channel.id, name: channel.name };
    }),
    programmes,
    days: activeDates.length,
    failures,
    log,
  });
}
