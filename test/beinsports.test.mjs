import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseDayPage,
  parseChannelList,
  mapChannelId,
  normalizeChannelKey,
  channelRewrite,
  dayPageUrl,
  scrape,
  DAY_TAGS,
} from '../src/providers/beinsports.js';
import { weekDays } from '../src/providers/hurriyet.js';
import { runCli } from '../src/cli.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/beinsports/${name}`, import.meta.url)), 'utf8');

const day1Html = fixture('day-beinsports-sali.html'); // beIN Sports 1 (channelId 1)
const day2Html = fixture('day-beinsports-2-sali.html'); // beIN Sports 2 (channelId 2)

const response = (html) => ({ ok: true, status: 200, text: async () => html });

describe('beinsports parseDayPage (fixtures)', () => {
  it('extracts the served date and programme slots', () => {
    const { date, slots } = parseDayPage(day1Html);
    expect(date).toBe('2026-09-08');
    expect(slots.length).toBe(7);
    expect(slots[0]).toEqual({ channelId: 1, startMin: 10 * 60 + 30, title: 'beIN Süper Lig' });
    expect(slots[1].title).toBe('Trio');
    expect(slots[slots.length - 1].startMin).toBe(20 * 60);
    expect(slots.every((s) => Number.isInteger(s.channelId))).toBe(true);
  });

  it('parses the channel 2 fixture', () => {
    const { slots } = parseDayPage(day2Html);
    expect(slots.length).toBe(4);
    expect(slots.every((s) => s.channelId === 2)).toBe(true);
    expect(slots[0].title).toBe('TFF 1.Lig Haftanın Golleri');
  });

  it('degrades gracefully on malformed markup', () => {
    expect(parseDayPage('<html>nothing</html>')).toEqual({ date: undefined, slots: [] });
    expect(parseDayPage(undefined)).toEqual({ date: undefined, slots: [] });
  });

  it('discovers channels from activeLeagues', () => {
    const channels = parseChannelList(day1Html);
    expect(channels).toEqual([
      { rewriteId: 'beinsports', channelId: 1 },
      { rewriteId: 'beinsports-2', channelId: 2 },
    ]);
  });
});

describe('beinsports channel id mapping', () => {
  it('maps the four beIN Sports feeds to epgshare01 ids', () => {
    expect(mapChannelId('BEIN SPORTS 1')).toBe('beIN.SPORTS.1.tr');
    expect(mapChannelId('BeIN Sports 2')).toBe('beIN.SPORTS.2.tr');
    expect(mapChannelId('BEIN SPORTS 3')).toBe('beIN.SPORTS.3.tr');
    expect(mapChannelId('BEIN SPORTS 4')).toBe('beIN.SPORTS.4.tr');
    expect(mapChannelId('BEIN SPORTS 5')).toBeUndefined(); // not served by the site
  });

  it('normalizes keys and builds day page urls', () => {
    expect(normalizeChannelKey('  beIN   sports 1 ')).toBe('BEIN SPORTS 1');
    expect(channelRewrite('BEIN SPORTS 2')).toBe('beinsports-2');
    expect(dayPageUrl('beinsports-2', 'sali')).toBe(
      'https://beinsports.com.tr/yayin-akisi/beinsports-2/sali'
    );
    expect(DAY_TAGS).toHaveLength(7);
  });
});

describe('beinsports scrape (stubbed week)', () => {
  const week = weekDays(new Date('2026-09-07T12:00:00Z')); // Mon..Sun

  it('scrapes every channel for every weekday of the week', async () => {
    const urls = [];
    const result = await scrape({
      dates: week,
      fetchImpl: async (url) => {
        urls.push(url);
        return response(url.includes('beinsports-2') ? day2Html : day1Html);
      },
      log: () => {},
      politenessDelayMs: 0,
    });

    expect(result.days).toBe(7);
    expect(result.failures).toBe(0);
    expect(result.channels.map((c) => c.id)).toEqual([
      'beIN.SPORTS.1.tr',
      'beIN.SPORTS.2.tr',
      'beIN.SPORTS.3.tr',
      'beIN.SPORTS.4.tr',
    ]);
    // 7 days x 7 days-worth of slots: channels 1/3/4 serve 7 slots, channel
    // 2 serves 4 (the stub returns the matching fixture per channel).
    expect(result.programmes).toHaveLength(7 * (7 + 4 + 7 + 7));
    const ids = new Set(result.channels.map((c) => c.id));
    expect(result.programmes.every((p) => ids.has(p.channel))).toBe(true);
    expect(result.programmes.every((p) => p.start.endsWith('+03:00'))).toBe(true);
    expect(urls).toHaveLength(4 * 7);
  });

  it('clamps any requested window to the current Mon-Sun week', async () => {
    const urls = [];
    await scrape({
      dates: ['2026-09-09', '2026-09-10'],
      fetchImpl: async (url) => {
        urls.push(url);
        return response(day1Html);
      },
      log: () => {},
      politenessDelayMs: 0,
    });
    expect(urls).toHaveLength(4 * 7); // full week, not 2 days
  });

  it('computes stop from the next slot and ends the day at 24:00', async () => {
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async (url) => response(url.includes('beinsports-2') ? day2Html : day1Html),
      log: () => {},
      politenessDelayMs: 0,
    });
    // The window is clamped to the whole Mon-Sun week; look at Tuesday.
    const tue = result.programmes.filter((p) => p.start.startsWith('2026-09-08'));
    const ch1 = tue.filter((p) => p.channel === 'beIN.SPORTS.1.tr');
    expect(ch1[0].start).toBe('2026-09-08T10:30:00+03:00');
    expect(ch1[0].stop).toBe('2026-09-08T11:30:00+03:00'); // next slot
    expect(ch1[ch1.length - 1].stop).toBe('2026-09-09T00:00:00+03:00'); // end of day
    // Every day of the week is covered.
    const monday = result.programmes.filter((p) => p.start.startsWith('2026-09-07'));
    expect(monday.length).toBeGreaterThan(0);
  });

  it('degrades gracefully when all pages fail', async () => {
    const logs = [];
    const result = await scrape({
      dates: week,
      fetchImpl: async () => {
        throw new Error('HTTP 503');
      },
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
      fetchOptions: { retries: 0 }, // avoid fetchText's bounded retry backoff
    });
    // The channel list is static, so it survives total failure; the
    // programme list is what the CLI guards on.
    expect(result.channels).toHaveLength(4);
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(4 * 7);
    expect(logs.filter((l) => l.startsWith('warn:'))).toHaveLength(28);
  });
});

describe('beinsports cli integration (stubbed fetch, temp output)', () => {
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
    globalThis.fetch = async (url) => response(String(url).includes('beinsports-2') ? day2Html : day1Html);
    try {
      const out = path.join(tmpDir, 'bein.xml.gz');
      const exit = await runCli({
        argv: ['--provider', 'beinsports', '--out', out, '--date', '2026-09-08', '--quiet'],
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        cwd: tmpDir,
      });
      expect(exit).toBe(0);
      expect(fs.existsSync(out)).toBe(true);
      expect(fs.statSync(out).size).toBeGreaterThan(1000);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses to write an empty guide when scraping fails', async () => {
    const originalFetch = globalThis.fetch;
    // Serve well-formed pages with no guide data so every request succeeds
    // fast (a throwing stub would stall on fetchText's bounded retries).
    globalThis.fetch = async () => response('<html><body>no guide</body></html>');
    try {
      const stderr = [];
      const exit = await runCli({
        argv: ['--provider', 'beinsports', '--out', path.join(tmpDir, 'none.xml.gz'), '--quiet'],
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