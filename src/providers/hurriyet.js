// Hürriyet TV Rehberi provider.
//
// Source: https://www.hurriyet.com.tr/tv-rehberi/tum-programlar/{day}/
// Seven day pages (pazartesi..pazar) each carry the full grid for one weekday
// of the current week: a sticky channel rail (`flow-module-channel` entries)
// followed by one `flow-module-row` per channel, each row a sequence of
// `flow-module-col` slots (title, optional data-type genre, HH:MM-HH:MM).
// Pairing between the rail and the rows is positional.
//
// Times are Istanbul wall time; Turkey has been fixed at UTC+03:00 year-round
// since 2016, so the provider emits a single +03:00 offset.

import { decodeEntities } from '../entities.js';
import { channelIdFromName } from '../slug.js';
import { fetchText } from '../http.js';
import {
  wallToIso,
  weekDays,
  weekdayIndex,
  dedupeProgrammes,
  finishResult,
} from './shared.js';

// Re-exported for the other providers and tests that import the wall-clock
// and week helpers from this module (historical import site).
export { wallToIso, weekDays };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const BASE_URL = 'https://www.hurriyet.com.tr';
export const DAY_SLUGS = [
  'pazartesi',
  'sali',
  'carsamba',
  'persembe',
  'cuma',
  'cumartesi',
  'pazar',
];
// Curated channel-id map: epgshare01-compatible ids for the channels that do
// not survive the generic slug rule (case-sensitive ids, aliases, HD
// suffixes). Keys are normalized (uppercase, whitespace collapsed).
// Exported so test/reference.test.mjs can enforce that every value exists
// in the vendored epgshare01 snapshot (test/fixtures/epgshare01/).
export const CHANNEL_ID_MAP = {
  'KANAL D': 'KANAL.D.tr',
  'CNN TÜRK': 'CNN.TÜRK.tr',
  'STAR TV': 'STAR.TV.tr',
  'SHOW TV': 'SHOW.TV.tr',
  'ATV': 'ATV.tr',
  'TRT 1': 'TRT.1.tr',
  'TRT 3 - SPOR': 'TRT.SPOR.tr',
  'TRT SPOR': 'TRT.SPOR.tr',
  // Station aliases: the source of truth (epgshare01) lists these stations
  // under one id — NOW is the FOX rebrand, TV2 shares teve2's logo/feed.
  'NOW': 'FOX.tr',
  'TV2': 'TEVE2.tr',
  'TV8': 'TV8.tr',
  '360': '360.tr',
  'BLOOMBERG HT': 'BLOOMBERG.HT.tr',
  'A HABER': 'A.HABER.tr',
  'KANAL 7': 'KANAL.7.tr',
  '24 TV': '24.TV.tr',
  'HABERTÜRK': 'HABERTÜRK.tr',
  'BEYAZ TV': 'BEYAZ.TV.tr',
  'SİNEMA TV': 'SİNEMA.TV.HD.tr',
  'EUROSPORT 1': 'EUROSPORT.1.HD.tr',
  'EUROSPORT 2 INT': 'EUROSPORT.2.TR.HD.tr',
  'NATIONAL GEOGRAPHIC': 'NATIONAL.GEOGRAPHIC.tr',
  // Map KEYS are normalized (uppercased) by mapChannelId; VALUES keep the
  // exact mixed-case spelling the epgshare01 convention uses.
  'BEIN SPORTS 1': 'beIN.SPORTS.1.tr',
  'BEIN SPORTS 3': 'beIN.SPORTS.3.tr',
  'SPORTS TV': 'SPORTS.TV.tr',
  'TLC': 'TLC.tr',
  'NTV': 'NTV.tr',
  'TEVE2': 'TEVE2.tr',
  'DMAX': 'DMAX.tr',
  'CARTOON NETWORK': 'CARTOON.NETWORK.tr',
  'TRT BELGESEL': 'TRT.BELGESEL.tr',
  'DISNEY JUNIOR': 'DISNEY.JUNIOR.tr',
};

// data-type attribute -> XMLTV category label.
const CATEGORY_MAP = {
  eglence: 'Eğlence',
  dizi: 'Dizi',
  film: 'Film',
  haber: 'Haber',
  spor: 'Spor',
  yasam: 'Yaşam',
  belgesel: 'Belgesel',
  muzik: 'Müzik',
  cocuk: 'Çocuk',
  diger: 'Diğer',
};

export function normalizeChannelKey(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().toUpperCase();
}

export function mapChannelId(name) {
  return CHANNEL_ID_MAP[normalizeChannelKey(name)] || channelIdFromName(name);
}

export function dayPageUrl(slug) {
  return `${BASE_URL}/tv-rehberi/tum-programlar/${slug}/`;
}

function absolutize(href) {
  if (href == null) return undefined;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/')) return BASE_URL + href;
  return href;
}

// Logo URLs carry a deploy-version query ("?v=azure-…") that churns on
// every site release.  Strip it so guide diffs stay stable.
function stripQuery(href) {
  if (href == null) return undefined;
  const cut = String(href).split(/[?#]/, 1)[0];
  return cut || undefined;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ');
}

function collapseWhitespace(text) {
  return decodeEntities(text).replace(/\s+/g, ' ').trim();
}

function matchOne(source, pattern) {
  const match = pattern.exec(source);
  return match ? match[1] : undefined;
}

// Parse one day page into channels + slots (minutes since day start).
// Pure function: no I/O, fully fixture-testable.  A missing or non-string
// page (failed fetch, binary response, ...) degrades to an empty result
// instead of crashing.
export function parseDayPage(html) {
  const source = html == null ? '' : String(html);
  const channelBlocks = [...source.matchAll(/<li class="flow-module-channel">([\s\S]*?)<\/li>/g)].map(
    (m) => m[1]
  );
  const channels = channelBlocks
    .map((block) => {
      const name = collapseWhitespace(matchOne(block, /<img[^>]*\balt="([^"]*)"/) || '');
      if (!name) return undefined;
      const href = matchOne(block, /<a[^>]*\bhref="([^"]*)"/);
      const icon = stripQuery(matchOne(block, /<img[^>]*\bsrc="([^"]*)"/));
      return { name, url: absolutize(href), icon };
    })
    .filter(Boolean);

  const rowChunks = source.split('<div class="flow-module-row">').slice(1);
  const slots = [];
  for (const [rowIndex, row] of rowChunks.entries()) {
    // The browser-rendered page adds a 'passive' class to past time slots,
    // so match class starts with 'flow-module-col' rather than requiring an
    // exact class value.
    const colStarts = [...row.matchAll(/<div class="flow-module-col[^"]*"([^>]*)>/g)];
    for (const [colIndex, match] of colStarts.entries()) {
      const attrs = match[1];
      const start = match.index + match[0].length;
      const end = colIndex + 1 < colStarts.length ? colStarts[colIndex + 1].index : row.length;
      const inner = row.slice(start, end);

      const title = collapseWhitespace(
        matchOne(inner, /class="column-title">([\s\S]*?)(?:<a\s|<\/h2>)/) || ''
      );
      const time = /class="column-time">\s*([0-2]?\d):([0-5]\d)\s*-\s*([0-2]?\d):([0-5]\d)/.exec(
        inner
      );
      if (!title || !time) continue;

      const [, sh, sm, eh, em] = time;
      const startMin = Number(sh) * 60 + Number(sm);
      const endClock = Number(eh) * 60 + Number(em);
      const duration = (endClock - startMin + 1440) % 1440 || 1440;

      const dataType = matchOne(attrs, /data-type="([^"]*)"/);
      slots.push({
        channelIndex: rowIndex,
        title,
        category: CATEGORY_MAP[dataType],
        startMin,
        endMin: startMin + duration,
      });
    }
  }

  return { channels, slots, rowCount: rowChunks.length };
}

export function slugForDate(date) {
  return DAY_SLUGS[weekdayIndex(date)]; // Mon=0..Sun=6
}

// Scrape the whole week. `dates` (optional) only anchors the week: the source
// publishes exactly one Mon–Sun week, so whatever range arrives is clamped to
// the week containing its first date — otherwise a mid-week run would wrongly
// date next Monday's page with this Monday's data. A failed day page degrades
// to a warning, never a crash.
export async function scrape({
  dates = weekDays(),
  fetchImpl,
  log = () => {},
  politenessDelayMs = 250,
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
    log(`note: hurriyet publishes one Mon-Sun week; scraping ${week[0]}..${week[6]}`);
  }

  for (const date of week) {
    const slug = slugForDate(date);
    const url = dayPageUrl(slug);
    let html;
    try {
      html = await fetchText(url, { fetchImpl, ...fetchOptions });
    } catch (error) {
      failures++;
      log(`warn: ${date} (${slug}) fetch failed: ${error.message}`);
      continue;
    }

    const { channels: dayChannels, slots, rowCount } = parseDayPage(html);
    // Rail/row pairing is positional; surface divergence instead of guessing.
    if (rowCount !== dayChannels.length) {
      log(`warn: ${date}: ${dayChannels.length} rail channels vs ${rowCount} rows`);
    }

    const [year, month, day] = date.split('-').map(Number);
    for (const channel of dayChannels) {
      const id = mapChannelId(channel.name);
      if (!channelsById.has(id)) {
        const entry = {
          id,
          name: channel.name,
          icon: channel.icon,
          url: channel.url,
        };
        channelsById.set(id, entry);
        channels.push(entry);
      }
    }

    let skipped = 0;
    for (const slot of slots) {
      const channel = dayChannels[slot.channelIndex];
      if (!channel) {
        skipped++;
        continue;
      }
      const start = wallToIso(year, month, day, slot.startMin);
      const stop = wallToIso(year, month, day, slot.endMin);
      programmes.push({
        channel: mapChannelId(channel.name),
        start,
        stop,
        title: slot.title,
        category: slot.category,
      });
    }
    if (skipped > 0) {
      log(`warn: ${date}: ${skipped} slots skipped (row index without rail channel)`);
    }
    log(`ok:   ${date} (${slug}): ${dayChannels.length} channels, ${slots.length} slots`);
    await sleep(politenessDelayMs);
  }

  // Dedupe exact repeats and return in the canonical (channel, start) order.
  return finishResult({ channels, programmes, days: week.length, failures });
}