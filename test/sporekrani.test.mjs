import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseChannelPage,
  extractInitialState,
  mapChannelId,
  normalizeChannelKey,
  channelPageUrl,
  scrape,
  CHANNELS,
} from '../src/providers/sporekrani.js';
import { runCli } from '../src/cli.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/sporekrani/${name}`, import.meta.url)), 'utf8');

const tabii1 = fixture('tabii-spor-1.html');
const tabii2 = fixture('tabii-spor-2.html');
const tabii3 = fixture('tabii-spor-3.html');
const tabii4 = fixture('tabii-spor-4.html'); // empty page: no events scheduled
const sSportPlus = fixture('s-sport-plus.html');

const response = (html) => ({ ok: true, status: 200, text: async () => html });

// A tiny synthetic page so the parser's channel filter is tested against an
// event that airs on *another* channel (the real fixtures are pre-filtered
// by the server, so they cannot exercise the exclusion branch).
const syntheticHtml = JSON.stringify({
  common: {
    events: [
      {
        name: 'Kendi Maçı',
        date_time: '2026-09-08 20:00:00',
        sport_name: 'Futbol',
        channels: [{ name: 'tabii Spor 9' }, { name: 'tabii Spor 1' }],
      },
      {
        name: 'Başka Kanalın Maçı',
        date_time: '2026-09-08 21:00:00',
        sport_name: 'Basketbol',
        channels: [{ name: 'CBC Sport' }],
      },
      {
        name: 'Tarihsiz Etkinlik',
        date_time: '',
        sport_name: 'Futbol',
        channels: [{ name: 'tabii Spor 1' }],
      },
    ],
  },
});
const syntheticPage = `<html><body><script>window.__INITIAL_STATE__=${syntheticHtml}</script></body></html>`;

describe('sporekrani pure parsers', () => {
  it('extracts the __INITIAL_STATE__ JSON', () => {
    const state = extractInitialState(tabii1);
    expect(Array.isArray(state?.common?.events)).toBe(true);
    expect(state.common.events).toHaveLength(5);
  });

  it('tolerates braces inside JSON string values', () => {
    const page =
      '<script>window.__INITIAL_STATE__={"common":{"events":[{"name":"Maç {özel}","date_time":"2026-09-08 20:00:00","sport_name":"Futbol","channels":[{"name":"X"}]}]}}</script>';
    const state = extractInitialState(page);
    expect(state.common.events[0].name).toBe('Maç {özel}');
  });

  it('degrades gracefully on missing or malformed markup', () => {
    expect(extractInitialState('<html>nothing here</html>')).toBeUndefined();
    expect(extractInitialState(undefined)).toBeUndefined();
    expect(extractInitialState('<script>window.__INITIAL_STATE__={not json}</script>')).toBeUndefined();
    expect(parseChannelPage('<html>nothing</html>', 'tabii Spor 1')).toEqual({ events: [] });
    expect(parseChannelPage(undefined, 'tabii Spor 1')).toEqual({ events: [] });
  });

  it('parses the tabii spor 1 page into its 5 events', () => {
    const { events } = parseChannelPage(tabii1, 'tabii Spor 1');
    expect(events).toHaveLength(5);
    expect(events[0]).toEqual({
      date: '2026-09-08',
      startMin: 19 * 60 + 45,
      title: 'Club Brugge - Aston Villa',
      category: 'Futbol',
    });
    expect(events[1].title).toBe('Porto - Manchester City');
    expect(events[2].title).toBe('Stuttgart - Viking');
    expect(events[3].title).toBe('PSG - Slovan Bratislava');
    expect(events[4]).toEqual({
      date: '2026-09-10',
      startMin: 22 * 60,
      title: 'Manchester Utd - Sabah Bakü',
      category: 'Futbol',
    });
  });

  it('keeps only events that air on the page\'s own channel', () => {
    const { events } = parseChannelPage(syntheticPage, 'tabii Spor 1');
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Kendi Maçı');
    expect(events[0].category).toBe('Futbol');
  });

  it('returns an empty result for an idle (no-events) page', () => {
    expect(parseChannelPage(tabii4, 'tabii Spor 4')).toEqual({ events: [] });
  });

  it('parses the S Sport Plus page (120 events, programmes included)', () => {
    const { events } = parseChannelPage(sSportPlus, 'S Sport Plus');
    expect(events.length).toBeGreaterThan(100);
    expect(events[0]).toEqual({
      date: '2026-09-08',
      startMin: 18 * 60 + 45,
      title: 'Macaristan - Japonya',
      category: 'Basketbol',
    });
    expect(events[events.length - 1].date).toBe('2026-09-24');
    // Non-match items (MotoGP practice sessions etc.) survive the parse too.
    expect(events.some((e) => e.title === 'Serbest Antrenman 1' && e.category === 'Motosiklet')).toBe(
      true
    );
  });

  it('maps display names to slugs and ids', () => {
    expect(mapChannelId('tabii Spor 1')).toBe('TABII.SPOR.1.tr');
    expect(mapChannelId('tabii Spor 8')).toBe('TABII.SPOR.8.tr');
    expect(mapChannelId('S Sport Plus')).toBe('S.SPORT.PLUS.tr');
    expect(mapChannelId('S SPORT PLUS')).toBe('S.SPORT.PLUS.tr'); // case/space-insensitive
    expect(mapChannelId('CBC Sport')).toBeUndefined();
    expect(normalizeChannelKey('  tabii   Spor 1 ')).toBe('TABII SPOR 1');
    expect(channelPageUrl('tabii-spor-1')).toBe('https://www.sporekrani.com/home/channel/tabii-spor-1');
    expect(CHANNELS).toHaveLength(9);
    for (const channel of CHANNELS) {
      expect(channel.id.endsWith('.tr')).toBe(true);
      expect(channel.slug).toBe(channel.slug.toLowerCase());
    }
  });
});

describe('sporekrani scrape (stubbed fetch)', () => {
  // Serve a fixture per slug; unknown slugs (tabii spor 5-8) get the empty page.
  const bySlug = (url) => {
    const u = String(url);
    if (u.includes('tabii-spor-1')) return response(tabii1);
    if (u.includes('tabii-spor-2')) return response(tabii2);
    if (u.includes('tabii-spor-3')) return response(tabii3);
    if (u.includes('s-sport-plus')) return response(sSportPlus);
    return response(tabii4);
  };

  it('scrapes every channel with one fetch each and filters to the window', async () => {
    const urls = [];
    const result = await scrape({
      dates: ['2026-09-08', '2026-09-09', '2026-09-10'],
      fetchImpl: async (url) => {
        urls.push(String(url));
        return bySlug(url);
      },
      log: () => {},
      politenessDelayMs: 0,
    });

    expect(result.failures).toBe(0);
    expect(result.channels).toHaveLength(9);
    expect(result.channels.map((c) => c.id)).toEqual(CHANNELS.map((c) => c.id));
    expect(urls).toHaveLength(9); // one fetch per channel — the page covers the whole window
    expect(urls.every((u) => u.startsWith('https://www.sporekrani.com/home/channel/'))).toBe(true);
    expect(result.days).toBe(3);

    // tabii spor 1: 5 events all inside the window; tabii 2: 3; tabii 3: 2;
    // tabii 4 (and 5-8): empty page -> 0; S Sport Plus: only events on the 3 dates.
    const ids = new Set(result.channels.map((c) => c.id));
    expect(result.programmes.every((p) => ids.has(p.channel))).toBe(true);
    expect(result.programmes.every((p) => p.start.endsWith('+03:00'))).toBe(true);

    const t1 = result.programmes.filter((p) => p.channel === 'TABII.SPOR.1.tr');
    expect(t1).toHaveLength(5);
    const t2 = result.programmes.filter((p) => p.channel === 'TABII.SPOR.2.tr');
    expect(t2).toHaveLength(3);
    const t4 = result.programmes.filter((p) => p.channel === 'TABII.SPOR.4.tr');
    expect(t4).toHaveLength(0);

    const ssp = result.programmes.filter((p) => p.channel === 'S.SPORT.PLUS.tr');
    expect(ssp.length).toBeGreaterThan(0);
    expect(ssp.every((p) => ['2026-09-08', '2026-09-09', '2026-09-10'].includes(p.start.slice(0, 10))))
      .toBe(true);
  });

  it('derives stop from the next event, chaining across day boundaries', async () => {
    const result = await scrape({
      dates: ['2026-09-08', '2026-09-09', '2026-09-10'],
      fetchImpl: async (url) => bySlug(url),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1, // only tabii spor 1
    });
    const t1 = result.programmes.filter((p) => p.channel === 'TABII.SPOR.1.tr');
    expect(t1).toHaveLength(5);
    // Same-day chaining: next event starts 22:00.
    expect(t1[0].start).toBe('2026-09-08T19:45:00+03:00');
    expect(t1[0].stop).toBe('2026-09-08T22:00:00+03:00');
    // Cross-day chaining: 08.09 22:00 -> 09.09 19:45.
    expect(t1[1].start).toBe('2026-09-08T22:00:00+03:00');
    expect(t1[1].stop).toBe('2026-09-09T19:45:00+03:00');
    // Last event of the page ends at 24:00.
    expect(t1[4].start).toBe('2026-09-10T22:00:00+03:00');
    expect(t1[4].stop).toBe('2026-09-11T00:00:00+03:00');
  });

  it('emits the sport name as the category', async () => {
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => response(tabii1),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.programmes.every((p) => p.category === 'Futbol')).toBe(true);
  });

  it('silently skips dates outside the rolling window', async () => {
    const result = await scrape({
      dates: ['2026-08-01'], // before the page's earliest event (2026-09-08)
      fetchImpl: async () => response(tabii1),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(0);
  });

  it('degrades gracefully when every request fails', async () => {
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => {
        throw new Error('HTTP 503');
      },
      log: () => {},
      politenessDelayMs: 0,
      fetchOptions: {},
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(9);
  });
});

describe('sporekrani cli integration (stubbed fetch, temp output)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-scraper-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  const stubFetch = () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('tabii-spor-1')) return response(tabii1);
      if (u.includes('tabii-spor-2')) return response(tabii2);
      if (u.includes('tabii-spor-3')) return response(tabii3);
      if (u.includes('s-sport-plus')) return response(sSportPlus);
      return response(tabii4);
    };
    return originalFetch;
  };

  it('writes a gzipped xmltv file and reports success', async () => {
    const { default: fs } = await import('node:fs');
    const originalFetch = stubFetch();
    try {
      const out = path.join(tmpDir, 'sporekrani.xml.gz');
      const exit = await runCli({
        argv: [
          '--provider', 'sporekrani',
          '--out', out,
          '--date', '2026-09-09',
          '--days-forward', '1',
          '--delay-ms', '0',
          '--quiet',
        ],
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        cwd: tmpDir,
      });
      expect(exit).toBe(0);
      expect(fs.existsSync(out)).toBe(true);
      expect(fs.statSync(out).size).toBeGreaterThan(500);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses to write an empty guide when all pages are empty', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => response('<html><body>no guide</body></html>');
    try {
      const stderr = [];
      const exit = await runCli({
        argv: [
          '--provider', 'sporekrani',
          '--out', path.join(tmpDir, 'none.xml.gz'),
          '--quiet',
        ],
        stdout: { write: () => {} },
        stderr: { write: (s) => stderr.push(s) },
        cwd: tmpDir,
      });
      expect(exit).toBe(1);
      expect(stderr.join('')).toMatch(/nothing scraped/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});