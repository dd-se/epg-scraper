// beIN Sports provider — beIN Sports 1..4 yayın akışı.
//
// Source: https://beinsports.com.tr/yayin-akisi/{channel}/{day}
// (e.g. https://beinsports.com.tr/yayin-akisi/beinsports-2/sali)
//
// Each page is server-rendered Next.js with the full guide embedded in a
// `__NEXT_DATA__` JSON script tag (discovered via chrome-devtools):
//
//   props.pageProps.days             — the 7 weekday tags (pazartesi..pazar)
//   props.pageProps.activeLeagues    — the beIN channels (rewriteId + channelId)
//   props.pageProps.data.event_date  — "YYYY-MM-DD" the day page actually serves
//   props.pageProps.data.listTvGuides — [{ channel_id, event_time: "HH:MM:SS",
//                                        name, ... }] for the selected channel
//
// Like Hürriyet, the site publishes exactly one Mon–Sun week: the weekday tag
// selects that week's day, so the provider clamps any requested window to the
// week containing its first date.  Times are Istanbul wall time with the
// fixed +03:00 offset; a programme's stop is the next programme's start (or
// end of day for the last slot), matching the mynet provider's convention.

import { decodeEntities } from '../entities.js';
import { fetchText } from '../http.js';
import { weekDays, wallToIso } from './hurriyet.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const BASE_URL = 'https://beinsports.com.tr';

// Day tags in URL order (Mon=0..Sun=6).  Matches slugForDate() from hurriyet.
export const DAY_TAGS = [
  'pazartesi',
  'sali',
  'carsamba',
  'persembe',
  'cuma',
  'cumartesi',
  'pazar',
];

// Curated channel-id map: display name -> XMLTV id normalized to the
// epgshare01 reference.  Exported so test/reference.test.mjs can enforce that
// every value exists in the vendored snapshot.
export const CHANNEL_ID_MAP = {
  'BEIN SPORTS 1': 'beIN.SPORTS.1.tr',
  'BEIN SPORTS 2': 'beIN.SPORTS.2.tr',
  'BEIN SPORTS 3': 'beIN.SPORTS.3.tr',
  'BEIN SPORTS 4': 'beIN.SPORTS.4.tr',
};

// Display name -> site URL slug (rewriteId).  The site itself also serves
// "bein-sports-haber", which is not part of this provider's channel list.
export const CHANNEL_REWRITES = {
  'BEIN SPORTS 1': 'beinsports',
  'BEIN SPORTS 2': 'beinsports-2',
  'BEIN SPORTS 3': 'beinsports-3',
  'BEIN SPORTS 4': 'beinsports-4',
};

export function normalizeChannelKey(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toUpperCase();
}

export function mapChannelId(name) {
  return CHANNEL_ID_MAP[normalizeChannelKey(name)];
}

export function channelRewrite(name) {
  return CHANNEL_REWRITES[normalizeChannelKey(name)];
}

export function dayPageUrl(rewriteId, dayTag) {
  return `${BASE_URL}/yayin-akisi/${rewriteId}/${dayTag}`;
}

// ---- Pure parsers (fixture-testable, no I/O) ----

function matchJson(source, pattern) {
  const match = pattern.exec(source);
  return match ? match[1] : undefined;
}

// Pull the pageProps out of the __NEXT_DATA__ script tag.
function pageProps(html) {
  const source = html == null ? '' : String(html);
  const json = matchJson(source, /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!json) return undefined;
  try {
    const data = JSON.parse(json);
    return data?.props?.pageProps;
  } catch {
    return undefined;
  }
}

// Parse a yayin-akisi page into the channels it advertises (activeLeagues).
// Degrades to [] on missing/malformed markup.
export function parseChannelList(html) {
  const props = pageProps(html);
  const leagues = Array.isArray(props?.activeLeagues) ? props.activeLeagues : [];
  const channels = [];
  const seen = new Set();
  for (const league of leagues) {
    const rewriteId = typeof league?.rewriteId === 'string' ? league.rewriteId : '';
    const channelId = league?.channelId;
    if (rewriteId && channelId != null && !seen.has(rewriteId)) {
      seen.add(rewriteId);
      channels.push({ rewriteId, channelId: Number(channelId) });
    }
  }
  return channels;
}

// Parse one day page into { date: "YYYY-MM-DD", slots: [{ channelId, startMin,
// title }] }.  Degrades to an empty result instead of crashing.
export function parseDayPage(html) {
  const props = pageProps(html);
  if (!props?.data || !Array.isArray(props.data.listTvGuides)) {
    return { date: undefined, slots: [] };
  }
  const { data } = props;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(data.event_date || ''))
    ? String(data.event_date)
    : undefined;
  const slots = [];
  for (const item of data.listTvGuides) {
    const title = typeof item?.name === 'string' ? decodeEntities(item.name).trim() : '';
    const time = typeof item?.event_time === 'string' ? item.event_time : '';
    const timeMatch = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(time.trim());
    if (!title || !timeMatch) continue;
    const hours = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2]);
    if (hours > 24 || minutes > 59) continue;
    slots.push({ channelId: Number(item.channel_id), startMin: hours * 60 + minutes, title });
  }
  return { date, slots };
}

// ---- scrape ----

// Scrape the requested window (clamped to the current Mon–Sun week).  A
// failed day page degrades to a warning, never a crash.
export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  politenessDelayMs = 300,
  fetchOptions = {},
} = {}) {
  const channelsById = new Map();
  const channels = [];
  const programmes = [];
  let failures = 0;

  const reference = dates && dates.length > 0 ? new Date(`${dates[0]}T12:00:00Z`) : new Date();
  const week = weekDays(reference);
  if (
    dates &&
    dates.length > 0 &&
    (dates[0] !== week[0] || dates[dates.length - 1] !== week[week.length - 1])
  ) {
    log(`note: beinsports publishes one Mon-Sun week; scraping ${week[0]}..${week[6]}`);
  }

  const tagsForWeek = week.map((date) => {
    const weekday = new Date(`${date}T12:00:00Z`).getUTCDay(); // 0=Sun..6=Sat
    return DAY_TAGS[(weekday + 6) % 7];
  });

  for (const name of Object.keys(CHANNEL_REWRITES)) {
    const id = mapChannelId(name);
    if (!channelsById.has(id)) {
      const entry = { id, name };
      channelsById.set(id, entry);
      channels.push(entry);
    }

    const rewriteId = channelRewrite(name);
    for (let i = 0; i < week.length; i++) {
      const date = week[i];
      const tag = tagsForWeek[i];
      const url = dayPageUrl(rewriteId, tag);
      let html;
      try {
        html = await fetchText(url, { fetchImpl, ...fetchOptions });
      } catch (error) {
        failures++;
        log(`warn: ${name} (${tag}) fetch failed: ${error.message}`);
        continue;
      }

      const { date: servedDate, slots } = parseDayPage(html);
      if (servedDate && servedDate !== date) {
        log(`warn: ${name} (${tag}) served ${servedDate}, expected ${date}`);
      }

      const [year, month, day] = date.split('-').map(Number);
      for (let s = 0; s < slots.length; s++) {
        const slot = slots[s];
        // The page only contains the selected channel's guide, so the slot's
        // channel is the one we fetched (channel_id in the payload matches).
        const start = wallToIso(year, month, day, slot.startMin);
        const endMin = s + 1 < slots.length ? slots[s + 1].startMin : 24 * 60;
        // Repeated times on a page (same slot listed twice) would make a
        // zero-length programme — skip it instead of emitting garbage.
        if (endMin <= slot.startMin) continue;
        const stop = wallToIso(year, month, day, endMin);
        programmes.push({ channel: id, start, stop, title: slot.title });
      }
      log(`ok:   ${name} (${tag}): ${slots.length} programmes`);
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

  return { channels, programmes: deduped, days: week.length, failures };
}
