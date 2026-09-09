import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mergeResults } from '../src/merge.js';
import { registerProvider } from '../src/registry.js';
import { runCli } from '../src/cli.js';
import { createCanonicalizer } from '../src/aliases.js';

const providerA = () => ({
  channels: [
    { id: 'KANAL.D.tr', name: 'KANAL D' },
    { id: 'ATV.tr', name: 'ATV' },
  ],
  programmes: [
    {
      channel: 'KANAL.D.tr',
      start: '2026-09-07T15:00:00+03:00',
      stop: '2026-09-07T17:00:00+03:00',
      title: 'A Show',
      category: 'Dizi',
    },
    {
      channel: 'ATV.tr',
      start: '2026-09-07T06:00:00+03:00',
      stop: '2026-09-07T07:00:00+03:00',
      title: 'Only In A',
    },
  ],
});

const providerB = () => ({
  channels: [
    { id: 'KANAL.D.tr', name: 'KANAL D' }, // shared channel id, other metadata
    { id: 'NTV.tr', name: 'NTV' },
  ],
  programmes: [
    {
      channel: 'KANAL.D.tr',
      start: '2026-09-07T15:00:00+03:00',
      stop: '2026-09-07T17:00:00+03:00',
      title: 'B Show', // conflicts with A on the same slot
      category: 'Haber',
    },
    {
      channel: 'NTV.tr',
      start: '2026-09-07T20:00:00+03:00',
      stop: '2026-09-07T21:00:00+03:00',
      title: 'Only In B',
    },
  ],
});

describe('mergeResults', () => {
  it('unions channels by id (first metadata wins) and programmes', () => {
    const merged = mergeResults([providerA(), providerB()]);
    expect(merged.channels.map((c) => c.id).sort()).toEqual([
      'ATV.tr',
      'KANAL.D.tr',
      'NTV.tr',
    ]);
    // First provider's metadata kept for the shared channel.
    expect(merged.channels.find((c) => c.id === 'KANAL.D.tr').name).toBe('KANAL D');
    expect(merged.channels.find((c) => c.id === 'KANAL.D.tr').icon).toBeUndefined();
    // Both only-in-one programmes present, plus the conflicting slot kept
    // from both sides (the XMLTV writer resolves the conflict, first wins).
    expect(merged.programmes).toHaveLength(4);
    expect(merged.programmes.map((p) => p.title)).toEqual([
      'A Show',
      'Only In A',
      'B Show',
      'Only In B',
    ]);
    expect(merged.duplicates).toBe(0);
  });

  it('removes exact duplicate programmes across providers', () => {
    const a = providerA();
    const b = providerB();
    b.programmes[0] = { ...a.programmes[0] }; // exact duplicate of A's slot
    const merged = mergeResults([a, b]);
    expect(merged.programmes).toHaveLength(3);
    expect(merged.duplicates).toBe(1);
  });

  it('backfills a missing icon/url from a later provider without overwriting', () => {
    const merged = mergeResults([
      { channels: [{ id: 'KANAL.D.tr', name: 'KANAL D' }], programmes: [] },
      {
        channels: [{ id: 'KANAL.D.tr', name: 'KANAL D', icon: 'https://x/logo.png', url: 'https://x/' }],
        programmes: [],
      },
    ]);
    expect(merged.channels).toHaveLength(1);
    expect(merged.channels[0].icon).toBe('https://x/logo.png');
    expect(merged.channels[0].url).toBe('https://x/');
    expect(merged.channels[0].name).toBe('KANAL D');

    // ...but never overwrites an icon the first provider already has.
    const kept = mergeResults([
      { channels: [{ id: 'KANAL.D.tr', name: 'KANAL D', icon: 'https://a/a.png' }], programmes: [] },
      { channels: [{ id: 'KANAL.D.tr', name: 'KANAL D', icon: 'https://b/b.png' }], programmes: [] },
    ]);
    expect(kept.channels[0].icon).toBe('https://a/a.png');
  });

  it('tolerates empty results', () => {
    const merged = mergeResults([{ channels: [], programmes: [] }]);
    expect(merged.channels).toEqual([]);
    expect(merged.programmes).toEqual([]);
    expect(merged.duplicates).toBe(0);
  });

  it('collapses alias ids into one canonical channel and rewrites programme refs', () => {
    const canonicalize = createCanonicalizer({ 'AHABER.tr': 'A.HABER.tr' });
    const merged = mergeResults(
      [
        {
          channels: [{ id: 'A.HABER.tr', name: 'A Haber' }],
          programmes: [
            {
              channel: 'A.HABER.tr',
              start: '2026-09-07T15:00:00+03:00',
              stop: '2026-09-07T16:00:00+03:00',
              title: 'From Hurriyet',
            },
          ],
        },
        {
          channels: [{ id: 'AHABER.tr', name: 'A Haber' }],
          programmes: [
            {
              channel: 'AHABER.tr',
              start: '2026-09-07T20:00:00+03:00',
              stop: '2026-09-07T21:00:00+03:00',
              title: 'From Mynet',
            },
          ],
        },
      ],
      canonicalize
    );
    expect(merged.channels).toHaveLength(1);
    expect(merged.channels[0].id).toBe('A.HABER.tr');
    // Every programme points at the canonical channel id.
    expect(merged.programmes.map((p) => p.channel)).toEqual(['A.HABER.tr', 'A.HABER.tr']);
    expect(merged.programmes.map((p) => p.title)).toEqual(['From Hurriyet', 'From Mynet']);
  });

  it('keeps conflicting slots from the first provider (precedence)', () => {
    // The XMLTV writer dedupes (channel, start, stop) keeping the first
    // occurrence, so the merge preserves both titles in order and lets the
    // writer resolve the conflict.  Verify order: A before B.
    const merged = mergeResults([providerA(), providerB()]);
    const slot = merged.programmes.filter(
      (p) => p.channel === 'KANAL.D.tr' && p.start === '2026-09-07T15:00:00+03:00'
    );
    expect(slot[0].title).toBe('A Show');
  });
});

describe('cli --merge', () => {
  let tmpDir;

  const scrapeA = async () => ({ ...providerA(), days: 1, failures: 0 });
  const scrapeB = async () => ({ ...providerB(), days: 1, failures: 0 });

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-scraper-merge-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
    registerProvider({ id: 'merge-a', name: 'Merge A', baseUrl: 'https://a', scrape: scrapeA });
    registerProvider({ id: 'merge-b', name: 'Merge B', baseUrl: 'https://b', scrape: scrapeB });
  });

  it('combines two providers into a single guide file', async () => {
    const stdout = [];
    const stderr = [];
    const out = path.join(tmpDir, 'merged.xml');
    const exit = await runCli({
      argv: ['--provider', 'merge-a,merge-b', '--merge', '--no-gzip', '--out', out],
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    const text = stdout.join('\n');
    expect(text).toContain('merge-a contributed 2 channels');
    expect(text).toContain('merge-b contributed 2 channels');
    expect(text).toContain('3 channels, 4 programmes from 2 provider(s)');
    expect(text).toContain(`written: ${out}`);

    expect(existsSync(out)).toBe(true);
    const xml = readFileSync(out, 'utf8');
    // One file, containing the union of both providers.
    expect(xml).toContain('<channel id="ATV.tr">');
    expect(xml).toContain('<channel id="NTV.tr">');
    expect(xml).toContain('<title lang="tr">Only In A</title>');
    expect(xml).toContain('<title lang="tr">Only In B</title>');
    // Conflicting slot keeps the first provider's version.
    const slot = xml.match(/<programme[^>]*channel="KANAL.D.tr"[^>]*>[\s\S]*?<\/programme>/);
    expect(slot).toBeDefined();
    expect(slot[0]).not.toContain('B Show');
    expect(slot[0]).toContain('A Show');
    // Only one KANAL.D.tr programme for that slot.
    expect(xml.match(/channel="KANAL.D.tr"/g)).toHaveLength(1);
  });

  it('merges the mynet+sports alias map into canonical channel ids', async () => {
    // Regression test for aliases.mynet-sports.json: mynet emits FB.TV.tr /
    // ULUSAL.TV.tr while tvplus / the reference use FENERBAHÇE.TV.tr /
    // ULUSAL.KANAL.tr. The shipped map must stay valid JSON and collapse both.
    const aliasMap = JSON.parse(
      readFileSync(path.join(process.cwd(), 'aliases.mynet-sports.json'), 'utf8')
    );
    const canonicalize = createCanonicalizer(aliasMap);

    const merged = mergeResults(
      [
        {
          channels: [{ id: 'FB.TV.tr', name: 'FB TV' }],
          programmes: [
            {
              channel: 'FB.TV.tr',
              start: '2026-09-07T15:00:00+03:00',
              stop: '2026-09-07T16:00:00+03:00',
              title: 'Mynet FB Show',
            },
          ],
        },
        {
          channels: [
            { id: 'FENERBAHÇE.TV.tr', name: 'FB TV' },
            { id: 'ULUSAL.TV.tr', name: 'ULUSAL TV' },
          ],
          programmes: [],
        },
      ],
      canonicalize
    );
    // FB collapses onto the canonical tvplus id; ULUSAL onto the reference id.
    expect(merged.channels.map((c) => c.id).sort()).toEqual([
      'FENERBAHÇE.TV.tr',
      'ULUSAL.KANAL.tr',
    ]);
    expect(merged.channels.every((c) => c.id !== 'FB.TV.tr')).toBe(true);
    expect(merged.programmes[0].channel).toBe('FENERBAHÇE.TV.tr');
  });

  it('merges aliased channel ids into one canonical channel via --alias-map', async () => {
    const aliasPath = path.join(tmpDir, 'aliases.json');
    writeFileSync(aliasPath, JSON.stringify({ 'AHABER.tr': 'A.HABER.tr' }));
    registerProvider({
      id: 'merge-alias-a',
      name: 'Alias A',
      baseUrl: 'https://a',
      scrape: async () => ({
        channels: [{ id: 'A.HABER.tr', name: 'A Haber' }],
        programmes: [
          {
            channel: 'A.HABER.tr',
            start: '2026-09-07T15:00:00+03:00',
            stop: '2026-09-07T16:00:00+03:00',
            title: 'From A',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    registerProvider({
      id: 'merge-alias-b',
      name: 'Alias B',
      baseUrl: 'https://b',
      scrape: async () => ({
        channels: [{ id: 'AHABER.tr', name: 'A Haber' }],
        programmes: [
          {
            channel: 'AHABER.tr',
            start: '2026-09-07T20:00:00+03:00',
            stop: '2026-09-07T21:00:00+03:00',
            title: 'From B',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });

    const stdout = [];
    const stderr = [];
    const out = path.join(tmpDir, 'aliased.xml');
    const exit = await runCli({
      argv: [
        '--provider',
        'merge-alias-a,merge-alias-b',
        '--merge',
        '--alias-map',
        aliasPath,
        '--no-gzip',
        '--out',
        out,
      ],
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    expect(stdout.join('\n')).toContain('alias-map: loaded 1 channel id alias(es)');
    expect(existsSync(out)).toBe(true);
    const xml = readFileSync(out, 'utf8');
    // Exactly one canonical channel, referenced by both programmes.
    expect(xml.match(/<channel id="A\.HABER\.tr">/g)).toHaveLength(1);
    expect(xml).not.toContain('AHABER.tr');
    expect(xml).toContain('<title lang="tr">From A</title>');
    expect(xml).toContain('<title lang="tr">From B</title>');
  });

  it('writes the default epg_merged_TR.xml.gz without --out', async () => {
    const stdout = [];
    const exit = await runCli({
      argv: ['--provider', 'merge-a,merge-b', '--merge', '--quiet'],
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stdout.push(s) },
      cwd: tmpDir,
    });
    expect(exit).toBe(0);
    expect(existsSync(path.join(tmpDir, 'epg_merged_TR.xml.gz'))).toBe(true);
  });

  it('rejects multiple providers without --merge', async () => {
    const stderr = [];
    const exit = await runCli({
      argv: ['--provider', 'merge-a,merge-b'],
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/require --merge/);
  });

  it('rejects combining --compare and --merge', async () => {
    const stderr = [];
    const exit = await runCli({
      argv: ['--provider', 'merge-a', '--compare', '--merge'],
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/cannot be combined/);
  });

  it('refuses to write an empty guide when every provider fails', async () => {
    registerProvider({
      id: 'merge-empty',
      name: 'Merge Empty',
      baseUrl: 'https://e',
      scrape: async () => ({ channels: [], programmes: [], days: 0, failures: 1 }),
    });
    const stderr = [];
    const exit = await runCli({
      argv: ['--provider', 'merge-empty', '--merge'],
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/nothing scraped/);
  });
});