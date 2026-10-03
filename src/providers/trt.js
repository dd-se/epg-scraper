// TRT Yayın Akışı provider — the Turkish Radio and Television Corporation's
// own schedule pages (https://www.trthaber.com/yayin-akisi.html).
//
// The index links one page per channel **and** per date:
//
//   /yayin-akisi/{channel}/{DD-MM-YYYY}   e.g. /yayin-akisi/trt-haber/03-10-2026
//
// Each day page is static server-rendered HTML (no JS rendering, no API, no
// login) with the day's slots in one flat list:
//
//   <title>TRT Haber 03 Ekim 2026 tarihli Yayın Akışı - …</title>
//   <ul class="epg-list">
//     <li><div class="time">06:00</div><div class="program-name">Haber 06 (Canlı)</div></li>
//
// Two properties make this the cleanest Turkish source in the repo: the site is
// **per-date** (any date serves, so the requested window is honoured as given —
// no week clamp like hurriyet's), and every page names the date it serves in its
// <title>, so `parseServedDate()` verifies the response against the request
// instead of trusting the URL.
//
// The 11 channels served are TRT's national lineup; ids are normalized to the
// epgshare01 reference (epg_ripper_TR1.xml.gz), which keeps Turkish diacritics
// (TRT.ÇOCUK.tr, TRT.KURDİ.tr), lists TRT Avaz HD-only, and has no TRT 2 entry
// at all (acknowledged in reference.json knownGaps). Channels publish their
// next day at different times of day, so a tomorrow page can 404 in the morning
// — that degrades to a warning.
//
// Slots carry a start time only, so a programme's stop is derived from the next
// slot (24:00 for the last one) — the mynet/beinsports/idmantv convention.
// Times are Istanbul wall time; Turkey has been fixed at UTC+03:00 year-round
// since 2016, so the provider emits a single +03:00 offset.

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

export const BASE_URL = 'https://www.trthaber.com';
export const INDEX_URL = `${BASE_URL}/yayin-akisi.html`;

// Curated channel table: site slug, display name, epgshare01-compatible id.
// The names are the site's own (page titles and card alts), which is what the
// playlist consumer matches on after folding, so they are kept verbatim.
export const CHANNELS = [
  { slug: 'trt-1', name: 'TRT 1', id: 'TRT.1.tr' },
  { slug: 'trt-2', name: 'TRT 2', id: 'TRT.2.tr' },
  { slug: 'trt-haber', name: 'TRT Haber', id: 'TRT.HABER.tr' },
  { slug: 'trt-spor', name: 'TRT Spor', id: 'TRT.SPOR.tr' },
  // The site calls the second sports feed "TRT Spor 2" in its slug and "TRT
  // Spor Yıldız" in its title; upstream lists it as TRT Spor Yıldız.
  { slug: 'trt-spor-2', name: 'TRT Spor Yıldız', id: 'TRT.SPOR.YILDIZ.tr' },
  { slug: 'trt-belgesel', name: 'TRT Belgesel', id: 'TRT.BELGESEL.tr' },
  { slug: 'trt-cocuk', name: 'TRT Çocuk', id: 'TRT.ÇOCUK.tr' },
  { slug: 'trt-muzik', name: 'TRT Müzik', id: 'TRT.MÜZİK.tr' },
  { slug: 'trt-turk', name: 'TRT Türk', id: 'TRT.TÜRK.tr' },
  // Upstream lists TRT Avaz HD-only.
  { slug: 'trt-avaz', name: 'TRT Avaz', id: 'TRT.AVAZ.HD.tr' },
  { slug: 'trt-kurdi', name: 'TRT Kurdî', id: 'TRT.KURDİ.tr' },
];

// name -> XMLTV id, exported so test/reference.test.mjs can enforce that every
// curated id exists in the vendored epgshare01 snapshot.  Keys are normalized
// (uppercased, whitespace collapsed) so lookup is case/spacing-insensitive.
export const CHANNEL_ID_MAP = Object.fromEntries(
  CHANNELS.map((c) => [normalizeChannelKey(c.name), c.id])
);

export function mapChannelId(name) {
  return CHANNEL_ID_MAP[normalizeChannelKey(name)];
}

// ---- Pure parsers (fixture-testable, no I/O) ----

// Turkish month names as the site writes them in its <title>.
const MONTHS = {
  ocak: 1,
  şubat: 2,
  mart: 3,
  nisan: 4,
  mayıs: 5,
  haziran: 6,
  temmuz: 7,
  ağustos: 8,
  eylül: 9,
  ekim: 10,
  kasım: 11,
  aralık: 12,
};

// "TRT Haber 03 Ekim 2026 tarihli Yayın Akışı - …" -> "2026-10-03" (or
// undefined when the title is absent/unparseable).
export function parseServedDate(html) {
  const source = html == null ? '' : String(html);
  const title = /<title>([\s\S]*?)<\/title>/i.exec(source);
  if (!title) return undefined;
  const match = /(\d{1,2})\s+([A-Za-zÇĞİÖŞÜçğıöşü]+)\s+(\d{4})\s+tarihli/.exec(
    decodeEntities(title[1])
  );
  if (!match) return undefined;
  const day = Number(match[1]);
  const month = MONTHS[match[2].toLocaleLowerCase('tr-TR')];
  const year = Number(match[3]);
  if (!month || !isRealCalendarDate(year, month, day)) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// One `epg-list` slot: `<div class="time">06:00</div><div class="program-name">…</div>`.
// Times out of clock range and empty titles drop out; nothing here throws.
const SLOT_RE =
  /<li[^>]*>\s*<div class="time">\s*(\d{1,2}):(\d{2})\s*<\/div>\s*<div class="program-name">([\s\S]*?)<\/div>/g;

// The day's slots as [{ startMin, title }] in page order. A page without a
// list yields an empty array.
export function parseDayPage(html) {
  const source = html == null ? '' : String(html);
  const list = /<ul class="epg-list">([\s\S]*?)<\/ul>/.exec(source);
  if (!list) return [];
  const slots = [];
  let match;
  SLOT_RE.lastIndex = 0;
  while ((match = SLOT_RE.exec(list[1])) !== null) {
    const startMin = parseClockMinutes(Number(match[1]), Number(match[2]));
    if (startMin == null) continue;
    const title = decodeEntities(match[3]).replace(/\s+/g, ' ').trim();
    if (!title) continue;
    slots.push({ startMin, title });
  }
  return slots;
}

// Channel logos from the index page: each card links a channel/date page and
// carries that channel's `kanal-logo/…` image. Degrades to an empty map.
export function parseChannelLogos(html) {
  const source = html == null ? '' : String(html);
  const logos = new Map();
  const cardRe =
    /<a[^>]*href="([^"]*?)\/yayin-akisi\/([a-z0-9-]+)\/[0-9]{2}-[0-9]{2}-[0-9]{4}"[^>]*>\s*<img[^>]*src="([^"]+)"[^>]*>/gi;
  let match;
  while ((match = cardRe.exec(source)) !== null) {
    const slug = match[2].toLowerCase();
    const src = decodeEntities(match[3]).trim();
    if (logos.has(slug)) continue;
    if (!/^https?:\/\//i.test(src) || src.includes('|')) continue;
    logos.set(slug, src);
  }
  return logos;
}

// YYYY-MM-DD -> the DD-MM-YYYY path segment the site uses.
export function daySlug(date) {
  const { year, month, day } = splitDate(date);
  return [
    String(day).padStart(2, '0'),
    String(month).padStart(2, '0'),
    String(year),
  ].join('-');
}

export function dayPageUrl(slug, date) {
  return `${BASE_URL}/yayin-akisi/${slug}/${daySlug(date)}`;
}

// ---- scrape ----

// One index fetch (channel logos) plus one fetch per channel-day. A failed
// page degrades to a warning; the run only fails when it produced nothing. The
// served date is verified against the request, so a page that answers with the
// wrong day is skipped instead of misdated.
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
  const activeDates = dates && dates.length > 0 ? dates : defaultDates('Europe/Istanbul');
  const channels = CHANNELS.slice(0, maxChannels);
  const programmes = [];
  let failures = 0;

  if (channels.length === 0) {
    return finishResult({ channels: [], programmes, days: activeDates.length, failures, log });
  }

  // The index is the only place the per-channel logos are published; a failure
  // here costs the icons, not the schedule.
  let logos = new Map();
  try {
    logos = parseChannelLogos(await fetchText(INDEX_URL, { fetchImpl, ...fetchOptions }));
  } catch (error) {
    log(`warn: index fetch failed (channel logos unavailable): ${error.message}`);
  }

  const entries = channels.map((channel) => {
    const icon = logos.get(channel.slug);
    return icon ? { ...channel, icon } : { ...channel };
  });

  for (const channel of entries) {
    let slotCount = 0;
    for (const date of activeDates) {
      const url = dayPageUrl(channel.slug, date);
      let html;
      try {
        html = await fetchText(url, { fetchImpl, ...fetchOptions });
      } catch (error) {
        failures++;
        log(`warn: ${channel.name} ${date} fetch failed: ${error.message}`);
        continue;
      }

      const served = parseServedDate(html);
      if (served && served !== date) {
        failures++;
        log(`warn: ${channel.name} ${date} served ${served} instead — skipped`);
        continue;
      }

      const slots = parseDayPage(html);
      if (slots.length === 0) {
        log(`warn: ${channel.name} ${date} carried no schedule`);
        continue;
      }
      const { year, month, day } = splitDate(date);
      const emitted = deriveStartOnlyProgrammes(slots, {
        channel: channel.id,
        year,
        month,
        day,
      });
      programmes.push(...emitted);
      slotCount += emitted.length;
    }
    log(`ok:   ${channel.name}: ${slotCount} programmes over ${activeDates.length} day(s)`);
  }

  // Dedupe exact repeats and return in the canonical (channel, start) order.
  return finishResult({ channels: entries, programmes, days: activeDates.length, failures, log });
}