import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { mergeResults } from '../src/merge.js';
import { registerProvider } from '../src/registry.js';
import { runCli } from '../src/cli.js';
import { createCanonicalizer } from '../src/aliases.js';
import { readXmltvFile } from '../src/xmltv.js';
import { mapChannelId as mynetMapChannelId } from '../src/providers/mynet.js';
import { mapChannelId as tvplusMapChannelId } from '../src/providers/tvplus.js';

const providerA = () => ({
  channels: [
    { id: 'KANALD.tr', name: 'KANAL D' },
    { id: 'ATV.tr', name: 'ATV' },
  ],
  programmes: [
    {
      channel: 'KANALD.tr',
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
    { id: 'KANALD.tr', name: 'KANAL D' }, // shared channel id, other metadata
    { id: 'NTV.tr', name: 'NTV' },
  ],
  programmes: [
    {
      channel: 'KANALD.tr',
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
      'KANALD.tr',
      'NTV.tr',
    ]);
    // First provider's metadata kept for the shared channel.
    expect(merged.channels.find((c) => c.id === 'KANALD.tr').name).toBe('KANAL D');
    expect(merged.channels.find((c) => c.id === 'KANALD.tr').icon).toBeUndefined();
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
      { channels: [{ id: 'KANALD.tr', name: 'KANAL D' }], programmes: [] },
      {
        channels: [{ id: 'KANALD.tr', name: 'KANAL D', icon: 'https://x/logo.png', url: 'https://x/' }],
        programmes: [],
      },
    ]);
    expect(merged.channels).toHaveLength(1);
    expect(merged.channels[0].icon).toBe('https://x/logo.png');
    expect(merged.channels[0].url).toBe('https://x/');
    expect(merged.channels[0].name).toBe('KANAL D');

    // ...but never overwrites an icon the first provider already has.
    const kept = mergeResults([
      { channels: [{ id: 'KANALD.tr', name: 'KANAL D', icon: 'https://a/a.png' }], programmes: [] },
      { channels: [{ id: 'KANALD.tr', name: 'KANAL D', icon: 'https://b/b.png' }], programmes: [] },
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
    const canonicalize = createCanonicalizer({ 'AHABER.tr': 'AHABERX.tr' });
    const merged = mergeResults(
      [
        {
          channels: [{ id: 'AHABER.tr', name: 'A Haber' }],
          programmes: [
            {
              channel: 'AHABER.tr',
              start: '2026-09-07T15:00:00+03:00',
              stop: '2026-09-07T16:00:00+03:00',
              title: 'From Hurriyet',
            },
          ],
        },
        {
          channels: [{ id: 'AHABERX.tr', name: 'A Haber' }],
          programmes: [
            {
              channel: 'AHABERX.tr',
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
    expect(merged.channels[0].id).toBe('AHABERX.tr');
    // Every programme points at the canonical channel id.
    expect(merged.programmes.map((p) => p.channel)).toEqual(['AHABERX.tr', 'AHABERX.tr']);
    expect(merged.programmes.map((p) => p.title)).toEqual(['From Hurriyet', 'From Mynet']);
  });

  it('leaves channel ids that collide with Object.prototype keys untouched', () => {
    // Regression: the canonicalizer used `id in map`, which also matches
    // inherited keys, so `constructor` resolved to Object.prototype.constructor
    // (a function). mergeResults then rejected the non-string id and silently
    // dropped the channel *and* every programme on it. Own-property lookup only.
    const canonicalize = createCanonicalizer({ 'AHABER.tr': 'AHABERX.tr' });
    const protoKeys = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'];
    const merged = mergeResults(
      [
        {
          channels: protoKeys.map((id) => ({ id, name: id })),
          programmes: protoKeys.map((id) => ({
            channel: id,
            start: '2026-09-07T15:00:00+03:00',
            stop: '2026-09-07T16:00:00+03:00',
            title: `On ${id}`,
          })),
        },
      ],
      canonicalize
    );
    expect(merged.channels.map((c) => c.id)).toEqual(protoKeys);
    expect(merged.programmes.map((p) => p.channel)).toEqual(protoKeys);
  });

  it('canonicalizes through an alias map with prototype keys as real entries', () => {
    // An alias map may legitimately alias one of those names; an own entry must
    // still win, and must not send resolution off the prototype chain.
    const canonicalize = createCanonicalizer({ constructor: 'ATV.tr', toString: 'TRT1.tr' });
    expect(canonicalize('constructor')).toBe('ATV.tr');
    expect(canonicalize('toString')).toBe('TRT1.tr');
    expect(canonicalize('__proto__')).toBe('__proto__');
    expect(canonicalize('valueOf')).toBe('valueOf');
  });

  it('still resolves transitively and terminates on a cycle', () => {
    const canonicalize = createCanonicalizer({ 'A.tr': 'B.tr', 'B.tr': 'C.tr', 'X.tr': 'Y.tr', 'Y.tr': 'X.tr' });
    expect(canonicalize('A.tr')).toBe('C.tr');
    expect(canonicalize('B.tr')).toBe('C.tr');
    // A cycle resolves to a member of the cycle rather than looping forever.
    expect(['X.tr', 'Y.tr']).toContain(canonicalize('X.tr'));
    // An id that is absent is returned unchanged.
    expect(canonicalize('ATV.tr')).toBe('ATV.tr');
  });

  it('ignores non-string alias targets instead of returning an object as an id', () => {
    const canonicalize = createCanonicalizer({ 'A.tr': { nested: 'B.tr' }, 'B.tr': 42 });
    expect(canonicalize('A.tr')).toBe('A.tr');
    expect(canonicalize('B.tr')).toBe('B.tr');
  });

  it('resolves an alias whatever the case of either spelling', () => {
    // Reaching for this flag means the guide on the other side is not ours, so
    // neither the map's key nor the id it is asked about need share our casing.
    const canonicalize = createCanonicalizer({ 'fbtv.tr': 'FENERBAHCETV.tr' });
    expect(canonicalize('FBTV.tr')).toBe('FENERBAHCETV.tr');
    expect(canonicalize('fbtv.tr')).toBe('FENERBAHCETV.tr');
    // The canonical value is emitted verbatim, not re-cased.
    expect(canonicalize('FENERBAHCETV.tr')).toBe('FENERBAHCETV.tr');
  });

  it('unions ids that differ only in case into one channel', () => {
    // Turkish ids are upper-cased by the seam, so this is exercised through the
    // ids that are written verbatim: matching is on the key, never on the
    // literal spelling, and the guide keeps the first provider's spelling.
    const slot = (channel) => ({
      channel,
      start: '2026-09-07T15:00:00+02:00',
      stop: '2026-09-07T16:00:00+02:00',
      title: 'Rapport',
    });
    const merged = mergeResults([
      {
        channels: [{ id: '[SVT1HD].SVT1.HD.se', name: 'SVT 1' }],
        programmes: [slot('[SVT1HD].SVT1.HD.se')],
        language: 'sv',
      },
      {
        channels: [{ id: '[svt1hd].svt1.hd.se', name: 'SVT 1' }],
        programmes: [slot('[svt1hd].svt1.hd.se')],
        language: 'sv',
      },
    ]);
    expect(merged.channels.map((c) => c.id)).toEqual(['[SVT1HD].SVT1.HD.se']);
    // The second provider's programme was rewritten onto that spelling, so the
    // identical slot deduped instead of surviving under a second id.
    expect(merged.programmes.map((p) => p.channel)).toEqual(['[SVT1HD].SVT1.HD.se']);
    expect(merged.duplicates).toBe(1);
  });

  it('keeps conflicting slots from the first provider (precedence)', () => {
    // The XMLTV writer dedupes (channel, start, stop) keeping the first
    // occurrence, so the merge preserves both titles in order and lets the
    // writer resolve the conflict.  Verify order: A before B.
    const merged = mergeResults([providerA(), providerB()]);
    const slot = merged.programmes.filter(
      (p) => p.channel === 'KANALD.tr' && p.start === '2026-09-07T15:00:00+03:00'
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
    const slot = xml.match(/<programme[^>]*channel="KANALD.tr"[^>]*>[\s\S]*?<\/programme>/);
    expect(slot).toBeDefined();
    expect(slot[0]).not.toContain('B Show');
    expect(slot[0]).toContain('A Show');
    // Only one KANALD.tr programme for that slot.
    expect(xml.match(/channel="KANALD.tr"/g)).toHaveLength(1);
  });

  it('needs no alias map for mynet+tvplus: both curate the same FB TV id', () => {
    // Regression test for the deleted aliases.mynet-sports.json: mynet used to
    // emit FBTV.tr where tvplus curates FENERBAHCETV.tr, and the map papered
    // over it. Both adapters now curate one id, so a merge needs no
    // canonicalizer at all.
    expect(mynetMapChannelId('FB TV')).toBe(tvplusMapChannelId('FB TV'));
    expect(mynetMapChannelId('ULUSAL TV')).toBe('ULUSALTV.tr');

    const merged = mergeResults([
      {
        channels: [{ id: 'FENERBAHCETV.tr', name: 'FB TV' }],
        programmes: [
          {
            channel: 'FENERBAHCETV.tr',
            start: '2026-09-07T15:00:00+03:00',
            stop: '2026-09-07T16:00:00+03:00',
            title: 'Mynet FB Show',
          },
        ],
      },
      { channels: [{ id: 'FENERBAHCETV.tr', name: 'FB TV' }], programmes: [] },
    ]);
    expect(merged.channels.map((c) => c.id)).toEqual(['FENERBAHCETV.tr']);
    expect(merged.programmes[0].channel).toBe('FENERBAHCETV.tr');
  });

  it('keeps only each provider\'s sports channels with --sports-only', async () => {
    // The real case: tvplus is a sports-profile provider that also curates the
    // general-interest lineup, so the sports merge must take its sports subset
    // (SSPORT1.tr) and leave the national channels (ATV.tr) behind.  Driven
    // through the real catalog ids rather than a fake provider, because the
    // allow-list is catalog data.
    const { CHANNELS, SPORTS_CHANNEL_IDS } = await import('../src/providers/tvplus.js');
    const sportsId = SPORTS_CHANNEL_IDS[0];
    const generalId = CHANNELS.find((c) => !SPORTS_CHANNEL_IDS.includes(c.id)).id;
    const guide = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tv generator-info-name="test">',
      ...[sportsId, generalId].map(
        (id) => `<channel id="${id}"><display-name>${id}</display-name></channel>`
      ),
      ...[sportsId, generalId].map(
        (id) =>
          `<programme start="20260907150000 +0300" stop="20260907160000 +0300" channel="${id}">` +
          `<title>Show ${id}</title></programme>`
      ),
      '</tv>',
    ].join('\n');
    const input = path.join(tmpDir, 'epg_tvplus_TR.xml');
    writeFileSync(input, guide);

    const run = async (argv) => {
      const out = path.join(tmpDir, `sports-${argv.includes('--sports-only') ? 'on' : 'off'}.xml`);
      const lines = [];
      const exit = await runCli({
        // No --quiet: the per-provider "N sports channels" line is part of
        // what this test pins.
        argv: [...argv, '--from', input, '--out', out, '--no-gzip'],
        stdout: { write: (s) => lines.push(s) },
        stderr: { write: (s) => lines.push(s) },
        cwd: tmpDir,
      });
      return { exit, out, log: lines.join('\n') };
    };

    const all = await run(['--merge']);
    expect(all.exit).toBe(0);
    const allProgrammes = (await readXmltvFile(all.out)).programmes;
    expect(allProgrammes.map((p) => p.channel)).toContain(generalId);

    const sports = await run(['--merge', '--sports-only']);
    expect(sports.exit).toBe(0);
    const sportsGuide = await readXmltvFile(sports.out);
    expect(sportsGuide.channels.map((c) => c.id)).toEqual([sportsId]);
    expect(sportsGuide.programmes.map((p) => p.channel)).toEqual([sportsId]);
    expect(sports.log).toMatch(/sports channels/);
  });

  it('passes an unknown input file through --sports-only untouched', async () => {
    const out = path.join(tmpDir, 'unknown.xml');
    const input = path.join(tmpDir, 'third-party.xml');
    writeFileSync(
      input,
      '<?xml version="1.0" encoding="UTF-8"?><tv>' +
        '<channel id="WHATEVER.tr"><display-name>Third party</display-name></channel>' +
        '<programme start="20260907150000 +0300" stop="20260907160000 +0300" channel="WHATEVER.tr">' +
        '<title>Show</title></programme></tv>'
    );
    const lines = [];
    const exit = await runCli({
      argv: ['--merge', '--sports-only', '--from', input, '--out', out, '--no-gzip'],
      stdout: { write: (s) => lines.push(s) },
      stderr: { write: (s) => lines.push(s) },
      cwd: tmpDir,
    });
    expect(exit).toBe(0);
    // A file we cannot attribute to a provider is kept whole rather than emptied.
    const merged = await readXmltvFile(out);
    expect(merged.channels.map((c) => c.id)).toEqual(['WHATEVER.tr']);
    expect(merged.programmes.map((p) => p.channel)).toEqual(['WHATEVER.tr']);
    expect(lines.join('\n')).toMatch(/not a known provider/);
  });

  it('merges aliased channel ids into one canonical channel via --alias-map', async () => {
    const aliasPath = path.join(tmpDir, 'aliases.json');
    writeFileSync(aliasPath, JSON.stringify({ 'AHABER.tr': 'AHABERX.tr' }));
    registerProvider({
      id: 'merge-alias-a',
      name: 'Alias A',
      baseUrl: 'https://a',
      scrape: async () => ({
        channels: [{ id: 'AHABER.tr', name: 'A Haber' }],
        programmes: [
          {
            channel: 'AHABER.tr',
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
    expect(xml.match(/<channel id="AHABERX\.tr">/g)).toHaveLength(1);
    expect(xml).not.toContain('id="AHABER.tr"');
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

  it('--keep-channels writes a channels-only guide when a provider has no programmes', async () => {
    registerProvider({
      id: 'merge-channels-only',
      name: 'Merge Channels Only',
      baseUrl: 'https://e',
      scrape: async () => ({
        channels: [{ id: 'ATV.tr', name: 'ATV', icon: 'https://e/atv.png' }],
        programmes: [],
        days: 1,
        failures: 0,
      }),
    });
    const out = path.join(tmpDir, 'channels-only.xml.gz');
    const exit = await runCli({
      argv: [
        '--provider', 'merge-channels-only',
        '--merge',
        '--out', out,
        '--keep-channels',
        '--quiet',
      ],
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    expect(existsSync(out)).toBe(true);
    const xml = gunzipSync(readFileSync(out)).toString('utf8');
    expect(xml).toContain('<channel id="ATV.tr">');
    expect(xml).toContain('<icon src="https://e/atv.png"');
    expect(xml).not.toContain('<programme ');
  });
});