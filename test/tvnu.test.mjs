import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  extractInitialState,
  epochToIso,
  stockholmDate,
  stockholmWallClock,
  parseBroadcast,
  parseChannelPage,
  parseChannelLogo,
  previousDate,
  dayPageUrl,
  mapChannelId,
  normalizeChannelKey,
  scrape,
  CHANNELS,
  CHANNEL_ID_MAP,
  BASE_URL,
} from '../src/providers/tvnu.js';
import { runCli } from '../src/cli.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/tvnu/${name}`, import.meta.url)), 'utf8');

// Live snapshot of https://www.tv.nu/kanal/svt1?datum=2026-09-17 (fetched
// 2026-09-17) reduced to its first four broadcasts; SVT1's 11:20–15:00 block.
const svt1Day = fixture('svt1-2026-09-17.html');
// Live snapshot of https://www.tv.nu/kanal/tv4-fotboll?datum=2026-09-17
// (fetched 2026-09-17): 7 sport broadcasts incl. BK Häcken–Mjällby 11:00.
const fotbollDay = fixture('tv4-fotboll-2026-09-17.html');
// Live snapshot of https://www.tv.nu/kanal/fight-sports?datum=2026-09-17:
// 22 event rows (boxing/kickboxing/Muay Thai listings).
const fightSportsDay = fixture('fight-sports-2026-09-17.html');
// Live snapshot of https://www.tv.nu/kanal/v-sport-1?datum=2026-09-17:
// 12 broadcasts (Allsvenskan, Serie A ...).
const vSport1Day = fixture('v-sport-1-2026-09-17.html');
// Live snapshot of https://www.tv.nu/kanal/v-sport-live-1?datum=2026-09-17:
// one rolling "next live event" placeholder day.
const vSportLive1Day = fixture('v-sport-live-1-2026-09-17.html');
// Live snapshot of https://www.tv.nu/kanal/eurosport-1?datum=2026-09-17.
const eurosport1Day = fixture('eurosport-1-2026-09-17.html');
// Live snapshot of https://www.tv.nu/kanal/tv4-sportkanalen?datum=2026-09-17:
// 21 broadcasts (Fiskedestination, Stjärnkusken, Wikegård vs, ...).
const sportkanalenDay = fixture('tv4-sportkanalen-2026-09-17.html');
// Live snapshot of https://www.tv.nu/kanal/tv4-sport-live-1?datum=2026-09-17:
// one item starting the following day, outside a September 17-only window.
const sportLiveDay = fixture('tv4-sport-live-1-2026-09-17.html');
// Hand-built page-pair covering the 06:00 → 06:00 day boundary.
const windowPrev = fixture('window-prev-2026-09-16.html');
const windowDay = fixture('window-day-2026-09-17.html');
const emptyDay = fixture('empty-day.html');
const hostile = fixture('hostile.html');
const hostileSlots = fixture('hostile-slots.html');
const noState = fixture('no-state.html');
const badJson = fixture('bad-json.html');

const response = (html) => ({ ok: true, status: 200, text: async () => html });

// Route a stubbed fetch by URL parts, like the live site (slug + datum).
const stubFetch = (routes) => async (url) => {
  const target = String(url);
  for (const [needle, html] of Object.entries(routes)) {
    if (needle.split('&').every((part) => target.includes(part))) return response(html);
  }
  return { ok: false, status: 404, text: async () => 'not found' };
};

describe('tvnu pure parsers', () => {
  it('unwraps the __INITIAL_STATE__ JSON string assignment', () => {
    const state = extractInitialState(svt1Day);
    expect(state.schedule.name).toBe('SVT1');
    expect(Array.isArray(state.schedule.broadcasts)).toBe(true);
    expect(Object.keys(state)).toContain('channelList');
  });

  it('degrades to undefined when the page carries no usable state', () => {
    expect(extractInitialState(noState)).toBeUndefined();
    expect(extractInitialState(badJson)).toBeUndefined();
    expect(extractInitialState('')).toBeUndefined();
    expect(extractInitialState(null)).toBeUndefined();
    expect(extractInitialState(undefined)).toBeUndefined();
    // An object literal (never the site's shape) must not be eval'd either.
    expect(extractInitialState('<script>__INITIAL_STATE__ = {a:1}</script>')).toBeUndefined();
  });

  it('stamps each instant with the Stockholm offset in force (DST aware)', () => {
    // Summer: CEST (+02:00); winter: CET (+01:00).
    expect(epochToIso(Date.UTC(2026, 8, 17, 9, 20))).toBe('2026-09-17T11:20:00+02:00');
    expect(epochToIso(Date.UTC(2026, 0, 5, 12, 0))).toBe('2026-01-05T13:00:00+01:00');
    // Spring forward: 01:59+01:00 is followed by 03:00+02:00.
    expect(epochToIso(Date.UTC(2026, 2, 29, 0, 59))).toBe('2026-03-29T01:59:00+01:00');
    expect(epochToIso(Date.UTC(2026, 2, 29, 1, 0))).toBe('2026-03-29T03:00:00+02:00');
    // Autumn back: the 02:00–03:00 wall hour happens twice.
    expect(epochToIso(Date.UTC(2026, 9, 25, 0, 30))).toBe('2026-10-25T02:30:00+02:00');
    expect(epochToIso(Date.UTC(2026, 9, 25, 1, 0))).toBe('2026-10-25T02:00:00+01:00');
    // Never fractional seconds, never a bare UTC marker.
    expect(epochToIso(Date.UTC(2026, 8, 17, 9, 20) + 1500)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/
    );
    expect(epochToIso(NaN)).toBeUndefined();
    expect(epochToIso(Infinity)).toBeUndefined();
  });

  it('reports the Stockholm wall clock and calendar date', () => {
    expect(stockholmWallClock(Date.UTC(2026, 8, 17, 9, 20))).toEqual({
      year: 2026,
      month: 9,
      day: 17,
      hour: 11,
      minute: 20,
      second: 0,
      offset: '+02:00',
    });
    // 22:15 UTC is already the next Stockholm date in summer.
    expect(stockholmDate(Date.UTC(2026, 8, 16, 22, 15))).toBe('2026-09-17');
    expect(stockholmDate(Date.UTC(2026, 8, 17, 21, 59))).toBe('2026-09-17');
    expect(stockholmDate(NaN)).toBeUndefined();
  });

  it('parses one broadcasts[] entry into an internal slot', () => {
    const state = extractInitialState(svt1Day);
    const entry = state.schedule.broadcasts[0];
    expect(parseBroadcast(entry)).toEqual({
      startMs: entry.broadcast.startTime,
      stopMs: entry.broadcast.endTime,
      start: '2026-09-17T11:20:00+02:00',
      stop: '2026-09-17T12:20:00+02:00',
      date: '2026-09-17',
      title: 'Husdrömmar',
      desc: expect.stringContaining('Tiny House'),
      category: 'Dokumentär',
      subTitle: 'Säsong 8, Avsnitt 8',
    });
  });

  it('drops null, untitled, reversed, zero-length and impossible slots', () => {
    const { slots } = parseChannelPage(hostileSlots);
    expect(slots.map((s) => s.title)).toEqual(['Good slot', 'Genres']);
    expect(slots[0]).toEqual({
      startMs: Date.UTC(2026, 8, 17, 8, 0),
      stopMs: Date.UTC(2026, 8, 17, 9, 30),
      start: '2026-09-17T10:00:00+02:00',
      stop: '2026-09-17T11:30:00+02:00',
      date: '2026-09-17',
      title: 'Good slot',
      desc: undefined,
      category: undefined,
      subTitle: 'Avsnitt 3', // seasonNumber "x" is not an integer -> dropped
    });
    // Hostile genre entries are skipped until a usable name turns up.
    expect(slots[1].category).toBe('Drama');
  });
it('rejects hostile broadcast payloads one by one', () => {
    expect(parseBroadcast(null)).toBeUndefined();
    expect(parseBroadcast(undefined)).toBeUndefined();
    expect(parseBroadcast('nope')).toBeUndefined();
    expect(parseBroadcast({})).toBeUndefined();
    expect(parseBroadcast({ title: 'x' })).toBeUndefined();
    expect(parseBroadcast({ title: 'x', broadcast: 'nope' })).toBeUndefined();
    // zero length / reversed
    expect(parseBroadcast({ title: 'x', broadcast: { startTime: 0, endTime: 0 } })).toBeUndefined();
    expect(parseBroadcast({ title: 'x', broadcast: { startTime: 2, endTime: 1 } })).toBeUndefined();
    // outside the guard window, on both ends
    expect(parseBroadcast({ title: 'x', broadcast: { startTime: -1, endTime: 10 } })).toBeUndefined();
    expect(
      parseBroadcast({ title: 'x', broadcast: { startTime: 1e15, endTime: 1e15 + 1 } })
    ).toBeUndefined();
    // non-finite and non-string titles
    expect(
      parseBroadcast({ title: 'x', broadcast: { startTime: Infinity, endTime: Infinity } })
    ).toBeUndefined();
    expect(parseBroadcast({ title: 5, broadcast: { startTime: 1, endTime: 2 } })).toBeUndefined();
    expect(parseBroadcast({ title: '   ', broadcast: { startTime: 1, endTime: 2 } })).toBeUndefined();
    // Numeric strings are accepted (the page sometimes serializes them).
    expect(
      parseBroadcast({
        title: 'ok',
        broadcast: { startTime: '1789640400000', endTime: '1789644000000' },
      })
    ).toMatchObject({ start: '2026-09-17T12:20:00+02:00', stop: '2026-09-17T13:20:00+02:00' });
  });

  it('parses a channel-day page and its logo', () => {
    const parsed = parseChannelPage(svt1Day);
    expect(parsed.ok).toBe(true);
    expect(parsed.name).toBe('SVT1');
    expect(parsed.slug).toBe('svt1');
    expect(parsed.logo).toBe('https://new.static.tv.nu/47578019');
    expect(parsed.slots.map((s) => s.start)).toEqual([
      '2026-09-17T11:20:00+02:00',
      '2026-09-17T12:20:00+02:00',
      '2026-09-17T13:20:00+02:00',
      '2026-09-17T13:25:00+02:00',
    ]);
    expect(parseChannelLogo(svt1Day)).toBe('https://new.static.tv.nu/47578019');
  });

  it('distinguishes a missing state from a legitimately empty day', () => {
    const empty = parseChannelPage(emptyDay);
    expect(empty.ok).toBe(true); // MTV Hits simply has nothing scheduled
    expect(empty.slots).toEqual([]);
    expect(empty.logo).toBe('https://new.static.tv.nu/372093914');

    expect(parseChannelPage(noState).ok).toBe(false);
    expect(parseChannelPage(badJson).ok).toBe(false);
  });

  it('degrades malformed channel fields instead of throwing', () => {
    const parsed = parseChannelPage(hostile);
    expect(parsed.ok).toBe(true);
    expect(parsed.name).toBeUndefined(); // numeric name
    expect(parsed.slug).toBeUndefined(); // null slug
    expect(parsed.logo).toBeUndefined(); // pipe-joined + non-http variants
    expect(parsed.slots).toEqual([]); // non-array broadcasts
  });

  it('builds day URLs and walks back one day', () => {
    expect(dayPageUrl('svt1', '2026-09-17')).toBe(`${BASE_URL}/kanal/svt1?datum=2026-09-17`);
    expect(previousDate('2026-09-17')).toBe('2026-09-16');
    expect(previousDate('2026-03-01')).toBe('2026-02-28');
    expect(previousDate('2026-01-01')).toBe('2025-12-31');
    expect(previousDate('nope')).toBeUndefined();
  });

  it('keeps the curated channel table consistent and normalized', () => {
    const slugs = CHANNELS.map((c) => c.slug);
    const ids = CHANNELS.map((c) => c.id);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(new Set(ids).size).toBe(ids.length);
    for (const channel of CHANNELS) {
      expect(channel.id.endsWith('.se')).toBe(true);
      expect(channel.name.length).toBeGreaterThan(0);
    }
    expect(CHANNELS).toHaveLength(69);
    // Ids are the Swedish epgshare01 ones where upstream carries them.
    expect(CHANNEL_ID_MAP['SVT 1']).toBe('[SVT1HD].SVT1.HD.se');
    expect(CHANNEL_ID_MAP['KANAL 5']).toBe('[KANL5HD].KANAL.5.HD.se');
    expect(mapChannelId('nat geo wild')).toBe('[NATGWHD].National.Geographic.Wild.HD.se');
    // Channels the reference does not carry keep a generic .se slug.
    expect(mapChannelId('SVT Barn')).toBe('SVT.BARN.se');
    expect(mapChannelId('Paramount Network')).toBe('PARAMOUNT.NETWORK.se');
    expect(mapChannelId('No Such Channel')).toBeUndefined();
    expect(normalizeChannelKey('  nat   geo wild ')).toBe('NAT GEO WILD');
  });
});
describe('tvnu scrape (stubbed fetch)', () => {
  // svt1 has the 06:00 → 06:00 day boundary fixtures; every other channel in
  // the curated table gets the empty-day fixture so only one channel carries
  // slots and the assertions stay readable.
  const routes = (extra = {}) => ({
    'kanal/svt1?datum=2026-09-16': windowPrev,
    'kanal/svt1?datum=2026-09-17': windowDay,
    'datum=': emptyDay,
    ...extra,
  });

  it('fetches the day before the window and buckets slots by start date', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(String(url));
      return stubFetch(routes())(url);
    };

    const result = await scrape({
      dates: ['2026-09-17'],
      fetchImpl,
      politenessDelayMs: 0,
      maxChannels: 1,
    });

    // Both pages of the requested day were requested: the 16th (whose tail
    // carries 00:00–06:00 of the 17th) and the 17th itself.
    expect(seen).toEqual([
      `${BASE_URL}/kanal/svt1?datum=2026-09-16`,
      `${BASE_URL}/kanal/svt1?datum=2026-09-17`,
    ]);

    // In window: both small-hours slots from the previous page plus the day's
    // own 06:00/12:00/23:00 slots.  The 16th's 07:00 and 23:30 slots and the
    // 18th's 00:30 slot start outside the window and are dropped.
    expect(result.programmes.map((p) => [p.title, p.start, p.stop])).toEqual([
      ['Midnatt 17', '2026-09-17T00:15:00+02:00', '2026-09-17T01:00:00+02:00'],
      ['Morgon 17', '2026-09-17T05:30:00+02:00', '2026-09-17T06:00:00+02:00'],
      ['Morgon 17', '2026-09-17T06:00:00+02:00', '2026-09-17T07:00:00+02:00'],
      ['Lunch 17', '2026-09-17T12:00:00+02:00', '2026-09-17T13:00:00+02:00'],
      ['Kväll 17', '2026-09-17T23:00:00+02:00', '2026-09-18T00:05:00+02:00'],
    ]);
    expect(result.programmes.every((p) => p.channel === '[SVT1HD].SVT1.HD.se')).toBe(true);
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0]).toEqual({
      id: '[SVT1HD].SVT1.HD.se',
      name: 'SVT 1',
      icon: 'https://new.static.tv.nu/47578019',
    });
    expect(result.failures).toBe(0);
    expect(result.days).toBe(1);
  });

  it('covers several requested dates and fetches the preceding day only once', async () => {
    const seen = [];
    const fetchImpl = async (url) => {
      seen.push(String(url));
      return stubFetch(routes())(url);
    };
    const result = await scrape({
      dates: ['2026-09-17', '2026-09-18'],
      fetchImpl,
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(seen).toEqual([
      `${BASE_URL}/kanal/svt1?datum=2026-09-16`,
      `${BASE_URL}/kanal/svt1?datum=2026-09-17`,
      `${BASE_URL}/kanal/svt1?datum=2026-09-18`,
    ]);
    // 5 from the 17th (see above) + the 18th's 00:30 slot; nothing else.
    expect(result.programmes.map((p) => p.start)).toEqual([
      '2026-09-17T00:15:00+02:00',
      '2026-09-17T05:30:00+02:00',
      '2026-09-17T06:00:00+02:00',
      '2026-09-17T12:00:00+02:00',
      '2026-09-17T23:00:00+02:00',
      '2026-09-18T00:30:00+02:00',
    ]);
    expect(result.days).toBe(2);
    // Requests stay ordered and polite (one page per channel-day).
    expect(seen).toHaveLength(3);
  });

  it('dedupes a slot that both day pages carry', async () => {
    // Serving the same page for both dates makes the in-window slots appear
    // twice; dedupe keeps one copy of each.
    const result = await scrape({
      dates: ['2026-09-17'],
      fetchImpl: stubFetch({ 'kanal/svt1': windowDay, 'datum=': emptyDay }),
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.programmes.map((p) => p.start)).toEqual([
      '2026-09-17T06:00:00+02:00',
      '2026-09-17T12:00:00+02:00',
      '2026-09-17T23:00:00+02:00',
    ]);
  });

  it('treats a channel with an empty day as empty, not as a failure', async () => {
    const result = await scrape({
      dates: ['2026-09-17'],
      fetchImpl: stubFetch({ 'datum=': emptyDay }),
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(0);
    expect(result.channels[0].icon).toBe('https://new.static.tv.nu/372093914');
  });

  it('counts a page without schedule state as a failure but keeps going', async () => {
    const logs = [];
    const result = await scrape({
      dates: ['2026-09-17'],
      fetchImpl: stubFetch({ 'kanal/svt1?datum=2026-09-17': noState, 'datum=': emptyDay }),
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(1);
    expect(logs.some((l) => l.includes('carried no schedule state'))).toBe(true);
  });

  it('degrades to an empty result when every request fails', async () => {
    const result = await scrape({
      dates: ['2026-09-17'],
      fetchImpl: async () => {
        throw new Error('HTTP 503');
      },
      politenessDelayMs: 0,
      maxChannels: 2,
      fetchOptions: { retries: 0 },
    });
    expect(result.programmes).toEqual([]);
    expect(result.channels).toHaveLength(2); // channels are still declared
    // Two page fetches per channel (16th + 17th) and none of them worked.
    expect(result.failures).toBe(4);
  });

  it('honours maxChannels', async () => {
    const seen = [];
    await scrape({
      dates: ['2026-09-17'],
      fetchImpl: async (url) => {
        seen.push(String(url));
        return stubFetch({ 'datum=': emptyDay })(url);
      },
      politenessDelayMs: 0,
      maxChannels: 3,
    });
    expect(new Set(seen.map((u) => u.split('/kanal/')[1].split('?')[0])).size).toBe(3);
  });

  it('maps the tv4 sports channels onto the reference ids', () => {
    expect(mapChannelId('TV4 Fotboll')).toBe('[TV4FOSV].TV4.Fotboll.se');
    expect(mapChannelId('TV4 Hockey')).toBe('[TV4HOSV].TV4.Hockey.se');
    expect(mapChannelId('TV4 Motor')).toBe('[TV4MOSV].TV4.Motor.se');
    expect(mapChannelId('TV4 Sportkanalen')).toBe('[SPORTK].TV4.Sportkanalen.se');
    expect(mapChannelId('TV4 Tennis')).toBe('[TV4TESV].TV4.Tennis.se');
    expect(mapChannelId('TV4 Sport Live 1')).toBe('[TV4SPL1].TV4.Sport.Live.1.se');
    expect(mapChannelId('TV4 Sport Live 2')).toBe('[TV4SPL2].TV4.Sport.Live.2.se');
    expect(mapChannelId('TV4 Sport Live 3')).toBe('[TV4SPL3].TV4.Sport.Live.3.se');
    expect(mapChannelId('TV4 Sport Live 4')).toBe('[TV4SPL4].TV4.Sport.Live.4.se');
    expect(CHANNELS).toHaveLength(69);
    expect(CHANNEL_ID_MAP['TV4 FOTBOLL']).toBe('[TV4FOSV].TV4.Fotboll.se');
  });

  it('parses TV4 sports pages without filtering their next-day slots', () => {
    // Parsing preserves all seven broadcasts; scrape() applies the window.
    const fotboll = parseChannelPage(fotbollDay);
    expect(fotboll.ok).toBe(true);
    expect(fotboll.name).toBe('TV4 Fotboll');
    expect(fotboll.logo).toBe('https://new.static.tv.nu/227354796');
    expect(fotboll.slots.map((s) => [s.start, s.title])).toEqual([
      ['2026-09-17T11:00:00+02:00', 'BK Häcken - Mjällby AIF'],
      ['2026-09-17T14:00:00+02:00', 'Venezia FC - ACF Fiorentina'],
      ['2026-09-17T16:30:00+02:00', 'AIK - Västerås SK'],
      ['2026-09-17T19:30:00+02:00', 'Genoa CFC - Frosinone Calcio'],
      ['2026-09-17T22:00:00+02:00', 'IFK Göteborg - Halmstad'],
      ['2026-09-18T01:00:00+02:00', 'Serie A, Lazio - Milan'],
      ['2026-09-18T05:00:00+02:00', 'Höjdpunkter'],
    ]);
    expect(fotboll.slots[0]).toMatchObject({
      stop: '2026-09-17T14:00:00+02:00',
      category: 'Fotboll',
    });
    expect(fotboll.slots[4].stop).toBe('2026-09-18T01:00:00+02:00');

    const sportkanalen = parseChannelPage(sportkanalenDay);
    expect(sportkanalen.ok).toBe(true);
    expect(sportkanalen.slots).toHaveLength(21);
    expect(sportkanalen.slots.filter((s) => s.date === '2026-09-17')).toHaveLength(19);
    expect(sportkanalen.slots[0].title).toBe('Fiskedestination');
    expect(sportkanalen.logo).toBe('https://new.static.tv.nu/227353196');

    // This snapshot has one valid broadcast, starting outside the window.
    const live = parseChannelPage(sportLiveDay);
    expect(live.ok).toBe(true);
    expect(live.name).toBe('TV4 Sport Live 1');
    expect(live.slots).toHaveLength(1);
    expect(live.slots[0]).toMatchObject({
      title: 'Höjdpunkter',
      start: '2026-09-18T05:00:00+02:00',
      stop: '2026-09-18T18:55:00+02:00',
    });
  });

  it('scrapes a tv4 sports channel end to end (stubbed fetch)', async () => {
    // CHANNELS order: the 10 base channels (svt1..tv4-fakta), then the 9 TV4
    // sports entries (indices 10-18), so maxChannels 11 reaches exactly
    // TV4 Fotboll (index 10).
    expect(CHANNELS[10]).toMatchObject({ slug: 'tv4-fotboll', id: '[TV4FOSV].TV4.Fotboll.se' });
    const result = await scrape({
      dates: ['2026-09-17'],
      fetchImpl: stubFetch({ 'kanal/tv4-fotboll': fotbollDay, 'datum=': emptyDay }),
      politenessDelayMs: 0,
      maxChannels: 11,
    });
    const fotboll = result.programmes.filter((p) => p.channel === '[TV4FOSV].TV4.Fotboll.se');
    expect(fotboll.map((p) => [p.title, p.start])).toEqual([
      ['BK Häcken - Mjällby AIF', '2026-09-17T11:00:00+02:00'],
      ['Venezia FC - ACF Fiorentina', '2026-09-17T14:00:00+02:00'],
      ['AIK - Västerås SK', '2026-09-17T16:30:00+02:00'],
      ['Genoa CFC - Frosinone Calcio', '2026-09-17T19:30:00+02:00'],
      ['IFK Göteborg - Halmstad', '2026-09-17T22:00:00+02:00'],
    ]);
    expect(result.channels).toHaveLength(11);
    expect(result.channels[10]).toEqual({
      id: '[TV4FOSV].TV4.Fotboll.se',
      name: 'TV4 Fotboll',
      icon: 'https://new.static.tv.nu/227354796',
    });
    expect(result.failures).toBe(0);
  });

  it('excludes out-of-window TV4 sports slots without counting a failure', async () => {
    const result = await scrape({
      dates: ['2026-09-17'],
      fetchImpl: stubFetch({
        'kanal/tv4-sportkanalen': sportkanalenDay,
        'kanal/tv4-sport-live-1': sportLiveDay,
        'datum=': emptyDay,
      }),
      politenessDelayMs: 0,
    });
    expect(result.channels).toHaveLength(69);
    expect(result.programmes).toHaveLength(19);
    expect(result.programmes.every((p) => p.channel === '[SPORTK].TV4.Sportkanalen.se')).toBe(true);
    expect(result.programmes.every((p) => p.start.startsWith('2026-09-17'))).toBe(true);
    expect(result.channels.find((c) => c.id === '[TV4SPL1].TV4.Sport.Live.1.se')).toEqual({
      id: '[TV4SPL1].TV4.Sport.Live.1.se',
      name: 'TV4 Sport Live 1',
      icon: 'https://new.static.tv.nu/227356274',
    });
    expect(result.failures).toBe(0);
  });

  it('maps the Viaplay/V Sport and Eurosport channels onto the reference ids', () => {
    expect(mapChannelId('V Sport 1')).toBe('[VIASPHD].V.Sport.1.HD.se');
    expect(mapChannelId('V Sport Extra')).toBe('[VSSPXHD].V.Sport.Extra.HD.se');
    expect(mapChannelId('V Sport Premium')).toBe('[VIASPOH].V.Sport.Premium.HD.se');
    expect(mapChannelId('V Sport Golf')).toBe('[VGOLFHD].V.Sport.Golf.HD.se');
    expect(mapChannelId('V Sport Motor')).toBe('[VIASMHD].V.Sport.Motor.HD.se');
    expect(mapChannelId('V Sport Vinter')).toBe('[VSPOVIS].V.Sport.Vinter.se');
    expect(mapChannelId('Fight Sports')).toBe('[FIGSAHD].Fight.Sports.HD.se');
    expect(mapChannelId('V Sport Live 1')).toBe('V.SPORT.LIVE.1.se');
    expect(mapChannelId('V Sport Live 5')).toBe('V.SPORT.LIVE.5.se');
    expect(mapChannelId('Viaplay Sport')).toBe('VIAPLAY.SPORT.se');
    expect(mapChannelId('Eurosport 1')).toBe('[EUROSHD].Eurosport.1.HD.se');
    expect(mapChannelId('Eurosport 2')).toBe('[EURSP2H].Eurosport.2.HD.se');
    // "V Sport Fotboll" exists in the reference but has no tv.nu page, so the
    // id is deliberately unmapped (no invented slugs).
    expect(mapChannelId('V Sport Fotboll')).toBeUndefined();
    expect(CHANNELS).toHaveLength(69);
  });

  it('parses the Viaplay/V Sport and Eurosport pages', () => {
    // V Sport 1: real sport schedule (Allsvenskan etc.), explicit start+stop.
    const vs1 = parseChannelPage(vSport1Day);
    expect(vs1.ok).toBe(true);
    expect(vs1.name).toBe('V Sport 1');
    expect(vs1.logo).toBe('https://new.static.tv.nu/68084424');
    expect(vs1.slots).toHaveLength(12);
    expect(vs1.slots[0].category).toBe('Fotboll');

    // Fight Sports: tagged reference id, generic event list.
    const fight = parseChannelPage(fightSportsDay);
    expect(fight.name).toBe('Fight Sports');
    expect(fight.slots).toHaveLength(22);

    // Eurosport 1: cycling etc.
    const euro = parseChannelPage(eurosport1Day);
    expect(euro.name).toBe('Eurosport 1');
    expect(euro.slots).toHaveLength(13);
    expect(euro.slots[0].category).toBe('Cykel');

    // V Sport Live feeds: single rolling "next live event" placeholder day.
    const live1 = parseChannelPage(vSportLive1Day);
    expect(live1.name).toBe('V Sport Live 1');
    expect(live1.slots).toHaveLength(1);
    expect(live1.slots[0].start.startsWith('2026-09-17')).toBe(true);
  });

  it('scrapes a Viaplay/V Sport channel end to end (stubbed fetch)', async () => {
    // CHANNELS indices: 0-9 base, 10-18 TV4 sports, 19-34 the Viaplay/V
    // Sport block — so maxChannels 20 reaches exactly V Sport 1 (index 19).
    expect(CHANNELS[19]).toMatchObject({ slug: 'v-sport-1', id: '[VIASPHD].V.Sport.1.HD.se' });
    const result = await scrape({
      dates: ['2026-09-17'],
      fetchImpl: stubFetch({ 'kanal/v-sport-1': vSport1Day, 'datum=': emptyDay }),
      politenessDelayMs: 0,
      maxChannels: 20,
    });
    const vs1 = result.programmes.filter((p) => p.channel === '[VIASPHD].V.Sport.1.HD.se');
    expect(vs1.length).toBeGreaterThan(0);
    expect(vs1.every((p) => p.start.startsWith('2026-09-17'))).toBe(true);
    expect(result.channels[19]).toEqual({
      id: '[VIASPHD].V.Sport.1.HD.se',
      name: 'V Sport 1',
      icon: 'https://new.static.tv.nu/68084424',
    });
    expect(result.failures).toBe(0);
  });

  it('falls back to a single-day window when no dates are given', async () => {
    const result = await scrape({
      fetchImpl: stubFetch({ 'datum=': emptyDay }),
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.days).toBe(1);
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(0);
  });
});
describe('tvnu cli integration (stubbed fetch, temp output)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-scraper-tvnu-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  const routes = {
    'kanal/svt1?datum=2026-09-16': windowPrev,
    'kanal/svt1?datum=2026-09-17': windowDay,
    'datum=': emptyDay,
  };

  const runWith = async (argv) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => stubFetch(routes)(url);
    try {
      return await runCli({
        argv,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        cwd: tmpDir,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  it('writes a Swedish guide to epg_tvnu_SE.xml.gz with lang="sv"', async () => {
    // The 17th is served from the real SVT1 snapshot (rich fields: genres,
    // season/episode, logo); the 16th supplies the small-hours slots.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) =>
      stubFetch({ ...routes, 'kanal/svt1?datum=2026-09-17': svt1Day })(url);
    let exit;
    try {
      exit = await runCli({
        argv: [
          '--provider', 'tvnu',
          '--date', '2026-09-17',
          '--days-forward', '0',
          '--max-channels', '1',
          '--delay-ms', '0',
          '--quiet',
        ],
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        cwd: tmpDir,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(exit).toBe(0);

    // The provider's own country decides the default filename suffix (SE).
    const out = path.join(tmpDir, 'epg_tvnu_SE.xml.gz');
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(300);

    const xml = gunzipSync(readFileSync(out)).toString('utf8');
    // Swedish titles are labelled Swedish, not Turkish.
    expect(xml).toContain('<display-name lang="sv">SVT 1</display-name>');
    expect(xml).toContain('<title lang="sv">Husdrömmar</title>');
    expect(xml).toContain('<category lang="sv">Konst</category>');
    expect(xml).toContain('<sub-title lang="sv">Säsong 8, Avsnitt 8</sub-title>');
    // The channel logo from the page's own themedLogo.
    expect(xml).toContain('<icon src="https://new.static.tv.nu/47578019" />');
    // Instants keep the Stockholm offset, rendered as XMLTV "+0200".
    expect(xml).toContain('<programme start="20260917001500 +0200"');
    expect(xml).toContain('channel="[SVT1HD].SVT1.HD.se"');
    expect(xml).not.toContain('+0300'); // never the Turkish offset
    expect(xml).not.toContain('lang="tr"');
  });

  it('honours --no-gzip and --out', async () => {
    const out = path.join(tmpDir, 'sweden.xml');
    const exit = await runWith([
      '--provider', 'tvnu',
      '--out', out,
      '--no-gzip',
      '--date', '2026-09-17',
      '--days-forward', '0',
      '--max-channels', '1',
      '--delay-ms', '0',
      '--quiet',
    ]);
    expect(exit).toBe(0);
    const xml = readFileSync(out, 'utf8');
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('channel="[SVT1HD].SVT1.HD.se"');
  });

  it('refuses to write an empty guide when every page lacks schedule state', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => stubFetch({ 'datum=': noState })(url);
    try {
      const exit = await runCli({
        argv: [
          '--provider', 'tvnu',
          '--date', '2026-09-17',
          '--days-forward', '0',
          '--max-channels', '2',
          '--delay-ms', '0',
          '--quiet',
        ],
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        cwd: tmpDir,
      });
      expect(exit).toBe(1);
      expect(existsSync(path.join(tmpDir, 'epg_tvnu_SE.xml.gz'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects an invalid --max-channels before scraping', async () => {
    const exit = await runWith([
      '--provider', 'tvnu',
      '--date', '2026-09-17',
      '--days-forward', '0',
      '--max-channels', '0',
      '--delay-ms', '0',
      '--quiet',
    ]);
    expect(exit).toBe(1);
  });
});
