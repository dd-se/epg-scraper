import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  compareResults,
  renderCompareReport,
  compareProviderResults,
  renderProviderCompareReport,
  programmeKey,
} from '../src/compare.js';
import { registerProvider } from '../src/registry.js';
import { runCli } from '../src/cli.js';
import { createCanonicalizer } from '../src/aliases.js';

// --- pure comparison logic ---

const httpSide = () => ({
  channels: [
    { id: 'KANAL.D.tr', name: 'KANAL D' },
    { id: 'ATV.tr', name: 'ATV' },
  ],
  programmes: [
    {
      channel: 'KANAL.D.tr',
      start: '2026-09-07T15:00:00+03:00',
      stop: '2026-09-07T17:00:00+03:00',
      title: 'Same Show',
      category: 'Dizi',
    },
    {
      channel: 'ATV.tr',
      start: '2026-09-07T06:00:00+03:00',
      stop: '2026-09-07T07:00:00+03:00',
      title: 'Http Only',
    },
  ],
});

const browserSide = () => ({
  channels: [
    { id: 'KANAL.D.tr', name: 'KANAL D' },
    { id: 'NTV.tr', name: 'NTV' },
  ],
  programmes: [
    {
      channel: 'KANAL.D.tr',
      start: '2026-09-07T15:00:00+03:00',
      stop: '2026-09-07T17:00:00+03:00',
      title: 'Same Show',
      category: 'Dizi',
    },
    {
      channel: 'KANAL.D.tr',
      start: '2026-09-07T17:00:00+03:00',
      stop: '2026-09-07T18:00:00+03:00',
      title: 'Browser Extra',
    },
  ],
});

describe('compareResults', () => {
  it('reports identical results as fully matched', () => {
    const report = compareResults({ http: httpSide(), browser: httpSide() });
    expect(report.channels.common).toHaveLength(2);
    expect(report.channels.onlyHttp).toEqual([]);
    expect(report.channels.onlyBrowser).toEqual([]);
    expect(report.programmes.matched).toBe(2);
    expect(report.programmes.changed).toEqual([]);
    expect(report.programmes.onlyHttp).toEqual([]);
    expect(report.programmes.onlyBrowser).toEqual([]);
  });

  it('detects channels and programmes present on only one side', () => {
    const report = compareResults({ http: httpSide(), browser: browserSide() });
    expect(report.channels.common).toEqual(['KANAL.D.tr']);
    expect(report.channels.onlyHttp).toEqual(['ATV.tr']);
    expect(report.channels.onlyBrowser).toEqual(['NTV.tr']);
    expect(report.programmes.matched).toBe(1);
    expect(report.programmes.onlyHttp.map(programmeKey)).toEqual([
      'ATV.tr|2026-09-07T06:00:00+03:00|2026-09-07T07:00:00+03:00',
    ]);
    expect(report.programmes.onlyBrowser).toHaveLength(1);
    expect(report.programmes.onlyBrowser[0].title).toBe('Browser Extra');
  });

  it('flags same-slot titles/categories that differ', () => {
    const http = httpSide();
    const browser = browserSide();
    browser.programmes[0] = { ...http.programmes[0], title: 'Renamed in Browser' };
    const report = compareResults({ http, browser });
    expect(report.programmes.changed).toHaveLength(1);
    expect(report.programmes.changed[0].diffs).toEqual(['title']);
    expect(report.programmes.changed[0].http.title).toBe('Same Show');
    expect(report.programmes.changed[0].browser.title).toBe('Renamed in Browser');
    expect(report.programmes.changed[0].key).toBe(
      'KANAL.D.tr|2026-09-07T15:00:00+03:00|2026-09-07T17:00:00+03:00'
    );
  });

  it('collapses duplicate slots per (channel, start, stop) before comparing', () => {
    const http = httpSide();
    const browser = httpSide();
    browser.programmes.push({ ...browser.programmes[0] }); // duplicate slot
    const report = compareResults({ http, browser });
    expect(report.programmes.matched).toBe(2); // no phantom only-browser entry
    expect(report.programmes.onlyBrowser).toEqual([]);
  });
});

describe('renderCompareReport', () => {
  it('summarizes counts and samples differences', () => {
    const report = compareResults({ http: httpSide(), browser: browserSide() });
    const text = renderCompareReport({ providerId: 'fake', report }).join('\n');
    expect(text).toContain('compare: http vs browser (fake)');
    expect(text).toContain('channels only in http:    ATV.tr');
    expect(text).toContain('channels only in browser: NTV.tr');
    expect(text).toContain('[only browser]');
    expect(text).toContain('[only http]');
    expect(text).toContain('differences (showing');
  });

  it('says no differences when the sides agree', () => {
    const lines = renderCompareReport({
      providerId: 'fake',
      report: compareResults({ http: httpSide(), browser: httpSide() }),
    });
    expect(lines.join('\n')).toContain('no differences');
  });

  it('respects the sample limit', () => {
    const programmes = [];
    for (let i = 0; i < 12; i++) {
      programmes.push({
        channel: 'KANAL.D.tr',
        start: `2026-09-07T${String(i).padStart(2, '0')}:00:00+03:00`,
        stop: `2026-09-07T${String(i).padStart(2, '0')}:30:00+03:00`,
        title: `T${i}`,
      });
    }
    const http = { channels: [{ id: 'KANAL.D.tr', name: 'KANAL D' }], programmes };
    const browser = {
      channels: [{ id: 'KANAL.D.tr', name: 'KANAL D' }],
      programmes: programmes.map((p) => ({ ...p, title: p.title + 'X' })),
    };
    const report = compareResults({ http, browser });
    const lines = renderCompareReport({ providerId: 'fake', report, limit: 3 });
    const text = lines.join('\n');
    expect(text).toContain('showing 3 of 12');
    expect(text.match(/\[changed\]/g)).toHaveLength(3);
  });
});

// --- provider vs provider ---

const providerASide = () => ({
  channels: [
    { id: 'ATV.tr', name: 'ATV' },
    { id: 'KANAL.D.tr', name: 'KANAL D' },
  ],
  programmes: [
    {
      channel: 'ATV.tr',
      start: '2026-09-07T15:00:00+03:00',
      stop: '2026-09-07T16:00:00+03:00',
      title: 'Same Show',
      category: 'Dizi',
    },
    {
      channel: 'ATV.tr',
      start: '2026-09-07T18:00:00+03:00',
      stop: '2026-09-07T19:00:00+03:00',
      title: 'Only In A',
    },
  ],
});

const providerBSide = () => ({
  channels: [
    { id: 'ATV.tr', name: 'ATV' },
    { id: 'NTV.tr', name: 'NTV' },
  ],
  programmes: [
    {
      channel: 'ATV.tr',
      start: '2026-09-07T15:00:00+03:00',
      stop: '2026-09-07T16:00:00+03:00',
      title: 'Same Show',
      category: 'Dizi',
    },
    {
      channel: 'ATV.tr',
      start: '2026-09-07T20:00:00+03:00',
      stop: '2026-09-07T21:00:00+03:00',
      title: 'Only In B',
    },
  ],
});

describe('compareProviderResults', () => {
  it('diffs per channel and aggregates across the guide', () => {
    const report = compareProviderResults({ a: providerASide(), b: providerBSide() });
    const atv = report.channels.find((c) => c.id === 'ATV.tr');
    expect(atv.inA).toBe(true);
    expect(atv.inB).toBe(true);
    expect(atv.matched).toBe(1);
    expect(atv.onlyA).toBe(1);
    expect(atv.onlyB).toBe(1);
    // Channels present on one side only.
    const kanalD = report.channels.find((c) => c.id === 'KANAL.D.tr');
    expect(kanalD.inA).toBe(true);
    expect(kanalD.inB).toBe(false);
    expect(kanalD.programmesA).toBe(0);
    const ntv = report.channels.find((c) => c.id === 'NTV.tr');
    expect(ntv.inA).toBe(false);
    expect(ntv.inB).toBe(true);
    // Summary.
    expect(report.summary.common).toEqual(['ATV.tr']);
    expect(report.summary.onlyAChannels).toEqual(['KANAL.D.tr']);
    expect(report.summary.onlyBChannels).toEqual(['NTV.tr']);
    expect(report.summary.matched).toBe(1);
    expect(report.summary.changed).toEqual([]);
    expect(report.summary.onlyA).toHaveLength(1);
    expect(report.summary.onlyB).toHaveLength(1);
  });

  it('flags same-slot title/category changes per channel', () => {
    const a = providerASide();
    const b = providerBSide();
    b.programmes[0] = { ...a.programmes[0], title: 'Renamed In B', category: 'Haber' };
    const report = compareProviderResults({ a, b });
    const atv = report.channels.find((c) => c.id === 'ATV.tr');
    expect(atv.changed).toBe(1);
    expect(atv.matched).toBe(0);
    expect(report.summary.changed).toHaveLength(1);
    expect(report.summary.changed[0].key).toBe(
      'ATV.tr|2026-09-07T15:00:00+03:00|2026-09-07T16:00:00+03:00'
    );
    expect(report.summary.changed[0].diffs).toEqual(['title', 'category']);
    expect(atv.samples[0].kind).toBe('changed');
  });

  it('tolerates empty sides', () => {
    const report = compareProviderResults({ a: { channels: [], programmes: [] }, b: providerBSide() });
    expect(report.summary.channelsA).toBe(0);
    expect(report.summary.onlyBChannels).toEqual(['ATV.tr', 'NTV.tr']);
  });

  it('resolves channel-id aliases onto one canonical channel', () => {
    const canonicalize = createCanonicalizer({ 'AHABER.tr': 'A.HABER.tr' });
    const a = {
      channels: [{ id: 'A.HABER.tr', name: 'A Haber' }],
      programmes: [
        {
          channel: 'A.HABER.tr',
          start: '2026-09-07T15:00:00+03:00',
          stop: '2026-09-07T16:00:00+03:00',
          title: 'Ana Haber',
        },
      ],
    };
    const b = {
      channels: [{ id: 'AHABER.tr', name: 'A Haber' }],
      programmes: [
        {
          channel: 'AHABER.tr',
          start: '2026-09-07T15:00:00+03:00',
          stop: '2026-09-07T16:00:00+03:00',
          title: 'Ana Haber',
        },
      ],
    };
    const report = compareProviderResults({ a, b, canonicalize });
    // The two ids collapse onto the canonical channel.
    expect(report.summary.common).toEqual(['A.HABER.tr']);
    expect(report.summary.onlyAChannels).toEqual([]);
    expect(report.summary.onlyBChannels).toEqual([]);
    expect(report.summary.matched).toBe(1);
    expect(report.summary.changed).toEqual([]);
  });
});

describe('renderProviderCompareReport', () => {
  it('renders summary, per-channel breakdown and samples', () => {
    const report = compareProviderResults({ a: providerASide(), b: providerBSide() });
    const text = renderProviderCompareReport({
      providerA: 'hurriyet',
      providerB: 'mynet',
      report,
    }).join('\n');
    expect(text).toContain('compare providers: hurriyet vs mynet');
    expect(text).toContain('channel breakdown:');
    expect(text).toContain('ATV.tr');
    expect(text).toContain('both: hurriyet 2 progs | mynet 2 progs | matched 1 | changed 0 | only-hurriyet 1 | only-mynet 1');
    expect(text).toContain('only in mynet (0 programmes)');
    expect(text).toContain('only in hurriyet (0 programmes)');
    expect(text).toContain('[only hurriyet]');
    expect(text).toContain('[only mynet]');
    expect(text).toContain('differences (showing');
  });

  it('says no differences when the sides agree', () => {
    const report = compareProviderResults({ a: providerASide(), b: providerASide() });
    const text = renderProviderCompareReport({
      providerA: 'a',
      providerB: 'b',
      report,
    }).join('\n');
    expect(text).toContain('no differences');
  });
});

// --- CLI integration ---

// vi.hoisted() ensures these objects exist before vi.mock factories execute.
const mocks = vi.hoisted(() => {
  const page = {
    goto: vi.fn().mockResolvedValue(undefined),
    content: vi.fn().mockResolvedValue('<html></html>'),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    newPage: vi.fn().mockResolvedValue(page),
    route: vi.fn().mockResolvedValue(undefined),
    addInitScript: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const browser = {
    newContext: vi.fn().mockResolvedValue(context),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const chromium = { launch: vi.fn().mockResolvedValue(browser) };
  return { page, context, browser, chromium };
});

vi.mock('playwright', () => ({ chromium: mocks.chromium }));

describe('cli --compare', () => {
  let tmpDir;
  let scrapeCalls;

  const httpResult = {
    channels: [{ id: 'KANAL.D.tr', name: 'KANAL D' }],
    programmes: [
      {
        channel: 'KANAL.D.tr',
        start: '2026-09-07T15:00:00+03:00',
        stop: '2026-09-07T16:00:00+03:00',
        title: 'HTTP SHOW',
      },
    ],
  };
  const browserResult = {
    channels: [
      { id: 'KANAL.D.tr', name: 'KANAL D' },
      { id: 'NTV.tr', name: 'NTV' },
    ],
    programmes: [
      {
        channel: 'KANAL.D.tr',
        start: '2026-09-07T15:00:00+03:00',
        stop: '2026-09-07T16:00:00+03:00',
        title: 'BROWSER SHOW',
      },
      {
        channel: 'NTV.tr',
        start: '2026-09-07T18:00:00+03:00',
        stop: '2026-09-07T19:00:00+03:00',
        title: 'BONUS',
      },
    ],
  };

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-scraper-compare-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
    scrapeCalls = [];
    vi.clearAllMocks();
    // Re-wire default return values after clearAllMocks.
    mocks.chromium.launch.mockResolvedValue(mocks.browser);
    mocks.browser.newContext.mockResolvedValue(mocks.context);
    mocks.context.newPage.mockResolvedValue(mocks.page);
    mocks.page.goto.mockResolvedValue(undefined);
    mocks.page.content.mockResolvedValue('<html></html>');
    mocks.page.close.mockResolvedValue(undefined);
    mocks.context.addInitScript.mockResolvedValue(undefined);
    mocks.context.close.mockResolvedValue(undefined);
    mocks.browser.close.mockResolvedValue(undefined);
  });

  it('scrapes both modes, writes both guides and reports differences', async () => {
    registerProvider({
      id: 'compare-fake',
      name: 'Compare Fake',
      baseUrl: 'https://example.com',
      scrape: async ({ fetchImpl, dates }) => {
        scrapeCalls.push({ fetchImpl: !!fetchImpl, dates });
        return fetchImpl ? browserResult : httpResult;
      },
    });

    const stdout = [];
    const stderr = [];
    const exit = await runCli({
      argv: [
        '--provider',
        'compare-fake',
        '--compare',
        '--no-gzip',
        '--out',
        path.join(tmpDir, 'guide.xml'),
      ],
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    // Exactly two scrapes: one plain HTTP, one browser-backed.
    expect(scrapeCalls).toHaveLength(2);
    expect(scrapeCalls[0].fetchImpl).toBe(false);
    expect(scrapeCalls[1].fetchImpl).toBe(true);
    // Same date window for both runs.
    expect(scrapeCalls[0].dates).toEqual(scrapeCalls[1].dates);

    const text = stdout.join('\n');
    expect(text).toContain('compare: http vs browser (compare-fake)');
    expect(text).toContain('channels only in browser: NTV.tr');
    expect(text).toContain('[changed]');
    expect(text).toContain('[only browser]');
    expect(text).toContain('written:');
    expect(existsSync(path.join(tmpDir, 'guide.http.xml'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'guide.browser.xml'))).toBe(true);
  });

  it('fails cleanly when the browser cannot be launched', async () => {
    mocks.chromium.launch.mockRejectedValue(new Error('Executable does not exist'));
    const stdout = [];
    const stderr = [];
    const exit = await runCli({
      argv: ['--provider', 'compare-fake', '--compare'],
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/Executable does not exist/);
    expect(mocks.browser.close).not.toHaveBeenCalled();
  });

  it('compares two providers channel by channel and writes both sides', async () => {
    const cmpA = {
      channels: [{ id: 'ATV.tr', name: 'ATV' }],
      programmes: [
        {
          channel: 'ATV.tr',
          start: '2026-09-07T15:00:00+03:00',
          stop: '2026-09-07T16:00:00+03:00',
          title: 'A Show',
        },
      ],
    };
    const cmpB = {
      channels: [
        { id: 'ATV.tr', name: 'ATV' },
        { id: 'NTV.tr', name: 'NTV' },
      ],
      programmes: [
        {
          channel: 'ATV.tr',
          start: '2026-09-07T15:00:00+03:00',
          stop: '2026-09-07T16:00:00+03:00',
          title: 'B Show',
        },
        {
          channel: 'NTV.tr',
          start: '2026-09-07T20:00:00+03:00',
          stop: '2026-09-07T21:00:00+03:00',
          title: 'NTV News',
        },
      ],
    };
    registerProvider({
      id: 'cmp-a',
      name: 'Cmp A',
      baseUrl: 'https://a',
      scrape: async () => ({ ...cmpA, days: 1, failures: 0 }),
    });
    registerProvider({
      id: 'cmp-b',
      name: 'Cmp B',
      baseUrl: 'https://b',
      scrape: async () => ({ ...cmpB, days: 1, failures: 0 }),
    });

    const stdout = [];
    const stderr = [];
    const out = path.join(tmpDir, 'cmp.xml');
    const exit = await runCli({
      argv: ['--provider', 'cmp-a,cmp-b', '--compare', '--no-gzip', '--out', out],
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    const text = stdout.join('\n');
    expect(text).toContain('compare providers: cmp-a vs cmp-b');
    expect(text).toContain('channel breakdown:');
    expect(text).toContain('ATV.tr');
    expect(text).toContain('[changed]');
    expect(text).toContain('NTV.tr');
    expect(text).toContain('only in cmp-b (1 programmes)');
    expect(existsSync(path.join(tmpDir, 'cmp.cmp-a.xml'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'cmp.cmp-b.xml'))).toBe(true);
    // cmp-b's side contains the channel cmp-a lacks.
    const bXml = readFileSync(path.join(tmpDir, 'cmp.cmp-b.xml'), 'utf8');
    expect(bXml).toContain('<channel id="NTV.tr">');
  });

  it('passes --stealth through to the browser launch', async () => {
    registerProvider({
      id: 'stealth-fake',
      name: 'Stealth Fake',
      baseUrl: 'https://s',
      scrape: async () => ({
        channels: [{ id: 'ATV.tr', name: 'ATV' }],
        programmes: [
          {
            channel: 'ATV.tr',
            start: '2026-09-07T15:00:00+03:00',
            stop: '2026-09-07T16:00:00+03:00',
            title: 'X',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });

    const stdout = [];
    const stderr = [];
    const exit = await runCli({
      argv: [
        '--provider',
        'stealth-fake',
        '--compare',
        '--stealth',
        '--no-gzip',
        '--out',
        path.join(tmpDir, 'stealth.xml'),
      ],
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    expect(mocks.chromium.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.arrayContaining(['--disable-blink-features=AutomationControlled']),
      })
    );
    expect(mocks.context.addInitScript).toHaveBeenCalled();
  });

  it('rejects more than two providers with --compare', async () => {
    const stderr = [];
    const exit = await runCli({
      argv: ['--provider', 'cmp-a,cmp-b,cmp-a', '--compare'],
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/at most two providers/);
  });

  it('applies --alias-map so aliased channel ids compare as one', async () => {
    const aliasPath = path.join(tmpDir, 'aliases.json');
    writeFileSync(aliasPath, JSON.stringify({ 'AHABER.tr': 'A.HABER.tr' }));
    registerProvider({
      id: 'cmp-alias-a',
      name: 'Alias A',
      baseUrl: 'https://a',
      scrape: async () => ({
        channels: [{ id: 'A.HABER.tr', name: 'A Haber' }],
        programmes: [
          {
            channel: 'A.HABER.tr',
            start: '2026-09-07T15:00:00+03:00',
            stop: '2026-09-07T16:00:00+03:00',
            title: 'Ana Haber',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    registerProvider({
      id: 'cmp-alias-b',
      name: 'Alias B',
      baseUrl: 'https://b',
      scrape: async () => ({
        channels: [{ id: 'AHABER.tr', name: 'A Haber' }],
        programmes: [
          {
            channel: 'AHABER.tr',
            start: '2026-09-07T15:00:00+03:00',
            stop: '2026-09-07T16:00:00+03:00',
            title: 'Ana Haber',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });

    const stdout = [];
    const stderr = [];
    const exit = await runCli({
      argv: [
        '--provider',
        'cmp-alias-a,cmp-alias-b',
        '--compare',
        '--alias-map',
        aliasPath,
        '--no-gzip',
        '--out',
        path.join(tmpDir, 'alias.xml'),
      ],
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    const text = stdout.join('\n');
    expect(text).toContain('alias-map: loaded 1 channel id alias(es)');
    // One common channel instead of two "only in" entries.
    expect(text).toContain('common 1');
    expect(text).not.toContain('channels only in cmp-alias-a:');
    expect(text).not.toContain('channels only in cmp-alias-b:');
    expect(text).toContain('result: no differences');
  });

  it('fails when the alias map file is missing or invalid', async () => {
    const stderr = [];
    const exit = await runCli({
      argv: [
        '--provider',
        'cmp-a,cmp-b',
        '--compare',
        '--alias-map',
        path.join(tmpDir, 'nope.json'),
      ],
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/failed to read alias map/);
  });
});