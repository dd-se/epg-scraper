import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseDayPage,
  parseServedDate,
  mapChannelId,
  normalizeChannelKey,
  channelPage,
  dayPageUrl,
  scrape,
  CHANNELS,
} from '../src/providers/digiturkburada.js';
import { runCli } from '../src/cli.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/digiturkburada/${name}`, import.meta.url)), 'utf8');

const bein5 = fixture('bein-sports-5-2026-09-08.html');
const bein5Tomorrow = fixture('bein-sports-5-2026-09-09.html');
const max1 = fixture('bein-sports-max-1-2026-09-08.html');
const max2 = fixture('bein-sports-max-2-2026-09-08.html');
const gsTv = fixture('gs-tv-2026-09-08.html');

const response = (html) => ({ ok: true, status: 200, text: async () => html });

describe('digiturkburada pure parsers', () => {
  it('parses the served-date heading', () => {
    expect(parseServedDate('8 Eylül 2026 - Salı')).toBe('2026-09-08');
    expect(parseServedDate('9 Eylül 2026 - Çarşamba')).toBe('2026-09-09');
    expect(parseServedDate('31 Aralık 2026 - Perşembe')).toBe('2026-12-31');
    expect(parseServedDate('garbage')).toBeUndefined();
    expect(parseServedDate(undefined)).toBeUndefined();
  });

  it('extracts programmes with decoded Turkish titles', () => {
    const { date, slots } = parseDayPage(bein5);
    expect(date).toBe('2026-09-08');
    expect(slots.length).toBe(13);
    expect(slots[0]).toEqual({ startMin: 0, title: 'Erokspor - Mersin' });
    expect(slots[1].title).toBe('Beşiktaş - Bahçeşehir'); // internal whitespace collapsed
    expect(slots.some((s) => s.title.includes('&#x'))).toBe(false); // entities decoded
    expect(slots.every((s) => Number.isFinite(s.startMin))).toBe(true);
  });

  it('parses the next-day page (POST result)', () => {
    const { date, slots } = parseDayPage(bein5Tomorrow);
    expect(date).toBe('2026-09-09');
    expect(slots.length).toBe(12);
    expect(slots[0].title).toBe('Tofaş - Beşiktaş');
  });

  it('parses GS TV and the Max fixtures', () => {
    expect(parseDayPage(gsTv).slots.length).toBe(15);
    expect(parseDayPage(gsTv).date).toBe('2026-09-08');
    expect(parseDayPage(max1).date).toBe('2026-09-08');
    expect(parseDayPage(max2).date).toBe('2026-09-08');
  });

  it('degrades gracefully on malformed markup', () => {
    expect(parseDayPage('<html>nothing</html>')).toEqual({ date: undefined, slots: [] });
    expect(parseDayPage(undefined)).toEqual({ date: undefined, slots: [] });
  });

  it('maps display names to page slugs and epgshare01 ids', () => {
    expect(mapChannelId('beIN Sports 5')).toBe('beIN.SPORTS.5.tr');
    expect(mapChannelId('beIN Sports Max 1')).toBe('beIN.SPORTS.MAX.1.tr');
    expect(mapChannelId('beIN Sports Max 2')).toBe('beIN.SPORTS.MAX.2.tr');
    expect(mapChannelId('GS TV')).toBe('GS.TV.tr');
    expect(mapChannelId('BEIN SPORTS 1')).toBeUndefined(); // served by beinsports, not here
    expect(normalizeChannelKey('  beIN   SPORTS 5 ')).toBe('BEIN SPORTS 5');
    expect(channelPage('beIN Sports 5')).toBe('/bein-sports-5-hd-yayin-akisi-154.html');
    expect(dayPageUrl('/gs-tv-hd-yayin-akisi-58.html')).toBe(
      'https://www.digiturkburada.com.tr/gs-tv-hd-yayin-akisi-58.html'
    );
    for (const channel of CHANNELS) {
      expect(channel.id.endsWith('.tr')).toBe(true);
      expect(channel.page.startsWith('/')).toBe(true);
    }
  });
});

describe('digiturkburada scrape (stubbed POST)', () => {
  it('posts yayin=DD.MM.YYYY for each channel and date and merges results', async () => {
    const bodies = [];
    const fetchImpl = async (url, options) => {
      expect(options.method).toBe('POST');
      expect(options.headers['content-type']).toContain('x-www-form-urlencoded');
      bodies.push(options.body);
      if (url.includes('bein-sports-max-1')) return response(max1);
      if (url.includes('bein-sports-max-2')) return response(max2);
      if (url.includes('gs-tv')) return response(gsTv);
      return response(bein5);
    };

    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl,
      log: () => {},
      politenessDelayMs: 0,
    });

    expect(result.failures).toBe(0);
    expect(result.channels.map((c) => c.id)).toEqual([
      'beIN.SPORTS.5.tr',
      'beIN.SPORTS.MAX.1.tr',
      'beIN.SPORTS.MAX.2.tr',
      'GS.TV.tr',
    ]);
    expect(result.programmes).toHaveLength(13 + 11 + 11 + 15);
    expect(bodies).toHaveLength(4);
    expect(bodies.every((b) => b === 'yayin=8.09.2026')).toBe(true);
    const ids = new Set(result.channels.map((c) => c.id));
    expect(result.programmes.every((p) => ids.has(p.channel))).toBe(true);
    expect(result.programmes.every((p) => p.start.endsWith('+03:00'))).toBe(true);
  });

  it('computes stop from the next slot and ends the day at 24:00', async () => {
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => response(bein5),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    const ch5 = result.programmes.filter((p) => p.channel === 'beIN.SPORTS.5.tr');
    expect(ch5[0].start).toBe('2026-09-08T00:00:00+03:00');
    expect(ch5[0].stop).toBe('2026-09-08T01:47:00+03:00'); // next slot
    expect(ch5[ch5.length - 1].start).toBe('2026-09-08T20:19:00+03:00');
    expect(ch5[ch5.length - 1].stop).toBe('2026-09-09T00:00:00+03:00'); // end of day
  });

  it('honors multiple dates and posts each day', async () => {
    const bodies = [];
    const result = await scrape({
      dates: ['2026-09-08', '2026-09-09'],
      fetchImpl: async (_url, options) => {
        bodies.push(options.body);
        return response(options.body === 'yayin=8.09.2026' ? bein5 : bein5Tomorrow);
      },
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(bodies).toEqual(['yayin=8.09.2026', 'yayin=9.09.2026']);
    expect(result.programmes).toHaveLength(13 + 12);
  });

  it('skips a page whose served date does not match the request', async () => {
    const logs = [];
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl: async () => response(bein5), // fixture is dated 2026-09-08
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.programmes).toEqual([]);
    expect(logs.some((l) => l.includes('skipped'))).toBe(true);
  });

  it('degrades gracefully when all requests fail', async () => {
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
    expect(result.failures).toBe(4);
  });
});

describe('digiturkburada cli integration (stubbed fetch, temp output)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-scraper-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  it('writes a gzipped xmltv file and reports success', async () => {
    const { default: fs } = await import('node:fs');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('bein-sports-max-1')) return response(max1);
      if (u.includes('bein-sports-max-2')) return response(max2);
      if (u.includes('gs-tv')) return response(gsTv);
      return response(bein5);
    };
    try {
      const out = path.join(tmpDir, 'db.xml.gz');
      const exit = await runCli({
        argv: [
          '--provider', 'digiturkburada',
          '--out', out,
          '--date', '2026-09-08',
          '--days-forward', '0',
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
          '--provider', 'digiturkburada',
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