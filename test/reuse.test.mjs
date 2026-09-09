// Offline reuse: the XMLTV reader (parseXmltv/fromXmltvTimestamp/
// readXmltvFile) and `--merge --from` (merge already-scraped guides with
// zero live-server hits).  All inputs are generated locally via the writer —
// never live network.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  generateXmltv,
  parseXmltv,
  fromXmltvTimestamp,
  readXmltvFile,
  writeXmltv,
} from '../src/xmltv.js';
import { runCli } from '../src/cli.js';

function tmpDir(prefix) {
  const dir = path.join(
    process.env.TMPDIR || '/tmp',
    `${prefix}-${process.pid}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

const guideA = {
  channels: [{ id: 'ATV.tr', name: 'ATV', icon: 'https://x/atv.png' }],
  programmes: [
    {
      channel: 'ATV.tr',
      start: '2026-09-07T06:00:00+03:00',
      stop: '2026-09-07T07:00:00+03:00',
      title: 'Morning & Live <özel>',
      category: 'Haber',
    },
  ],
};

const guideB = {
  channels: [{ id: 'NTV.tr', name: 'NTV' }],
  programmes: [
    {
      channel: 'NTV.tr',
      start: '2026-09-07T20:00:00+03:00',
      stop: '2026-09-07T21:00:00+03:00',
      title: 'Night',
    },
  ],
};

describe('fromXmltvTimestamp', () => {
  it('converts writer timestamps back to ISO', () => {
    expect(fromXmltvTimestamp('20260907150000 +0300')).toBe('2026-09-07T15:00:00+03:00');
    expect(fromXmltvTimestamp('20260907060000 +0000')).toBe('2026-09-07T06:00:00+00:00');
  });

  it('rejects malformed input', () => {
    expect(() => fromXmltvTimestamp('not a timestamp')).toThrow(/Invalid XMLTV timestamp/);
    expect(() => fromXmltvTimestamp('20260907 +0300')).toThrow(/Invalid XMLTV timestamp/);
    expect(() => fromXmltvTimestamp(null)).toThrow(/Invalid XMLTV timestamp/);
  });

  it('rejects impossible dates the writer would never emit (Feb 30, month 13, bad offset)', () => {
    expect(() => fromXmltvTimestamp('20260230120000 +0300')).toThrow(/Impossible XMLTV timestamp/);
    expect(() => fromXmltvTimestamp('20261301120000 +0300')).toThrow(/Impossible XMLTV timestamp/);
    expect(() => fromXmltvTimestamp('20260907250000 +0300')).toThrow(/Impossible XMLTV timestamp/);
    expect(() => fromXmltvTimestamp('20260907120000 +2500')).toThrow(/Impossible XMLTV timestamp/);
  });
});

describe('parseXmltv', () => {
  it('round-trips writer output back to the internal model', () => {
    const xml = generateXmltv({ ...guideA, generatorInfoName: 'test' });
    const parsed = parseXmltv(xml);
    expect(parsed.channels).toEqual(guideA.channels);
    expect(parsed.programmes).toEqual(guideA.programmes);
  });

  it('round-trips every optional field (sub-title, desc, category, icons, url)', () => {
    const full = {
      channels: [{ id: 'X.tr', name: 'X', icon: 'https://x/l.png', url: 'https://x/' }],
      programmes: [
        {
          channel: 'X.tr',
          start: '2026-09-07T06:00:00+03:00',
          stop: '2026-09-07T07:00:00+03:00',
          title: 'T',
          subTitle: 'S',
          desc: 'D',
          category: 'C',
          icon: 'https://x/p.png',
        },
      ],
    };
    expect(parseXmltv(generateXmltv(full))).toEqual(full);
  });

  it('degrades hostile entries to skips instead of throwing', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<tv generator-info-name="test" generator-info-url="none">
  <channel id="OK.tr"><display-name lang="tr">OK</display-name></channel>
  <channel><display-name lang="tr">no id</display-name></channel>
  <programme start="20260907060000 +0300" stop="20260907070000 +0300" channel="OK.tr"><title lang="tr">Good</title></programme>
  <programme start="bogus" stop="20260907070000 +0300" channel="OK.tr"><title lang="tr">Bad start</title></programme>
  <programme start="20260230120000 +0300" stop="20260230130000 +0300" channel="OK.tr"><title lang="tr">Feb 30</title></programme>
  <programme start="20260907080000 +0300" stop="20260907070000 +0300" channel="OK.tr"><title lang="tr">Reversed</title></programme>
  <programme start="20260907080000 +0300" stop="20260907080000 +0300" channel="OK.tr"><title lang="tr">Zero</title></programme>
  <programme start="20260907090000 +0300" stop="20260907100000 +0300" channel="OK.tr"></programme>
  <programme start="20260907090000 +0300" stop="20260907100000 +0300" channel="GHOST.tr"><title lang="tr">Dangling</title></programme>
</tv>`;
    const parsed = parseXmltv(xml);
    expect(parsed.channels).toEqual([{ id: 'OK.tr', name: 'OK' }]);
    expect(parsed.programmes).toEqual([
      {
        channel: 'OK.tr',
        start: '2026-09-07T06:00:00+03:00',
        stop: '2026-09-07T07:00:00+03:00',
        title: 'Good',
      },
    ]);
  });

  it('returns empty results for null/non-string input', () => {
    expect(parseXmltv(null)).toEqual({ channels: [], programmes: [] });
    expect(parseXmltv('')).toEqual({ channels: [], programmes: [] });
    expect(parseXmltv('<tv></tv>')).toEqual({ channels: [], programmes: [] });
  });
});

describe('readXmltvFile', () => {
  it('reads plain .xml and gzipped .xml.gz files', async () => {
    const dir = tmpDir('epg-reuse-read');
    const plain = path.join(dir, 'guide.xml');
    const gz = path.join(dir, 'guide.xml.gz');
    await writeXmltv({ ...guideA, outputPath: plain, gzip: false });
    await writeXmltv({ ...guideA, outputPath: gz, gzip: true });
    expect(await readXmltvFile(plain)).toEqual(guideA);
    expect(await readXmltvFile(gz)).toEqual(guideA);
  });

  it('rejects on missing files', async () => {
    await expect(readXmltvFile('/tmp/epg-reuse-missing-12345.xml.gz')).rejects.toThrow();
  });
});

describe('cli --merge --from', () => {
  let dir;
  let fileA;
  let fileB;

  beforeEach(async () => {
    dir = tmpDir('epg-reuse-merge');
    fileA = path.join(dir, 'epg_a_TR.xml.gz');
    fileB = path.join(dir, 'epg_b_TR.xml.gz');
    await writeXmltv({ ...guideA, outputPath: fileA, gzip: true });
    await writeXmltv({ ...guideB, outputPath: fileB, gzip: true });
  });

  const run = (argv, cwd) =>
    runCli({
      argv,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      cwd: cwd ?? dir,
    });

  it('merges files offline into one guide (no provider scraping)', async () => {
    const out = path.join(dir, 'merged.xml');
    const exit = await run(['--merge', '--from', `${fileA},${fileB}`, '--no-gzip', '--out', out]);
    expect(exit).toBe(0);
    expect(existsSync(out)).toBe(true);
    const xml = readFileSync(out, 'utf8');
    expect(xml).toContain('<channel id="ATV.tr">');
    expect(xml).toContain('<channel id="NTV.tr">');
    expect(xml).toContain('<title lang="tr">Morning &amp; Live &lt;özel&gt;</title>');
    expect(xml).toContain('<title lang="tr">Night</title>');
    // Round-trips back through the reader with both programmes intact.
    const parsed = parseXmltv(xml);
    expect(parsed.channels.map((c) => c.id).sort()).toEqual(['ATV.tr', 'NTV.tr']);
    expect(parsed.programmes).toHaveLength(2);
  });

  it('ignores --provider when --from is given (proves no live scrape)', async () => {
    const out = path.join(dir, 'merged2.xml');
    const exit = await run(['--provider', 'no-such-provider', '--merge', '--from', fileA, '--no-gzip', '--out', out]);
    expect(exit).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it('first file wins conflicting slots, mirroring provider precedence', async () => {
    const clash = {
      channels: [{ id: 'ATV.tr', name: 'ATV' }],
      programmes: [
        {
          channel: 'ATV.tr',
          start: '2026-09-07T06:00:00+03:00',
          stop: '2026-09-07T07:00:00+03:00',
          title: 'Other Title',
        },
      ],
    };
    const fileC = path.join(dir, 'epg_c_TR.xml.gz');
    await writeXmltv({ ...clash, outputPath: fileC, gzip: true });
    const out = path.join(dir, 'clash.xml');
    const exit = await run(['--merge', '--from', `${fileA},${fileC}`, '--no-gzip', '--out', out]);
    expect(exit).toBe(0);
    const xml = readFileSync(out, 'utf8');
    expect(xml).toContain('Morning &amp; Live');
    expect(xml).not.toContain('Other Title');
  });

  it('applies --alias-map to file inputs', async () => {
    const aliasPath = path.join(dir, 'aliases.json');
    writeFileSync(aliasPath, JSON.stringify({ 'NTV.tr': 'ATV.tr' }));
    const out = path.join(dir, 'aliased.xml');
    const stdout = [];
    const exit = await runCli({
      argv: ['--merge', '--from', `${fileA},${fileB}`, '--alias-map', aliasPath, '--no-gzip', '--out', out],
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: () => {} },
      cwd: dir,
    });
    expect(exit).toBe(0);
    expect(stdout.join('\n')).toContain('alias-map: loaded 1 channel id alias(es)');
    const xml = readFileSync(out, 'utf8');
    expect(xml.match(/<channel id="ATV\.tr">/g)).toHaveLength(1);
    expect(xml).not.toContain('NTV.tr');
  });

  it('rejects --from without --merge', async () => {
    const stderr = [];
    const exit = await runCli({
      argv: ['--from', fileA],
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: dir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/--from requires --merge/);
  });

  it('fails cleanly on a missing input file', async () => {
    const stderr = [];
    const exit = await runCli({
      argv: ['--merge', '--from', path.join(dir, 'nope.xml.gz')],
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: dir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/--from/);
  });

  it('refuses to write an empty guide when every file is empty', async () => {
    const empty = path.join(dir, 'empty.xml');
    writeFileSync(empty, '<?xml version="1.0" encoding="UTF-8"?>\n<tv></tv>\n');
    const stderr = [];
    const exit = await runCli({
      argv: ['--merge', '--from', empty, '--no-gzip', '--out', path.join(dir, 'out.xml')],
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: dir,
    });
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/nothing merged/);
  });
});
