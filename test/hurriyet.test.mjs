import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseDayPage,
  wallToIso,
  weekDays,
  slugForDate,
  mapChannelId,
  normalizeChannelKey,
  scrape,
  DAY_SLUGS,
} from '../src/providers/hurriyet.js';
import { runCli } from '../src/cli.js';

const fixturePath = fileURLToPath(new URL('./fixtures/hurriyet/day-pazartesi.html', import.meta.url));
const fixtureHtml = readFileSync(fixturePath, 'utf8');
const response = (html) => ({ ok: true, status: 200, text: async () => html });

describe('hurriyet parseDayPage (real page fixture)', () => {
  const parsed = parseDayPage(fixtureHtml);

  it('pairs the channel rail with programme rows positionally', () => {
    expect(parsed.channels).toHaveLength(31);
    expect(parsed.rowCount).toBe(31);
    expect(parsed.channels[0].name).toBe('KANAL D');
    expect(parsed.channels[0].url).toBe('https://www.hurriyet.com.tr/tv-rehberi/yayin-akisi/94/1/kanal-d/');
    expect(parsed.channels[0].icon).toContain('channel-logo/94.png');
    expect(parsed.channels[0].icon).not.toContain('?');
    expect(parsed.channels[0].icon.startsWith('https://')).toBe(true);
  });

  it('decodes HTML entities in channel and programme titles', () => {
    // CNN T&#xDC;RK -> CNN TÜRK (rail), &#x130;kizler -> İkizler (row 1 slot 3)
    expect(parsed.channels[1].name).toBe('CNN TÜRK');
    const firstRowTitles = parsed.slots.filter((s) => s.channelIndex === 0).map((s) => s.title);
    expect(firstRowTitles).toContain('İkizler Memo-Can');
    expect(firstRowTitles.some((t) => t.includes('&#'))).toBe(false);
  });

  it('parses slot times into minutes with midnight-crossing wrap', () => {
    const first = parsed.slots.find((s) => s.channelIndex === 0);
    expect(first.title).toBe("Beyaz'la Joker");
    expect(first.startMin).toBe(15);
    expect(first.endMin).toBe(165); // 00:15 - 02:45
    // A slot ending after midnight (e.g. 20:00 - 00:30) lands beyond 1440.
    const overMidnight = parsed.slots.find(
      (s) => s.channelIndex === 0 && s.endMin > 1440
    );
    expect(overMidnight).toBeDefined();
  });

  it('maps data-type genres to categories', () => {
    expect(parsed.slots.some((s) => s.category === 'Eğlence')).toBe(true);
    expect(parsed.slots.some((s) => s.category === 'Film')).toBe(true);
    expect(parsed.slots.some((s) => s.category === 'Dizi')).toBe(true);
    expect(parsed.slots.every((s) => s.title.length > 0)).toBe(true);
  });

  it('tolerates empty gutter columns', () => {
    // The first flow-module-col has no title/time and must be skipped.
    expect(parsed.slots.every((s) => s.title && Number.isFinite(s.startMin))).toBe(true);
  });

  it('is robust against truncated markup', () => {
    expect(parseDayPage('<html><body>nothing here</body></html>')).toEqual({
      channels: [],
      slots: [],
      rowCount: 0,
    });
  });
});

describe('hurriyet wallToIso', () => {
  it('stamps Istanbul wall time with the fixed +03:00 offset', () => {
    expect(wallToIso(2026, 9, 7, 15 * 60)).toBe('2026-09-07T15:00:00+03:00');
    expect(wallToIso(2026, 9, 7, 0)).toBe('2026-09-07T00:00:00+03:00');
  });

  it('rolls minutes beyond 1440 into the next day', () => {
    expect(wallToIso(2026, 9, 7, 24 * 60 + 30)).toBe('2026-09-08T00:30:00+03:00');
    expect(wallToIso(2026, 9, 30, 25 * 60)).toBe('2026-10-01T01:00:00+03:00'); // month rollover
  });
});

describe('hurriyet week mapping', () => {
  it('maps a Monday anchor to Mon..Sun', () => {
    expect(weekDays(new Date('2026-09-07T12:00:00Z'))).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ]);
  });

  it('maps a mid-week anchor to the same Monday..Sunday week', () => {
    const days = weekDays(new Date('2026-09-09T12:00:00Z')); // Wednesday
    expect(days[0]).toBe('2026-09-07');
    expect(days[6]).toBe('2026-09-13');
  });

  it('slugForDate matches day slugs in order', () => {
    expect(slugForDate('2026-09-07')).toBe('pazartesi');
    expect(slugForDate('2026-09-08')).toBe('sali');
    expect(slugForDate('2026-09-13')).toBe('pazar');
    expect(DAY_SLUGS).toHaveLength(7);
  });
});

describe('hurriyet channel id mapping', () => {
  it('uses curated epgshare01 ids', () => {
    expect(mapChannelId('KANAL D')).toBe('KANAL.D.tr');
    expect(mapChannelId('beIN SPORTS 1')).toBe('beIN.SPORTS.1.tr');
    expect(mapChannelId('EUROSPORT 2 INT')).toBe('EUROSPORT.2.TR.HD.tr');
    expect(mapChannelId('TRT 3 -  SPOR')).toBe('TRT.SPOR.tr');
  });

  it('normalizes station aliases to the epgshare01 reference ids', () => {
    expect(mapChannelId('NOW')).toBe('FOX.tr'); // FOX rebrand
    expect(mapChannelId('TV2')).toBe('TEVE2.tr'); // same feed/logo as teve2
  });

  it('falls back to the generic slug for unknown channels', () => {
    expect(mapChannelId('Yeni Kanal 9')).toBe('YENI.KANAL.9.tr');
  });

  it('normalizes whitespace before lookup', () => {
    expect(normalizeChannelKey('  TRT   3  -  SPOR ')).toBe('TRT 3 - SPOR');
  });
});

describe('hurriyet scrape (stubbed week)', () => {
  const stubFetch = (pages) =>
    async (url) => {
      for (const [needle, html] of pages) {
        if (url.includes(needle)) return response(html);
      }
      throw new Error(`unexpected url ${url}`);
    };

  it('scrapes seven day pages and merges them', async () => {
    const logs = [];
    const result = await scrape({
      dates: weekDays(new Date('2026-09-07T12:00:00Z')),
      fetchImpl: stubFetch(DAY_SLUGS.map((slug) => [slug, fixtureHtml])),
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
    });

    expect(result.days).toBe(7);
    expect(result.failures).toBe(0);
    expect(result.channels.map((c) => c.id)).toContain('KANAL.D.tr');
    expect(result.programmes.length).toBeGreaterThan(7 * 31 * 5); // sane lower bound
    // Every programme's channel must be a known channel id.
    const ids = new Set(result.channels.map((c) => c.id));
    expect(result.programmes.every((p) => ids.has(p.channel))).toBe(true);
    expect(logs.some((l) => l.startsWith('ok:'))).toBe(true);
  });

  it('clamps any requested window to one Monday..Sunday week', async () => {
    const urls = [];
    await scrape({
      dates: ['2026-09-09', '2026-09-10'],
      fetchImpl: async (url) => {
        urls.push(url);
        return response(fixtureHtml);
      },
      log: () => {},
      politenessDelayMs: 0,
      fetchOptions: { retries: 0 },
    });
    expect(urls).toHaveLength(7); // full week, not 2 days
  });

  it('dedupes exact repeats across days', async () => {
    const result = await scrape({
      dates: weekDays(new Date('2026-09-07T12:00:00Z')),
      fetchImpl: stubFetch(DAY_SLUGS.map((slug) => [slug, fixtureHtml])),
      log: () => {},
      politenessDelayMs: 0,
    });
    const keys = new Set(
      result.programmes.map((p) => [p.channel, p.start, p.stop, p.title].join('|'))
    );
    expect(keys.size).toBe(result.programmes.length);
  });

  it('degrades gracefully when all pages fail', async () => {
    const logs = [];
    const result = await scrape({
      fetchImpl: async () => {
        throw new Error('HTTP 503');
      },
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
    });
    expect(result.channels).toEqual([]);
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(7);
    expect(logs.filter((l) => l.startsWith('warn:'))).toHaveLength(7);
  });
});

describe('cli integration (stubbed fetch, temp output)', () => {
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
      if (!String(url).includes('hurriyet.com.tr')) throw new Error(`unexpected url ${url}`);
      return response(fixtureHtml);
    };
    try {
      const out = path.join(tmpDir, 'guide.xml.gz');
      const stdout = [];
      const exit = await runCli({
        argv: ['--provider', 'hurriyet', '--out', out, '--date', '2026-09-07', '--quiet'],
        stdout: { write: (s) => stdout.push(s) },
        stderr: { write: (s) => stdout.push(s) },
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
    globalThis.fetch = async () => {
      throw new Error('HTTP 503');
    };
    try {
      const stderr = [];
      const exit = await runCli({
        argv: ['--provider', 'hurriyet', '--out', path.join(tmpDir, 'none.xml.gz'), '--quiet'],
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

  it('lists providers and shows help', async () => {
    const stdout = [];
    const sink = { write: (s) => stdout.push(s) };
    expect(await runCli({ argv: ['--list-providers'], stdout: sink, stderr: sink })).toBe(0);
    expect(stdout.join('')).toMatch(/hurriyet/);
    expect(await runCli({ argv: ['--help'], stdout: sink, stderr: sink })).toBe(0);
    expect(stdout.join('')).toMatch(/Usage:/);
  });
});
