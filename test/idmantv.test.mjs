import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseWeeklyPage,
  parseDayTitle,
  mapChannelId,
  normalizeChannelKey,
  scrape,
  CHANNELS,
  CHANNEL_ID_MAP,
  weekPageUrl,
} from '../src/providers/idmantv.js';
import { runCli } from '../src/cli.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/idmantv/${name}`, import.meta.url)), 'utf8');

// Live snapshot of https://idmantv.az/az/program (fetched 2026-09-12),
// covering the Mon–Sun week 07.09.2026 – 13.09.2026, 133 programme rows.
const program = fixture('program-2026-09-07.html');

const response = (html) => ({ ok: true, status: 200, text: async () => html });

describe('idmantv pure parsers', () => {
  it('parses the full published Mon–Sun week', () => {
    const { weekStart, weekEnd, days } = parseWeeklyPage(program);
    expect(weekStart).toBe('2026-09-07');
    expect(weekEnd).toBe('2026-09-13');
    expect(days).toHaveLength(7);
    expect(days.map((d) => d.date)).toEqual([
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ]);
    expect(days.map((d) => d.slots.length)).toEqual([23, 21, 20, 19, 22, 20, 8]);
  });

  it('keeps Azerbaijani day names with their dates', () => {
    const { days } = parseWeeklyPage(program);
    expect(days[0].dayName).toBe('Bazar ertəsi');
    expect(days[5].dayName).toBe('Şənbə');
    expect(days[6].dayName).toBe('Bazar');
  });

  it('extracts time/name slots with collapsed whitespace', () => {
    const { days } = parseWeeklyPage(program);
    expect(days[0].slots[0]).toEqual({ startMin: 60, title: 'Bədii film.”Döyüşçü”' });
    expect(days[0].slots[days[0].slots.length - 1].startMin).toBe(1410); // 23:30
    expect(days[0].slots[days[0].slots.length - 1].title).toBe(
      'Futbol.İspaniya çempionatı Elçe – Real Sosyedad (canlı)'
    );
    expect(
      days[0].slots.every((s) => Number.isFinite(s.startMin) && s.title.length > 0)
    ).toBe(true);
  });

  it('emits stray cross-channel notes verbatim (as published)', () => {
    const { days } = parseWeeklyPage(program);
    // The site appends "Mədəniyyət TV" / "AZTV" to the last Sunday slots.
    expect(days[6].slots[6].title).toContain('Mədəniyyət TV');
    expect(days[6].slots[7].title).toContain('AZTV');
  });

  it('parses day titles into dates', () => {
    expect(parseDayTitle('Bazar ertəsi / 07.09.2026')).toEqual({
      dayName: 'Bazar ertəsi',
      date: '2026-09-07',
    });
    expect(parseDayTitle('Şənbə / 12.09.2026')).toEqual({
      dayName: 'Şənbə',
      date: '2026-09-12',
    });
    expect(parseDayTitle('  Bazar / 13.09.2026 ')).toEqual({
      dayName: 'Bazar',
      date: '2026-09-13',
    });
  });

  it('rejects impossible dates, not just out-of-range ones', () => {
    expect(parseDayTitle('X / 31.02.2026')).toBeUndefined(); // Feb 31
    expect(parseDayTitle('X / 13.13.2026')).toBeUndefined(); // month 13
    expect(parseDayTitle('X / 32.01.2026')).toBeUndefined(); // day 32
    expect(parseDayTitle('garbage')).toBeUndefined();
    expect(parseDayTitle(undefined)).toBeUndefined();
  });

  it('degrades gracefully on malformed markup', () => {
    expect(parseWeeklyPage(undefined)).toEqual({
      weekStart: undefined,
      weekEnd: undefined,
      days: [],
    });
    expect(parseWeeklyPage('<html><body>no schedule here</body></html>')).toEqual({
      weekStart: undefined,
      weekEnd: undefined,
      days: [],
    });
  });

  it('drops hostile rows on a well-formed day card', () => {
    const hostile =
      '<div class="week-grid"><div class="day-card">' +
      '<h3 class="day-title">Bazar ertəsi / 07.09.2026</h3>' +
      '<div class="programs-list">' +
      '<div class="prog-row"><span class="prog-time">10:00</span><span class="prog-name">A&amp;B İdman</span></div>' +
      '<div class="prog-row"><span class="prog-time">25:10</span><span class="prog-name">Bad hour</span></div>' +
      '<div class="prog-row"><span class="prog-time">24:30</span><span class="prog-name">Bad 24:30</span></div>' +
      '<div class="prog-row"><span class="prog-time">18:60</span><span class="prog-name">Bad minute</span></div>' +
      '</div></div></div>';
    const { days } = parseWeeklyPage(hostile);
    expect(days).toHaveLength(1);
    expect(days[0].slots).toEqual([{ startMin: 600, title: 'A&B İdman' }]); // entities decoded
  });

  it('drops a day card whose date is impossible', () => {
    const hostile =
      '<div class="week-grid">' +
      '<div class="day-card"><h3 class="day-title">X / 31.02.2026</h3>' +
      '<div class="programs-list"><div class="prog-row"><span class="prog-time">10:00</span><span class="prog-name">Phantom</span></div></div></div>' +
      '<div class="day-card"><h3 class="day-title">Bazar / 13.09.2026</h3>' +
      '<div class="programs-list"><div class="prog-row"><span class="prog-time">11:00</span><span class="prog-name">Real</span></div></div></div>' +
      '</div>';
    const { weekStart, weekEnd, days } = parseWeeklyPage(hostile);
    expect(weekStart).toBe('2026-09-13');
    expect(weekEnd).toBe('2026-09-13');
    expect(days).toHaveLength(1);
    expect(days[0].slots[0].title).toBe('Real');
  });

  it('maps the display names to the curated id', () => {
    expect(mapChannelId('İdman TV')).toBe('IDMAN.TV.tr');
    expect(mapChannelId('İDMAN TELEVİZİYASI')).toBe('IDMAN.TV.tr');
    expect(mapChannelId('beIN Sports 1')).toBeUndefined(); // served by beinsports
    expect(normalizeChannelKey('İdman TV')).toBe('İDMAN TV');
    expect(normalizeChannelKey('  idman   tv ')).toBe('IDMAN TV'); // ASCII i -> I
    expect(CHANNEL_ID_MAP['İDMAN TV']).toBe('IDMAN.TV.tr');
    expect(CHANNEL_ID_MAP['İDMAN TELEVİZİYASI']).toBe('IDMAN.TV.tr');
    expect(CHANNELS[0].id.endsWith('.tr')).toBe(true);
    expect(weekPageUrl()).toBe('https://idmantv.az/az/program');
  });
});
describe('idmantv scrape (stubbed fetch)', () => {
  it('serves only the requested dates from the published week', async () => {
    const result = await scrape({
      dates: ['2026-09-12'],
      fetchImpl: async () => response(program),
      politenessDelayMs: 0,
    });
    expect(result.programmes).toHaveLength(20); // Şənbə
    expect(result.programmes.every((p) => p.channel === 'IDMAN.TV.tr')).toBe(true);
    expect(result.programmes[0]).toEqual({
      channel: 'IDMAN.TV.tr',
      start: '2026-09-12T01:00:00+03:00',
      stop: '2026-09-12T03:00:00+03:00',
      title: 'Bədii film.”Şöhrət qanadlarında”',
    });
    // Last slot's stop derives from end of day (24:00).
    expect(result.programmes[result.programmes.length - 1].stop).toBe(
      '2026-09-13T00:00:00+03:00'
    );
  });

  it('merges several requested dates and sorts by channel then start', async () => {
    const result = await scrape({
      dates: ['2026-09-07', '2026-09-09'],
      fetchImpl: async () => response(program),
      politenessDelayMs: 0,
    });
    expect(result.programmes).toHaveLength(23 + 20);
    const keys = result.programmes.map((p) => [p.channel, p.start]);
    const sorted = [...keys].sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
    expect(keys).toEqual(sorted);
  });

  it('skips dates outside the published week with a warning', async () => {
    const logs = [];
    const result = await scrape({
      dates: ['2026-09-14'],
      fetchImpl: async () => response(program),
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(0);
    expect(
      logs.some((l) => l.includes('outside the published 2026-09-07..2026-09-13 week'))
    ).toBe(true);
  });

  it('fails cleanly when the weekly page fetch throws', async () => {
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => {
        throw new Error('HTTP 503');
      },
      politenessDelayMs: 0,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(1);
  });

  it('degrades when the page carries no parseable schedule', async () => {
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => response('<html><body>no schedule rows</body></html>'),
      politenessDelayMs: 0,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(1);
  });

  it('drops zero-length slots caused by repeated times', async () => {
    const repeated =
      '<div class="week-grid"><div class="day-card">' +
      '<h3 class="day-title">Bazar ertəsi / 07.09.2026</h3>' +
      '<div class="programs-list">' +
      '<div class="prog-row"><span class="prog-time">10:00</span><span class="prog-name">Foo</span></div>' +
      '<div class="prog-row"><span class="prog-time">10:00</span><span class="prog-name">Bar</span></div>' +
      '</div></div></div>';
    const result = await scrape({
      dates: ['2026-09-07'],
      fetchImpl: async () => response(repeated),
      politenessDelayMs: 0,
    });
    expect(result.programmes).toHaveLength(1);
    expect(result.programmes[0]).toEqual({
      channel: 'IDMAN.TV.tr',
      start: '2026-09-07T10:00:00+03:00',
      stop: '2026-09-08T00:00:00+03:00',
      title: 'Bar',
    });
  });
});

describe('idmantv cli integration (stubbed fetch, temp output)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-scraper-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  it('writes a gzipped xmltv guide for the requested day', async () => {
    const { default: fs } = await import('node:fs');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => response(program);
    try {
      const out = path.join(tmpDir, 'idmantv.xml.gz');
      const exit = await runCli({
        argv: [
          '--provider', 'idmantv',
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
      expect(fs.statSync(out).size).toBeGreaterThan(300);
      const xml = gunzipSync(fs.readFileSync(out)).toString('utf8');
      expect(xml).toContain('IDMAN.TV.tr');
      expect(xml).toContain('<display-name lang="tr">İdman TV</display-name>');
      expect(xml).toContain('Basketbol.Avroliqa'); // a 2026-09-08 fixture programme
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses to write an empty guide when the page has no schedule', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => response('<html><body>no schedule rows</body></html>');
    try {
      const stderr = [];
      const exit = await runCli({
        argv: [
          '--provider', 'idmantv',
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
