// TV.nu (Schibsted) provider — the Swedish national channels plus the
// Nordic pay-TV feeds: SVT 1/2/SVT 24/SVT Barn/Kunskapskanalen, TV3, TV4
// (+ Film/Guld/Fakta), Kanal 5/9/10/11, TV6, Sjuan, TV8, TV10, TV12,
// SkyShowtime 1-2, SF Kanalen, Cartoon Network, Cartoonito, Disney Channel,
// Nickelodeon, Nick Jr., Nicktoons, Animal Planet, BBC Nordic, BBC Earth,
// Discovery Channel/Science, Investigation Discovery, H2, History, National
// Geographic, Nat Geo Wild, MTV, MTV Live, MTV 00s, MTV Hits, Trace Urban,
// Paramount Network and TLC.
//
// Source: https://www.tv.nu/kanal/{slug}?datum=YYYY-MM-DD
//
// tv.nu is a Next.js app, but every channel page still ships the whole
// schedule of one day as a JSON assignment inside the HTML (no JS rendering,
// no API, no login):
//
//   <script>__INITIAL_STATE__ = "{\"schedule\":{\"id\":51,\"name\":\"SVT1\",
//     \"slug\":\"svt1\",\"themedLogo\":{\"light\":{\"url\":\"https://…\"}},
//     \"broadcasts\":[{\"title\":\"Husdrömmar\",\"description\":\"…\",
//       \"genres\":[{\"name\":\"Dokumentär\",\"slug\":\"dokumentar\"}],
//       \"seasonNumber\":8,\"episodeNumber\":8,
//       \"broadcast\":{\"startTime\":1789636800000,\"endTime\":1789640400000}}]}}</script>
//
// Both `startTime` and `endTime` are **explicit absolute epoch milliseconds**,
// so — unlike most providers — stops never have to be derived from the next
// slot.  A day page runs 06:00 → 06:00 local, so the page for the *previous*
// date is fetched as well and slots are bucketed by the Stockholm calendar
// date they start on; a requested window is therefore complete from 00:00.
// (tv.nu also prunes already-aired slots from the current day intraday, so
// today's guide is partial by design — the same behaviour as beinsports.)
//
// Timestamps: the instants are absolute, and Sweden observes DST, so each
// timestamp is stamped with the Europe/Stockholm offset that was in effect at
// that instant (+01:00 winter, +02:00 summer) — never a bare `Z`, never
// fractional seconds.  This is the one deliberate difference from the Turkish
// providers, which pin a single +03:00 offset because Turkey has no DST; a
// fixed offset would shift every Swedish summer programme by an hour.
//
// Titles are Swedish and emitted verbatim; genres map onto <category> (first
// genre name) and `description` onto <desc>.  Channel logos are the page's
// own `themedLogo.light.url`.

import { fetchText } from '../http.js';
import { channelIdFromName } from '../slug.js';
import { normalizeChannelKey, finishResult, defaultDates } from './shared.js';

export { normalizeChannelKey };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const BASE_URL = 'https://www.tv.nu';

// Curated channel table: tv.nu page slug -> XMLTV id + display name.
//
// Ids are normalized to the Swedish epgshare01 guide
// (`epg_ripper_SE1.xml.gz`, vendored as test/fixtures/epgshare01/
// reference-se.json), whose ids carry a source tag: `[SVT1HD].SVT1.HD.se`.
// Quality variants (the FHD/HD/SD entries an IPTV playlist carries for one
// feed) collapse onto the single id the reference has, exactly like the
// Turkish providers collapse their HD/SD pairs.  The few requested channels
// the reference does not carry yet keep a generic slug from the curated
// display name (country `se`) and are acknowledged in
// reference-se.json `knownGaps`.
export const CHANNELS = [
  { slug: 'svt1', name: 'SVT 1', id: '[SVT1HD].SVT1.HD.se' },
  { slug: 'svt2', name: 'SVT 2', id: '[SVT2HD].SVT2.HD.se' },
  // SVT 24 and SVT Barn share one feed upstream (one combined epgshare01 id).
  { slug: 'svt24', name: 'SVT 24', id: '[COMSVHD].SVTB/SVT24.HD.se' },
  { slug: 'svt-barn', name: 'SVT Barn', id: channelIdFromName('SVT Barn', 'se') },
  { slug: 'kunskapskanalen', name: 'Kunskapskanalen', id: '[KUNSKHD].Kunskapskanalen.HD.se' },
  { slug: 'tv3', name: 'TV3', id: '[TV3HD].TV3.HD.se' },
  { slug: 'tv4', name: 'TV4', id: '[TV4HD].TV4.HD.se' },
  { slug: 'tv4-film', name: 'TV4 Film', id: '[TV4FILM].TV4.Film.se' },
  { slug: 'tv4-guld', name: 'TV4 Guld', id: '[TV4GULD].TV4.Guld.se' },
  { slug: 'tv4-fakta', name: 'TV4 Fakta', id: '[TV4FAKT].TV4.Fakta.se' },
  { slug: 'kanal-5', name: 'Kanal 5', id: '[KANL5HD].KANAL.5.HD.se' },
  { slug: 'tv6', name: 'TV6', id: '[TV6HD].TV6.HD.se' },
  { slug: 'sjuan', name: 'Sjuan', id: '[SJUHD].Sjuan.HD.se' },
  { slug: 'tv8', name: 'TV8', id: '[TV8HD].TV8.HD.se' },
  { slug: 'kanal-9', name: 'Kanal 9', id: '[KANAL9H].Kanal.9.HD.se' },
  { slug: 'tv10', name: 'TV10', id: '[TV10HD].TV10.HD.se' },
  { slug: 'kanal-10', name: 'Kanal 10', id: '[KANAL10].Kanal.10.se' },
  { slug: 'kanal-11', name: 'Kanal 11', id: '[KANL11H].Kanal.11.HD.se' },
  { slug: 'tv12', name: 'TV12', id: '[TV12HD].TV12.HD.se' },
  { slug: 'skyshowtime-1', name: 'SkyShowtime 1', id: '[SKYS1SV].SkyShowtime.1.se' },
  { slug: 'skyshowtime-2', name: 'SkyShowtime 2', id: '[SKYS2SV].SkyShowtime.2.se' },
  { slug: 'sf-kanalen', name: 'SF Kanalen', id: '[SFKANAL].SF.Kanalen.se' },
  { slug: 'cartoon-network', name: 'Cartoon Network', id: '[CARTNET].Cartoon.Network.se' },
  { slug: 'cartoonito', name: 'Cartoonito', id: '[CARTOSV].Cartoonito.se' },
  { slug: 'disney-channel', name: 'Disney Channel', id: channelIdFromName('Disney Channel', 'se') },
  { slug: 'nickelodeon', name: 'Nickelodeon', id: '[NICKEHD].Nickelodeon.HD.se' },
  { slug: 'nick-jr', name: 'Nick Jr.', id: '[NCKJRHD].Nick.Jr..HD.se' },
  { slug: 'nicktoons', name: 'Nicktoons', id: '[NICKTSW].Nicktoons.se' },
  { slug: 'animal-planet', name: 'Animal Planet', id: '[ANIPLHD].Animal.Planet.HD.se' },
  { slug: 'bbc-nordic', name: 'BBC Nordic', id: '[BBCNRDC].BBC.Nordic.se' },
  { slug: 'bbc-earth', name: 'BBC Earth', id: channelIdFromName('BBC Earth', 'se') },
  { slug: 'discovery-channel', name: 'Discovery Channel', id: '[DISCOHD].Discovery.Channel.HD.se' },
  { slug: 'discovery-science', name: 'Discovery Science', id: '[DISCSCI].Discovery.Science.se' },
  { slug: 'investigation-discovery', name: 'Investigation Discovery', id: '[IDSWE].ID.se' },
  { slug: 'h2', name: 'H2', id: '[H2HDSWE].H2.HD.se' },
  { slug: 'history-hd', name: 'History', id: '[HISTOSD].History.se' },
  {
    slug: 'national-geographic',
    name: 'National Geographic',
    id: '[NATGEHD].National.Geographic.HD.se',
  },
  {
    slug: 'national-geographic-wild',
    name: 'Nat Geo Wild',
    id: '[NATGWHD].National.Geographic.Wild.HD.se',
  },
  { slug: 'mtv', name: 'MTV', id: '[MTVSWHD].MTV.HD.se' },
  { slug: 'mtv-live-hd', name: 'MTV Live', id: '[MTVLHDE].MTV.Live.HD.se' },
  { slug: 'mtv-00s-europe', name: 'MTV 00s', id: '[MTV00EU].MTV.00s.Europe.se' },
  { slug: 'mtv-hits', name: 'MTV Hits', id: channelIdFromName('MTV Hits', 'se') },
  { slug: 'trace-urban-hd', name: 'Trace Urban', id: channelIdFromName('Trace Urban HD', 'se') },
  {
    slug: 'paramount-network-30228',
    name: 'Paramount Network',
    id: channelIdFromName('Paramount Network', 'se'),
  },
  { slug: 'tlc', name: 'TLC', id: '[TLCSWHD].TLC.HD.se' },
];

// name -> XMLTV id, exported so test/reference.test.mjs can enforce that
// every curated id exists in the vendored epgshare01 SE snapshot (or is an
// acknowledged gap).  Keys are normalized (uppercased) like the other
// providers' maps; the display name lives in CHANNELS[].name.
export const CHANNEL_ID_MAP = Object.fromEntries(
  CHANNELS.map((c) => [normalizeChannelKey(c.name), c.id])
);

export function mapChannelId(name) {
  return CHANNEL_ID_MAP[normalizeChannelKey(name)];
}

// The one endpoint this provider talks to: the schedule of one channel for
// one calendar day.
export function dayPageUrl(slug, date) {
  return `${BASE_URL}/kanal/${slug}?datum=${date}`;
}
// ---- Pure parsers (fixture-testable, no I/O) ----

// The page assigns the whole payload as a JSON *string* literal:
//   <script>__INITIAL_STATE__ = "{\"schedule\":{…}}"</script>
// so it is parsed twice: once to unwrap the JS string literal, once for the
// payload itself.  Never eval'd — a hostile page can only produce invalid
// JSON, which degrades to `undefined`.
const INITIAL_STATE_RE = /__INITIAL_STATE__\s*=\s*("(?:[^"\\]|\\.)*")/;

// Guard window for the epoch-ms instants the page publishes: 1970-01-01 →
// 2100-01-01.  A corrupt/hostile `startTime` can therefore never make us emit
// a timestamp outside a four-digit year (XMLTV cannot represent one).
const MIN_INSTANT_MS = 0;
const MAX_INSTANT_MS = Date.UTC(2100, 0, 1);

export function extractInitialState(html) {
  const match = INITIAL_STATE_RE.exec(String(html == null ? '' : html));
  if (!match) return undefined;
  try {
    return JSON.parse(JSON.parse(match[1]));
  } catch {
    return undefined;
  }
}

// Wall clock + UTC offset of an instant in the channel's own time zone.
// Sweden observes DST, so the offset is resolved per instant (+01:00 winter,
// +02:00 summer) instead of being pinned like the Turkish providers'.
const STOCKHOLM_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23', // 00..23 — never the "24:00" some locales use
  timeZoneName: 'longOffset', // "GMT+02:00"
});

const pad = (value) => String(value).padStart(2, '0');

export function stockholmWallClock(ms) {
  const parts = {};
  for (const part of STOCKHOLM_FORMAT.formatToParts(new Date(ms))) {
    parts[part.type] = part.value;
  }
  // "GMT+02:00" -> "+02:00"; plain "GMT" (UTC) -> "+00:00".  Anything
  // unexpected degrades to +00:00 rather than emitting a malformed offset.
  const raw = typeof parts.timeZoneName === 'string' ? parts.timeZoneName : '';
  const offset = raw === 'GMT' ? '+00:00' : raw.replace(/^GMT/, '');
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    offset: /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '+00:00',
  };
}

// Absolute epoch ms -> ISO 8601 with the Stockholm offset in force at that
// instant ("2026-09-07T06:00:00+02:00").  No fractional seconds, never a bare
// UTC marker; undefined when the parts are not a usable wall clock.
export function epochToIso(ms) {
  if (!Number.isFinite(ms)) return undefined;
  const p = stockholmWallClock(ms);
  if (![p.year, p.month, p.day, p.hour, p.minute, p.second].every(Number.isInteger)) {
    return undefined;
  }
  return (
    `${String(p.year).padStart(4, '0')}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${p.offset}`
  );
}

// Epoch ms -> the Stockholm calendar date it falls on (YYYY-MM-DD).
export function stockholmDate(ms) {
  const iso = epochToIso(ms);
  return iso ? iso.slice(0, 10) : undefined;
}


// Coerce a page-published instant to epoch ms, rejecting anything that is not
// a finite number inside the guard window (strings of digits are accepted; a
// hostile object/null/NaN/Infinity is not).
function toInstantMs(value) {
  const ms =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : NaN;
  if (!Number.isFinite(ms) || ms < MIN_INSTANT_MS || ms > MAX_INSTANT_MS) return undefined;
  return Math.round(ms);
}

// Trim + collapse whitespace; non-strings degrade to undefined (never emit a
// title/desc that is not a string).
function cleanText(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.replace(/\s+/g, ' ').trim();
  return text === '' ? undefined : text;
}

// Only well-formed http(s) URLs are kept — a pipe-joined or whitespace-laden
// `src` (a known upstream scraping artifact) must never reach the guide.
function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\/[^\s|]+$/.test(value.trim());
}

// The channel logo: `themedLogo.light.url` (the light-theme variant the
// desktop page shows), with the dark variant as a fallback.
function pickLogo(themedLogo) {
  if (!themedLogo || typeof themedLogo !== 'object') return undefined;
  for (const theme of ['light', 'dark']) {
    const entry = themedLogo[theme];
    const url = entry && typeof entry === 'object' ? entry.url : undefined;
    if (isHttpUrl(url)) return url.trim();
  }
  return undefined;
}

// First genre name ("Dokumentär") — the site's own <category> equivalent.
function firstGenreName(genres) {
  if (!Array.isArray(genres)) return undefined;
  for (const genre of genres) {
    const name = genre && typeof genre === 'object' ? cleanText(genre.name) : undefined;
    if (name) return name;
  }
  return undefined;
}

// Episode label using the site's own wording ("Säsong 8, Avsnitt 8").
function episodeLabel(entry) {
  const season = Number.isInteger(entry.seasonNumber) ? entry.seasonNumber : undefined;
  const episode = Number.isInteger(entry.episodeNumber) ? entry.episodeNumber : undefined;
  if (season == null && episode == null) return undefined;
  if (season != null && episode != null) return `Säsong ${season}, Avsnitt ${episode}`;
  return episode != null ? `Avsnitt ${episode}` : `Säsong ${season}`;
}

// One broadcasts[] entry -> an internal slot, or undefined when the entry is
// unusable (missing/reversed/zero-length times, no title).  A corrupt slot
// must never reach the merge/compare pipeline.
export function parseBroadcast(entry) {
  if (!entry || typeof entry !== 'object') return undefined;
  const times = entry.broadcast;
  if (!times || typeof times !== 'object') return undefined;

  const startMs = toInstantMs(times.startTime);
  const stopMs = toInstantMs(times.endTime);
  if (startMs == null || stopMs == null || stopMs <= startMs) return undefined;

  const title = cleanText(entry.title);
  if (!title) return undefined;

  const start = epochToIso(startMs);
  const stop = epochToIso(stopMs);
  if (!start || !stop) return undefined;

  return {
    startMs,
    stopMs,
    start,
    stop,
    // The Stockholm calendar date the slot starts on — the bucket the scraper
    // matches against the requested window.
    date: start.slice(0, 10),
    title,
    desc: cleanText(entry.description),
    category: firstGenreName(entry.genres),
    subTitle: episodeLabel(entry),
  };
}

// A channel-day page -> { ok, name, slug, logo, slots }.  `ok: false` means
// the page carried no readable schedule state at all (an error/consent page
// or a markup change) — distinct from a channel that legitimately has zero
// broadcasts that day (e.g. MTV Hits), which parses to `slots: []`.
export function parseChannelPage(html) {
  const state = extractInitialState(html);
  const schedule = state && typeof state === 'object' ? state.schedule : undefined;
  if (!schedule || typeof schedule !== 'object') {
    return { ok: false, slots: [] };
  }
  const broadcasts = Array.isArray(schedule.broadcasts) ? schedule.broadcasts : [];
  const slots = [];
  for (const entry of broadcasts) {
    const slot = parseBroadcast(entry);
    if (slot) slots.push(slot);
  }
  slots.sort((a, b) => a.startMs - b.startMs);
  return {
    ok: true,
    name: cleanText(schedule.name),
    slug: cleanText(schedule.slug),
    logo: pickLogo(schedule.themedLogo),
    slots,
  };
}

// The page's own channel logo without reaching into the parse result.
export function parseChannelLogo(html) {
  return parseChannelPage(html).logo;
}
// ---- scrape ----

// The calendar day before a YYYY-MM-DD date (undefined when the input is not
// a plain date).
export function previousDate(date) {
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms - 86400000).toISOString().slice(0, 10);
}

// Scrape the requested window: one page per channel and day.  A day page runs
// 06:00 → 06:00 local, so the day before the window start is fetched too —
// its tail carries the 00:00–06:00 slots of the first requested date.  Slots
// are kept only when the Stockholm date they start on is inside the window,
// so the extra page can never widen it.  A failed page degrades to a warning;
// only a run that produces no data at all is a failure.
export async function scrape({
  dates,
  fetchImpl,
  log = () => {},
  politenessDelayMs = 400,
  maxChannels = Infinity,
  fetchOptions = {},
} = {}) {
  const activeDates = dates && dates.length > 0 ? dates : defaultDates();
  const requested = [...new Set(activeDates)].sort();
  const requestedSet = new Set(requested);

  const before = previousDate(requested[0]);
  const fetchDates = before ? [before, ...requested] : requested;

  const channels = CHANNELS.slice(0, maxChannels);
  const programmes = [];
  const channelIcons = new Map(); // channel id -> page logo
  let failures = 0;

  for (const channel of channels) {
    let inWindow = 0;
    for (const date of fetchDates) {
      const url = dayPageUrl(channel.slug, date);
      let html;
      try {
        html = await fetchText(url, { fetchImpl, ...fetchOptions });
      } catch (error) {
        failures++;
        log(`warn: ${channel.name} ${date} fetch failed: ${error.message}`);
        await sleep(politenessDelayMs);
        continue;
      }

      const parsed = parseChannelPage(html);
      if (!parsed.ok) {
        // The channel page exists (HTTP 200) but carried no schedule state:
        // a consent/error page or a markup change.  Counted as a failure so
        // the CLI's summary surfaces it, but it never aborts the run.
        failures++;
        log(`warn: ${channel.name} ${date} carried no schedule state`);
      } else {
        if (parsed.logo && !channelIcons.has(channel.id)) channelIcons.set(channel.id, parsed.logo);
        for (const slot of parsed.slots) {
          if (!requestedSet.has(slot.date)) continue;
          inWindow++;
          programmes.push({
            channel: channel.id,
            start: slot.start,
            stop: slot.stop,
            title: slot.title,
            subTitle: slot.subTitle,
            desc: slot.desc,
            category: slot.category,
          });
        }
      }
      await sleep(politenessDelayMs);
    }
    log(`ok:   ${channel.name}: ${inWindow} slot(s) in window`);
  }

  // Dedupe exact repeats (a slot spanning the 06:00 page boundary can appear
  // twice) and return in the canonical (channel, start) order.
  return finishResult({
    channels: channels.map((c) => {
      const icon = channelIcons.get(c.id);
      return icon ? { id: c.id, name: c.name, icon } : { id: c.id, name: c.name };
    }),
    programmes,
    days: requested.length,
    failures,
  });
}
