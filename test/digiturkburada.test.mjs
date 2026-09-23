import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseDayPage,
  parseServedDate,
  parseChannelLogo,
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
const bein1 = fixture('bein-sports-1-2026-09-08.html');
const bein2 = fixture('bein-sports-2-2026-09-08.html');
const bein3 = fixture('bein-sports-3-2026-09-08.html');
const bein4 = fixture('bein-sports-4-2026-09-08.html');
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

  it('extracts the channel logo with the cache-buster stripped', () => {
    expect(parseChannelLogo(bein1)).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/bein-sports-hd-1-buyuk.png'
    );
    expect(parseChannelLogo(bein2)).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/bein-sports-hd-2-buyuk.png'
    );
    expect(parseChannelLogo(bein3)).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/bein-sports-hd-3-buyuk-1.png'
    );
    expect(parseChannelLogo(bein4)).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/bein-sports-hd-4-buyuk.png'
    );
    expect(parseChannelLogo(bein5)).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/bein-sports-hd-5-buyuk.png'
    );
    expect(parseChannelLogo(max1)).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/bein-sports-max-1-hd-buyuk.png'
    );
    expect(parseChannelLogo(max2)).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/bein-sports-max-2-hd-buyuk.png'
    );
    expect(parseChannelLogo(gsTv)).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/gs-tv-hd-buyuk.png'
    );
  });

  it('degrades gracefully on logo-less or hostile markup', () => {
    expect(parseChannelLogo('<html>nothing</html>')).toBeUndefined();
    expect(parseChannelLogo(undefined)).toBeUndefined();
    expect(parseChannelLogo('<img border="0" src="data:image/gif;base64,AAA" />')).toBeUndefined();
    expect(
      parseChannelLogo('<img border="0" src="https://a.example/x.png|https://a.example/x.png" />')
    ).toBeUndefined();
  });

  it('degrades gracefully on malformed markup', () => {
    expect(parseDayPage('<html>nothing</html>')).toEqual({ date: undefined, slots: [] });
    expect(parseDayPage(undefined)).toEqual({ date: undefined, slots: [] });
  });

  it('maps display names to page slugs and epgshare01 ids', () => {
    expect(mapChannelId('beIN Sports 1')).toBe('beIN.SPORTS.1.tr');
    expect(mapChannelId('beIN Sports 2')).toBe('beIN.SPORTS.2.tr');
    expect(mapChannelId('beIN Sports 3')).toBe('beIN.SPORTS.3.tr');
    expect(mapChannelId('beIN Sports 4')).toBe('beIN.SPORTS.4.tr');
    expect(mapChannelId('beIN Sports 5')).toBe('beIN.SPORTS.5.tr');
    expect(mapChannelId('beIN Sports Max 1')).toBe('beIN.SPORTS.MAX.1.tr');
    expect(mapChannelId('beIN Sports Max 2')).toBe('beIN.SPORTS.MAX.2.tr');
    expect(mapChannelId('GS TV')).toBe('GS.TV.tr');
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
      if (url.includes('bein-sports-1-hd')) return response(bein1);
      if (url.includes('bein-sports-2-hd')) return response(bein2);
      if (url.includes('bein-sports-3-hd')) return response(bein3);
      if (url.includes('bein-sports-4-hd')) return response(bein4);
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
      'beIN.SPORTS.1.tr',
      'beIN.SPORTS.2.tr',
      'beIN.SPORTS.3.tr',
      'beIN.SPORTS.4.tr',
      'beIN.SPORTS.5.tr',
      'beIN.SPORTS.MAX.1.tr',
      'beIN.SPORTS.MAX.2.tr',
      'GS.TV.tr',
    ]);
    // Every channel carries its page-header logo — absolute, query-free,
    // single URLs (never pipe-joined).
    const icons = Object.fromEntries(result.channels.map((c) => [c.id, c.icon]));
    expect(icons['beIN.SPORTS.1.tr']).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/bein-sports-hd-1-buyuk.png'
    );
    expect(icons['beIN.SPORTS.5.tr']).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/bein-sports-hd-5-buyuk.png'
    );
    expect(icons['GS.TV.tr']).toBe(
      'https://www.digiturkburada.com.tr/kanal3/kanal-buyuk/gs-tv-hd-buyuk.png'
    );
    for (const icon of Object.values(icons)) {
      expect(icon).toMatch(/^https?:\/\/[^\s|?#]+$/);
      expect(icon).not.toContain('|');
    }
    expect(result.programmes).toHaveLength(16 + 19 + 20 + 20 + 13 + 11 + 11 + 15);
    expect(bodies).toHaveLength(8);
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
    // maxChannels: 1 keeps beIN Sports 1; the stub serves the beIN 5
    // fixture for every URL, so its slots land on beIN.SPORTS.1.tr.
    const ch5 = result.programmes.filter((p) => p.channel === 'beIN.SPORTS.1.tr');
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
    expect(result.failures).toBe(8);
  });

  it('returns programmes sorted by channel then start', async () => {
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async (url) =>
        response(String(url).includes('gs-tv') ? gsTv : bein5),
      log: () => {},
      politenessDelayMs: 0,
    });
    const keys = result.programmes.map((p) => [p.channel, p.start]);
    const sorted = [...keys].sort(
      (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) || a[1].localeCompare(b[1])
    );
    expect(keys).toEqual(sorted);
    expect(result.programmes[0].channel).toBe('GS.TV.tr');
    // Within one channel, starts ascend.
    const gs = result.programmes.filter((p) => p.channel === 'GS.TV.tr');
    expect(gs.map((p) => p.start)).toEqual([...gs.map((p) => p.start)].sort());
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
          '--date', '2026-09-08',
          '--days-forward', '0',
          '--delay-ms', '0',
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