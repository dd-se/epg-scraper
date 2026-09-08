// Mynet TV Rehberi provider.
//
// Source: https://www.mynet.com/tv-rehberi
// The main page lists 87+ channels as cards with links to individual
// per-channel schedule pages.  Each channel has three day pages:
//
//   /tv-rehberi/{slug}-yayin-akisi-bugun      — today
//   /tv-rehberi/{slug}-yayin-akisi-yarin      — tomorrow
//   /tv-rehberi/{slug}-yayin-akisi-sonraki-gun — day after tomorrow
//
// Each day page carries a flat <ul> of <li> items:
//   <strong class="program-time">HH:MM</strong>
//   <p class="program-name">Programme Name</p>
//
// The provider clamps the requested window to the 3 available days and
// fetches all discovered channels for each day.

import { decodeEntities } from '../entities.js';
import { channelIdFromName } from '../slug.js';
import { fetchText } from '../http.js';

export const BASE_URL = 'https://www.mynet.com';
export const MAIN_URL = `${BASE_URL}/tv-rehberi`;

// Day slug suffixes in URL order (today, tomorrow, day-after-tomorrow).
export const DAY_SLUGS = ['bugun', 'yarin', 'sonraki-gun'];

// Mynet channel slugs use lowercase kebab-case.  The XMLTV channel id is
// derived from the display name via the generic slug (UPPERCASE.DOTS.tr).
// A curated map overrides channels that need specific treatment: ids are
// normalized to the epgshare01 reference (epg_ripper_TR1.xml.gz), which
// keeps Turkish diacritics (CNN.TÜRK.tr, HABERTÜRK.tr, TRT.ÇOCUK.tr),
// lists some stations HD-only (A.NEWS.HD.tr, TRT.AVAZ.HD.tr,
// TRT.WORLD.HD.tr, DA.VINCI.LEARNING.HD.tr, beIN.SPORTS.HABER.HD.tr),
// and merges split feeds onto one id (TRT 3 / TRT SPOR -> TRT.SPOR.tr).
// Exported so test/reference.test.mjs can enforce that every value exists
// in the vendored epgshare01 snapshot (test/fixtures/epgshare01/).
export const CHANNEL_ID_MAP = {
  'ATV': 'ATV.tr',
  'KANAL D': 'KANAL.D.tr',
  'SHOW TV': 'SHOW.TV.tr',
  'STAR TV': 'STAR.TV.tr',
  'TRT 1': 'TRT.1.tr',
  'TV8': 'TV8.tr',
  'CNN TÜRK': 'CNN.TÜRK.tr',
  'CNN TURK': 'CNN.TÜRK.tr',
  'NTV': 'NTV.tr',
  'HABERTÜRK': 'HABERTÜRK.tr',
  'HABERTURK': 'HABERTÜRK.tr',
  'A HABER': 'A.HABER.tr',
  'AHABER': 'A.HABER.tr',
  'KANAL 7': 'KANAL.7.tr',
  '360': '360.tr',
  'TEVE2': 'TEVE2.tr',
  'BEYAZ TV': 'BEYAZ.TV.tr',
  'TV2': 'TV2.tr',
  '24 TV': '24.TV.tr',
  'BLOOMBERG HT': 'BLOOMBERG.HT.tr',
  'BLOOMBERG': 'BLOOMBERG.TV.tr',
  'A SPOR': 'A.SPOR.tr',
  'A NEWS': 'A.NEWS.HD.tr',
  'A2': 'A2.tr',
  'TLC': 'TLC.tr',
  'DMAX': 'DMAX.tr',
  'EUROSPORT 1': 'EUROSPORT.1.HD.tr',
  'EUROSPORT 2': 'EUROSPORT.2.TR.HD.tr',
  'SPORTS TV': 'SPORTS.TV.tr',
  'BEIN SPORTS HABER': 'beIN.SPORTS.HABER.HD.tr',
  'CARTOON NETWORK': 'CARTOON.NETWORK.tr',
  'DISNEY CHANNEL': 'DISNEY.CHANNEL.tr',
  'DISNEY JUNIOR': 'DISNEY.JUNIOR.tr',
  'DA VINCI': 'DA.VINCI.LEARNING.HD.tr',
  'NATIONAL GEOGRAPHIC': 'NATIONAL.GEOGRAPHIC.tr',
  'NATIONAL GEO.': 'NATIONAL.GEOGRAPHIC.tr',
  'NAT.GEO.WILD': 'NATIONAL.GEOGRAPHIC.WILD.tr',
  'BEIN SPORTS 1': 'beIN.SPORTS.1.tr',
  'BEIN SPORTS 3': 'beIN.SPORTS.3.tr',
  'TRT ÇOCUK': 'TRT.ÇOCUK.tr',
  'TRT MÜZİK': 'TRT.MÜZİK.tr',
  'TRT TURK': 'TRT.TÜRK.tr',
  'TRT KURDI': 'TRT.KURDİ.tr',
  'TRT AVAZ': 'TRT.AVAZ.HD.tr',
  'TRT WORLD': 'TRT.WORLD.HD.tr',
  'TRT 3 / TRT SPOR': 'TRT.SPOR.tr',
  'BENGÜTÜRK': 'BENGÜ.TÜRK.tr',
  'ÜLKE TV': 'ÜLKE.TV.tr',
  'EKOTURK': 'EKOTÜRK.tr',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function collapseWhitespace(text) {
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function matchOne(source, pattern) {
  const match = pattern.exec(source);
  return match ? match[1] : undefined;
}

export function normalizeChannelKey(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toUpperCase();
}

export function mapChannelId(name) {
  return CHANNEL_ID_MAP[normalizeChannelKey(name)] || channelIdFromName(name);
}

// Build the URL for a channel's day page.
export function channelDayUrl(slug, daySlug) {
  return `${MAIN_URL}/${slug}-yayin-akisi-${daySlug}`;
}

// Absolutize logo URLs: the cards use protocol-relative hosts
// ("//img7.mynet.com/...") and lazyload placeholders ("data:...").
function absolutizeLogo(value) {
  if (value == null) return undefined;
  const href = String(value).trim();
  if (!href || href.startsWith('data:')) return undefined;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('//')) return `https:${href}`;
  if (href.startsWith('/')) return BASE_URL + href;
  return href;
}

// Prefer the lazyload source (data-original) over the placeholder src.
function pickIcon(inner) {
  return (
    absolutizeLogo(matchOne(inner, /data-original="([^"]*)"/)) ||
    absolutizeLogo(matchOne(inner, /<img[^>]*\bsrc="([^"]*)"/))
  );
}

// Parse the main page to discover channel slugs, display names and logos.
// Pure function — no I/O.  Missing/non-string input degrades to [].
export function parseMainPage(html) {
  const source = html == null ? '' : String(html);
  const channels = [];
  const seen = new Set();
  // Match: <a href=".../{slug}-yayin-akisi-bugun" ...> ... <img alt="NAME" ...>
  const linkPattern =
    /<a[^>]*\bhref="[^"]*\/([a-z0-9-]+)-yayin-akisi-bugun"[^>]*>([\s\S]*?)<\/a>/gi;
  let linkMatch;
  while ((linkMatch = linkPattern.exec(source)) !== null) {
    const slug = linkMatch[1];
    const inner = linkMatch[2];
    const name = collapseWhitespace(matchOne(inner, /alt="([^"]*)"/) || '');
    if (slug && name && !seen.has(slug)) {
      seen.add(slug);
      const entry = { slug, name };
      const icon = pickIcon(inner);
      if (icon) entry.icon = icon;
      channels.push(entry);
    }
  }
  return channels;
}

// Parse a single channel day page into programme slots.
// Pure function — no I/O.  Missing/non-string input degrades to [].
export function parseChannelPage(html) {
  const source = html == null ? '' : String(html);
  const slots = [];
  // Each programme is an <li> with <strong class="program-time"> and
  // <p class="program-name">.  We match pairs in order.
  const timePattern = /class="program-time[^"]*">([^<]*)<\/strong>/g;
  const namePattern = /class="program-name[^"]*">([^<]*)<\/p>/g;

  const times = [];
  const names = [];
  let m;
  while ((m = timePattern.exec(source)) !== null) {
    times.push(collapseWhitespace(m[1]));
  }
  while ((m = namePattern.exec(source)) !== null) {
    names.push(collapseWhitespace(m[1]));
  }

  // Pair times with names by index.
  const count = Math.min(times.length, names.length);
  for (let i = 0; i < count; i++) {
    const timeMatch = /^(\d{1,2}):(\d{2})$/.exec(times[i]);
    if (!timeMatch) continue;
    const hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    // Out-of-clock garbage (99:99, 25:00, 10:99) would otherwise stamp
    // programmes days or hours into the future; drop the slot instead.
    if (hours > 24 || minutes > 59) continue;
    const startMin = hours * 60 + minutes;
    slots.push({ title: names[i], startMin });
  }
  return slots;
}

// Wall-clock date + minutes since midnight -> ISO instant with +03:00.
export function wallToIso(year, month, day, minutes) {
  const ms = Date.UTC(year, month - 1, day, 0, minutes);
  return new Date(ms).toISOString().slice(0, 19) + '+03:00';
}

// Compute Istanbul wall-clock date for a day offset from today.
function dayDate(offset) {
  const now = new Date();
  // Istanbul is UTC+3 year-round.
  const istanbulMs = now.getTime() + 3 * 3600000;
  const istanbulDate = new Date(istanbulMs);
  const y = istanbulDate.getUTCFullYear();
  const m = istanbulDate.getUTCMonth() + 1;
  const d = istanbulDate.getUTCDate();
  const ms = Date.UTC(y, m - 1, d + offset);
  const result = new Date(ms);
  return {
    year: result.getUTCFullYear(),
    month: result.getUTCMonth() + 1,
    day: result.getUTCDate(),
  };
}

// Convert dayDate() result to YYYY-MM-DD string.
function dateToString({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// Scrape the Mynet TV guide.  Fetches the main page to discover channels,
// then fetches up to 3 day pages per channel.
//
// Politeness note: a full run is 1 main page + ~90 channel pages per day
// (~260 requests for the 3-day window), so the default per-request delay is
// deliberately higher than hurriyet's (7 pages).  Override with
// `politenessDelayMs` / CLI `--delay-ms`.
export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  politenessDelayMs = 500,
  fetchOptions = {},
  maxChannels = Infinity,
} = {}) {
  const channelsById = new Map();
  const channels = [];
  const programmes = [];
  let failures = 0;

  // Step 1: Discover channels from the main page.
  let channelList;
  try {
    const mainHtml = await fetchText(MAIN_URL, { fetchImpl, ...fetchOptions });
    channelList = parseMainPage(mainHtml);
    log(`ok:   discovered ${channelList.length} channels from main page`);
  } catch (error) {
    log(`error: failed to fetch main page: ${error.message}`);
    return { channels: [], programmes: [], days: 0, failures: 1 };
  }

  if (channelList.length === 0) {
    log('warn: no channels found on main page');
    return { channels: [], programmes: [], days: 0, failures: 0 };
  }

  // Respect maxChannels limit (for testing / faster runs).
  if (maxChannels < channelList.length) {
    channelList = channelList.slice(0, maxChannels);
    log(`note: limited to ${maxChannels} channels`);
  }

  // Step 2: Determine which day slugs to fetch.
  // Mynet provides exactly 3 days: bugun, yarin, sonraki-gun.
  // Map requested dates to day slugs.
  const today = dayDate(0);
  const tomorrow = dayDate(1);
  const dayAfter = dayDate(2);
  const dayMap = [
    { date: dateToString(today), slug: 'bugun', offset: 0 },
    { date: dateToString(tomorrow), slug: 'yarin', offset: 1 },
    { date: dateToString(dayAfter), slug: 'sonraki-gun', offset: 2 },
  ];

  // Filter to only requested dates that fall within the 3-day window.
  const requestedDates = dates && dates.length > 0 ? dates : dayMap.map((d) => d.date);
  const activeDays = dayMap.filter((d) => requestedDates.includes(d.date));

  if (activeDays.length === 0) {
    log('warn: requested dates fall outside the 3-day window (today + 2 days)');
    return { channels: [], programmes: [], days: 0, failures: 0 };
  }

  log(`window: ${activeDays.map((d) => d.date).join(' .. ')} (${activeDays.length} day(s))`);

  // Step 3: Fetch each channel's schedule for each active day.
  for (const channel of channelList) {
    const id = mapChannelId(channel.name);
    if (!channelsById.has(id)) {
      const entry = {
        id,
        name: channel.name,
        url: `${MAIN_URL}/${channel.slug}-yayin-akisi-bugun`,
      };
      if (channel.icon) entry.icon = channel.icon;
      channelsById.set(id, entry);
      channels.push(entry);
    }

    for (const day of activeDays) {
      const url = channelDayUrl(channel.slug, day.slug);
      let html;
      try {
        html = await fetchText(url, { fetchImpl, ...fetchOptions });
      } catch (error) {
        failures++;
        log(`warn: ${channel.name} (${day.slug}) fetch failed: ${error.message}`);
        continue;
      }

      const slots = parseChannelPage(html);
      const { year, month, day: dayNum } = dayDate(day.offset);

      for (let i = 0; i < slots.length; i++) {
        const slot = slots[i];
        const start = wallToIso(year, month, dayNum, slot.startMin);
        // Stop time = next programme's start, or end of day (24:00 = 1440 min).
        const endMin = i + 1 < slots.length ? slots[i + 1].startMin : 24 * 60;
        const stop = wallToIso(year, month, dayNum, endMin);
        programmes.push({
          channel: id,
          start,
          stop,
          title: slot.title,
        });
      }

      await sleep(politenessDelayMs);
    }
  }

  // Dedupe exact repeats.
  const seen = new Set();
  const deduped = programmes.filter((p) => {
    const key = [p.channel, p.start, p.stop, p.title].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  log(`done:  ${channels.length} channels, ${deduped.length} programmes, ${failures} failures`);

  return { channels, programmes: deduped, days: activeDays.length, failures };
}
