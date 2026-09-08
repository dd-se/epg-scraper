// Adversarial tests: hostile, malformed and boundary inputs that a scraper
// fed from the open web can legitimately encounter.  The contract under test
// (see AGENTS.md): malformed remote data degrades to an empty/warned result —
// never a crash — and the emitted XMLTV stays well-formed and matches the
// epgshare01 reference shape even when scraped content tries to break out of
// the markup.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { decodeEntities } from '../src/entities.js';
import { channelIdFromName } from '../src/slug.js';
import { toXmltvTimestamp, generateXmltv } from '../src/xmltv.js';
import { fetchText } from '../src/http.js';
import { parseDayPage } from '../src/providers/hurriyet.js';
import { parseMainPage, parseChannelPage } from '../src/providers/mynet.js';
import { mergeResults } from '../src/merge.js';
import { compareResults, compareProviderResults } from '../src/compare.js';
import { registerProvider } from '../src/registry.js';
import { runCli } from '../src/cli.js';

// ---------------------------------------------------------------------------
// decodeEntities — entity bombs, XML-illegal code points, broken entities
// ---------------------------------------------------------------------------

describe('adversarial: decodeEntities', () => {
  it('never decodes numeric refs to XML-illegal code points', () => {
    // C0 controls (except tab/LF/CR) are not representable in XML 1.0.
    expect(decodeEntities('&#0;')).toBe('&#0;');
    expect(decodeEntities('a&#8;b')).toBe('a&#8;b');
    expect(decodeEntities('&#x1F;')).toBe('&#x1F;');
    // Lone surrogates are not representable either.
    expect(decodeEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeEntities('&#xDFFF;')).toBe('&#xDFFF;');
    // Noncharacters and out-of-range code points stay raw.
    expect(decodeEntities('&#xFFFE;')).toBe('&#xFFFE;');
    expect(decodeEntities('&#xFFFF;')).toBe('&#xFFFF;');
    expect(decodeEntities('&#x110000;')).toBe('&#x110000;');
    expect(decodeEntities('&#xFFFFFFFF;')).toBe('&#xFFFFFFFF;');
    expect(decodeEntities('&#-1;')).toBe('&#-1;');
  });

  it('still decodes XML-legal control references', () => {
    expect(decodeEntities('&#x9;')).toBe('\t');
    expect(decodeEntities('&#xA;')).toBe('\n');
    expect(decodeEntities('&#xD;')).toBe('\r');
  });

  it('leaves entity-like text without a semicolon intact', () => {
    expect(decodeEntities('&#x131')).toBe('&#x131');
    expect(decodeEntities('&amp')).toBe('&amp');
    expect(decodeEntities('&notanentity;')).toBe('&notanentity;');
  });

  it('decodes double-encoded entities exactly once', () => {
    expect(decodeEntities('&amp;amp;')).toBe('&amp;');
    expect(decodeEntities('&amp;lt;')).toBe('&lt;');
  });

  it('decodes markup-char refs but the XMLTV writer must re-escape them', () => {
    // &#x3C; = '<', &#x3E; = '>' — the decoder is not the last line of defense.
    expect(decodeEntities('&#x3C;script&#x3E;')).toBe('<script>');
  });
});

// ---------------------------------------------------------------------------
// channelIdFromName — unicode, punctuation-only, colliding, huge names
// ---------------------------------------------------------------------------

describe('adversarial: channelIdFromName', () => {
  it('never returns an empty or non-.tr id for non-string input', () => {
    for (const input of [null, undefined, '', '   ', 42, {}, [], true]) {
      const id = channelIdFromName(input);
      expect(id.endsWith('.tr')).toBe(true);
      expect(id).not.toBe('.tr');
    }
  });

  it('maps punctuation-only names to the UNKNOWN fallback', () => {
    expect(channelIdFromName('///')).toBe('UNKNOWN.tr');
    expect(channelIdFromName('...')).toBe('UNKNOWN.tr');
    expect(channelIdFromName('!!!')).toBe('UNKNOWN.tr');
  });

  it('degrades unicode-only names deterministically instead of crashing', () => {
    expect(channelIdFromName('СТС')).toBe('UNKNOWN.tr'); // Cyrillic
    expect(channelIdFromName('📺 TV')).toBe('TV.tr'); // emoji collapses
    expect(channelIdFromName('İSTANBUL')).toBe('STANBUL.tr'); // dotted İ is non-ASCII
  });

  it('collapses different spellings of the same name onto one id', () => {
    expect(channelIdFromName('A.B')).toBe('A.B.tr');
    expect(channelIdFromName('A B')).toBe('A.B.tr');
    expect(channelIdFromName('A_B')).toBe('A.B.tr');
    expect(channelIdFromName('A-B')).toBe('A.B.tr');
    expect(channelIdFromName('a.b')).toBe('A.B.tr');
    expect(channelIdFromName('..A..B..')).toBe('A.B.tr');
  });

  it('handles a huge name without crashing or pathological whitespace output', () => {
    const id = channelIdFromName('X'.repeat(100_000) + ' '.repeat(50_000));
    expect(id.endsWith('.tr')).toBe(true);
    expect(id.length).toBe(100_000 + 3); // the X-run survives, the space run collapses
    const unicode = channelIdFromName('Ü'.repeat(10_000));
    expect(unicode).toBe('UNKNOWN.tr');
  });
});

// ---------------------------------------------------------------------------
// toXmltvTimestamp — impossible dates/times that must not be silently rolled
// ---------------------------------------------------------------------------

describe('adversarial: toXmltvTimestamp', () => {
  it('rejects impossible calendar dates', () => {
    expect(() => toXmltvTimestamp('2026-02-30T00:00:00+03:00')).toThrow(/Impossible/);
    expect(() => toXmltvTimestamp('2026-04-31T00:00:00+03:00')).toThrow(/Impossible/);
    expect(() => toXmltvTimestamp('2026-13-01T00:00:00+03:00')).toThrow();
    expect(() => toXmltvTimestamp('2026-00-10T00:00:00+03:00')).toThrow();
    expect(() => toXmltvTimestamp('2026-09-00T00:00:00+03:00')).toThrow();
    expect(() => toXmltvTimestamp('2025-02-29T00:00:00+03:00')).toThrow(); // not a leap year
  });

  it('rejects impossible times of day', () => {
    expect(() => toXmltvTimestamp('2026-09-07T24:00:00+03:00')).toThrow(/Impossible/);
    expect(() => toXmltvTimestamp('2026-09-07T23:60:00+03:00')).toThrow(/Impossible/);
    expect(() => toXmltvTimestamp('2026-09-07T23:59:60+03:00')).toThrow(/Impossible/);
  });

  it('rejects malformed or impossible UTC offsets', () => {
    expect(() => toXmltvTimestamp('2026-09-07T15:00:00+99:00')).toThrow(/Invalid offset/);
    expect(() => toXmltvTimestamp('2026-09-07T15:00:00+03:99')).toThrow(/Invalid offset/);
    expect(() => toXmltvTimestamp('2026-09-07T15:00:00+3:00')).toThrow();
    expect(() => toXmltvTimestamp('2026-09-07T15:00:00+03000')).toThrow();
  });

  it('rejects non-string input', () => {
    for (const input of [null, undefined, 20260907, {}, []]) {
      expect(() => toXmltvTimestamp(input)).toThrow();
    }
  });

  it('still accepts real edge instants', () => {
    expect(toXmltvTimestamp('2028-02-29T23:59:59+03:00')).toBe('20280229235959 +0300'); // leap day
    expect(toXmltvTimestamp('2026-09-07T00:00:00+03:00')).toBe('20260907000000 +0300');
    expect(toXmltvTimestamp('2026-09-07T15:00:00+0300')).toBe('20260907150000 +0300');
    expect(toXmltvTimestamp('2026-09-07T12:00:00Z')).toBe('20260907120000 +0000');
  });
});

// ---------------------------------------------------------------------------
// generateXmltv — XML/attribute injection through scraped content
// ---------------------------------------------------------------------------

describe('adversarial: generateXmltv', () => {
  const channels = [{ id: 'X.tr', name: 'X' }];
  const programme = (title, extra = {}) => ({
    channel: 'X.tr',
    start: '2026-09-07T00:00:00+03:00',
    stop: '2026-09-07T01:00:00+03:00',
    title,
    ...extra,
  });

  it('neutralizes markup-injection titles', () => {
    const xml = generateXmltv({
      channels,
      programmes: [
        programme('</title><script>alert(1)</script>'),
        programme('</programme><channel id="EVIL.tr">', { start: '2026-09-07T01:00:00+03:00' }),
      ],
    });
    expect(xml).not.toContain('<script>');
    expect(xml.match(/<channel /g)).toHaveLength(1); // only the real channel
    expect(xml).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(xml).toContain('&lt;/programme&gt;&lt;channel id=&quot;EVIL.tr&quot;&gt;');
  });

  it('neutralizes attribute-injection through quoted text and attributes', () => {
    const evilId = 'X" onclick="evil()';
    const xml = generateXmltv({
      channels: [
        { id: evilId, name: 'A&B <b>', icon: 'https://x/" onload="evil()' },
      ],
      programmes: [
        { channel: evilId, start: '2026-09-07T00:00:00+03:00', stop: '2026-09-07T01:00:00+03:00', title: '" onmouseover="alert(1)' },
      ],
      generatorInfoName: '"><script>alert(1)</script>',
    });
    expect(xml).not.toContain('onmouseover="alert(1)"');
    expect(xml).not.toContain('<script>');
    expect(xml).toContain('&quot; onmouseover=&quot;alert(1)');
    expect(xml).toContain('A&amp;B &lt;b&gt;');
    expect(xml).toContain('id="X&quot; onclick=&quot;evil()"');
    expect(xml).toContain('src="https://x/&quot; onload=&quot;evil()"');
    expect(xml).toContain('generator-info-name="&quot;&gt;&lt;script&gt;');
  });

  it('escapes CDATA-close sequences', () => {
    const xml = generateXmltv({ channels, programmes: [programme('x]]>y')] });
    expect(xml).toContain(']]&gt;');
    expect(xml).not.toContain(']]>');
  });

  it('strips XML-illegal control chars and lone surrogates from scraped text', () => {
    const xml = generateXmltv({
      channels,
      programmes: [
        programme('a\u0000b\u0007c'),
        { ...programme('lone \uD800 surrogate'), start: '2026-09-07T01:00:00+03:00' },
        { ...programme('U+FFFE\uFFFEnonchar'), start: '2026-09-07T02:00:00+03:00' },
      ],
    });
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/.test(xml)).toBe(false);
    expect(xml).toContain('<title lang="tr">abc</title>');
  });

  it('re-escapes entity-decoded markup so the output stays well-formed', () => {
    const xml = generateXmltv({
      channels,
      programmes: [programme(decodeEntities('&#x3C;script&#x3E;alert(1)&#x3C;/script&#x3E;'))],
    });
    expect(xml).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(xml).not.toContain('<script>');
  });

  it('tolerates empty titles/names without crashing', () => {
    const xml = generateXmltv({
      channels: [{ id: 'X.tr', name: 'X' }, { id: 'Y.tr', name: '' }],
      programmes: [programme(''), programme('   ', { start: '2026-09-07T01:00:00+03:00' })],
    });
    expect(xml).toContain('<display-name lang="tr"></display-name>');
    expect(xml).toContain('<title lang="tr"></title>');
  });

  it('throws on non-array inputs and unknown channels', () => {
    expect(() => generateXmltv({ channels: 'nope', programmes: [] })).toThrow(/channels must be an array/);
    expect(() => generateXmltv({ channels, programmes: 'nope' })).toThrow(/programmes must be an array/);
    expect(() =>
      generateXmltv({ channels, programmes: [programme('x', { channel: 'EVIL.tr' })] })
    ).toThrow(/unknown channel/);
  });
});

// ---------------------------------------------------------------------------
// provider parsers — null, truncated and hostile markup
// ---------------------------------------------------------------------------

describe('adversarial: provider parsers', () => {
  it('parseDayPage degrades non-string pages to an empty result', () => {
    for (const html of [null, undefined, 42, {}, [], '']) {
      expect(parseDayPage(html)).toEqual({ channels: [], slots: [], rowCount: 0 });
    }
  });

  it('parseDayPage survives truncated markup', () => {
    expect(parseDayPage('<li class="flow-module-channel"><img alt="KANAL D">')).toEqual({
      channels: [],
      slots: [],
      rowCount: 0,
    });
    const truncated = '<div class="flow-module-row"><div class="flow-module-col" data-type="dizi"><h2 class="column-title">Interrupted';
    expect(parseDayPage(truncated).channels).toEqual([]); // no crash
  });

  it('parseDayPage skips slots whose times are out of the clock', () => {
    const page = (time) =>
      `<div class="flow-module-row"><div class="flow-module-col" data-type="dizi">` +
      `<h2 class="column-title">X</h2><span class="column-time">${time}</span></div></div>`;
    // 99:99 / missing minutes: no match, slot dropped.
    expect(parseDayPage(page('99:99 - 99:99')).slots).toEqual([]);
    expect(parseDayPage(page('10 - 11')).slots).toEqual([]);
    // 25:00 parses as 1500 minutes since midnight (rolls into next day).
    expect(parseDayPage(page('25:00 - 26:00')).slots[0].startMin).toBe(1500);
  });

  it('parseDayPage tolerates columns missing a title or time', () => {
    const parsed = parseDayPage(
      '<div class="flow-module-row">' +
        '<div class="flow-module-col" data-type="dizi"><span class="column-time">10:00 - 11:00</span></div>' +
        '<div class="flow-module-col"><h2 class="column-title">No Time</h2></div>' +
        '<div class="flow-module-col" data-type="film"><h2 class="column-title">Real</h2><span class="column-time">11:00 - 12:00</span></div>' +
        '</div>'
    );
    expect(parsed.slots).toHaveLength(1);
    expect(parsed.slots[0].title).toBe('Real');
  });

  it('parseChannelPage degrades non-string pages to []', () => {
    for (const html of [null, undefined, 42, {}, [], '']) {
      expect(parseChannelPage(html)).toEqual([]);
    }
  });

  it('parseChannelPage pairs positionally and ignores unbalanced extras', () => {
    // More times than names: the extra time is dropped.
    const moreTimes =
      '<li><strong class="program-time">10:00</strong><p class="program-name">A</p></li>' +
      '<li><strong class="program-time">11:00</strong><p class="program-name">B</p></li>' +
      '<li><strong class="program-time">12:00</strong></li>';
    expect(parseChannelPage(moreTimes).map((s) => s.title)).toEqual(['A', 'B']);
    // More names than times: the extra names are dropped.
    const moreNames =
      '<li><strong class="program-time">10:00</strong><p class="program-name">A</p></li>' +
      '<li><p class="program-name">No time</p></li>' +
      '<li><p class="program-name">Also no time</p></li>';
    expect(parseChannelPage(moreNames).map((s) => s.title)).toEqual(['A']);
  });

  it('parseChannelPage keeps 24:00 but drops out-of-clock times', () => {
    expect(parseChannelPage('<li><strong class="program-time">24:00</strong><p class="program-name">Gece</p></li>')).toEqual([
      { title: 'Gece', startMin: 1440 },
    ]);
    // 99:99 / 25:00 / 10:99 would stamp programmes days into the future.
    for (const time of ['99:99', '25:00', '10:99']) {
      expect(parseChannelPage(`<li><strong class="program-time">${time}</strong><p class="program-name">X</p></li>`)).toEqual([]);
    }
    // No colon at all: not a time, dropped.
    expect(parseChannelPage('<li><strong class="program-time">20</strong><p class="program-name">X</p></li>')).toEqual([]);
  });

  it('parseMainPage degrades non-string pages to []', () => {
    for (const html of [null, undefined, 42, {}, [], '']) {
      expect(parseMainPage(html)).toEqual([]);
    }
  });

  it('parseMainPage ignores hostile or malformed channel cards', () => {
    const html =
      '<a href="/tv-rehberi/Upper-Case-yayin-akisi-bugun"><img alt="Upper"></a>' + // uppercase slug not matched
      '<a href="/tv-rehberi/ok-yayin-akisi-bugun"><img src="no-alt"></a>' + // no alt -> no name
      '<a href="/tv-rehberi/evil%22%3E-yayin-akisi-bugun"><img alt="X&quot;&gt;"><script>alert(1)</script></a>' +
      '<a href="/tv-rehberi/good-yayin-akisi-bugun" data-x="1"><img alt="Good Channel"></a>';
    const channels = parseMainPage(html);
    expect(channels.some((c) => c.name.includes('&'))).toBe(false);
    expect(channels.find((c) => c.name === 'Good Channel')).toBeDefined();
    // The injection card ('evil%22%3E...') produces no channel at all.
    expect(channels.some((c) => c.name.includes('&quot;') || c.name.includes('>'))) .toBe(false);
    expect(channels.every((c) => /^[a-z0-9-]+$/i.test(c.slug))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mergeResults / compare — hostile result objects
// ---------------------------------------------------------------------------

describe('adversarial: mergeResults and compare', () => {
  it('mergeResults skips null/undefined provider results', () => {
    expect(mergeResults([null, undefined, { channels: [], programmes: [] }])).toEqual({
      channels: [],
      programmes: [],
      duplicates: 0,
    });
  });

  it('mergeResults tolerates null channel entries and missing arrays', () => {
    const merged = mergeResults([
      { channels: [null, { id: 'A.tr', name: 'A' }], programmes: undefined },
      { channels: undefined, programmes: [{ channel: 'A.tr', start: 's', stop: 't' }] }, // no title
    ]);
    expect(merged.channels).toEqual([{ id: 'A.tr', name: 'A' }]);
    expect(merged.programmes).toHaveLength(1); // kept, not crashed on
  });

  it('compareResults tolerates a completely absent side', () => {
    const report = compareResults({ http: undefined, browser: { channels: [], programmes: [] } });
    expect(report.channels.http).toBe(0);
    expect(report.programmes.browser).toBe(0);
  });

  it('compareProviderResults tolerates null sides and missing arrays', () => {
    const report = compareProviderResults({ a: null, b: { channels: undefined, programmes: undefined } });
    expect(report.summary.channelsA).toBe(0);
    expect(report.summary.channelsB).toBe(0);
    expect(report.channels).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scrape — hostile remote responses (stubbed fetch, no network)
// ---------------------------------------------------------------------------

describe('adversarial: scrape against hostile responses', () => {
  const response = (html) => ({ ok: true, status: 200, text: async () => html });

  it('hurriyet scrape survives non-HTML / null bodies page by page', async () => {
    for (const body of [null, undefined, 42, '<html></html>', 'garbage']) {
      const { scrape } = await import('../src/providers/hurriyet.js');
      const result = await scrape({
        dates: ['2026-09-07'],
        fetchImpl: async () => response(body),
        log: () => {},
        politenessDelayMs: 0,
      });
      expect(Array.isArray(result.channels)).toBe(true);
      expect(Array.isArray(result.programmes)).toBe(true);
      expect(result.failures).toBe(0);
    }
  });

  it('hurriyet scrape warns and skips slots whose row has no rail channel', async () => {
    const { scrape } = await import('../src/providers/hurriyet.js');
    const page =
      '<li class="flow-module-channel"><img alt="KANAL D"></li>' +
      '<div class="flow-module-row"><div class="flow-module-col" data-type="dizi">' +
      '<h2 class="column-title">Good</h2><span class="column-time">10:00 - 11:00</span></div></div>' +
      '<div class="flow-module-row"><div class="flow-module-col"><h2 class="column-title">Orphan</h2>' +
      '<span class="column-time">11:00 - 12:00</span></div></div>';
    const logs = [];
    const result = await scrape({
      dates: ['2026-09-07'],
      fetchImpl: async () => response(page),
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
    });
    expect(result.channels).toHaveLength(1);
    // The week is clamped to 7 day pages, so the one valid slot repeats 7x
    // (different wall dates); the orphan row is skipped on every day.
    expect(result.programmes.map((p) => p.title)).toEqual(Array(7).fill('Good'));
    expect(new Set(result.programmes.map((p) => p.start)).size).toBe(7);
    expect(logs.some((l) => l.includes('skipped'))).toBe(true);
  });

  it('mynet scrape survives a main page with zero discoverable channels', async () => {
    const { scrape } = await import('../src/providers/mynet.js');
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => response('<html>no channel cards here</html>'),
      log: () => {},
      politenessDelayMs: 0,
    });
    expect(result.channels).toEqual([]);
    expect(result.programmes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchText — hostile transports
// ---------------------------------------------------------------------------

describe('adversarial: fetchText', () => {
  it('throws a clear error when fetchImpl returns a bare string, not a Response', async () => {
    await expect(
      fetchText('https://x/', { fetchImpl: async () => 'raw html', retries: 0 })
    ).rejects.toThrow(/HTTP undefined/);
  });

  it('retries a throwing transport exactly retries+1 times', async () => {
    let calls = 0;
    await expect(
      fetchText('https://x/', {
        fetchImpl: async () => {
          calls++;
          throw new Error('boom');
        },
        retries: 2,
        retryDelayMs: 0,
      })
    ).rejects.toThrow('boom');
    expect(calls).toBe(3);
  });

  it('rejects non-2xx responses with the status code', async () => {
    await expect(
      fetchText('https://x/', {
        fetchImpl: async () => ({ ok: false, status: 429, text: async () => '' }),
        retries: 0,
      })
    ).rejects.toThrow(/HTTP 429/);
  });

  it('propagates a response.text() failure', async () => {
    await expect(
      fetchText('https://x/', {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => { throw new Error('decode fail'); } }),
        retries: 0,
      })
    ).rejects.toThrow('decode fail');
  });

  it('aborts hung requests via the timeout', async () => {
    const started = Date.now();
    await expect(
      fetchText('https://x/', {
        fetchImpl: (url, opts) =>
          new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(new Error('aborted')))),
        retries: 0,
        timeoutMs: 30,
      })
    ).rejects.toThrow('aborted');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// CLI — adversarial flags
// ---------------------------------------------------------------------------

describe('adversarial: CLI flags', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-scraper-adversarial-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  const run = async (argv) => {
    const stderr = [];
    const exit = await runCli({
      argv,
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });
    return { exit, text: stderr.join('') };
  };

  it('rejects impossible --date values before any network I/O', async () => {
    for (const date of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-09-00', '2025-02-29']) {
      const { exit, text } = await run(['--date', date]);
      expect(exit).toBe(1);
      expect(text).toMatch(/not a valid date/);
    }
  });

  it('rejects malformed --max-channels', async () => {
    for (const n of ['0', 'abc', '1.5']) {
      const { exit, text } = await run(['--max-channels', n]);
      expect(exit).toBe(1);
      expect(text).toMatch(/--max-channels expects a positive integer/);
    }
    // Negative numbers need the = form (a bare '-1' token is ambiguous).
    const neg = await run(['--max-channels=-1']);
    expect(neg.exit).toBe(1);
    expect(neg.text).toMatch(/--max-channels expects a positive integer/);
  });

  it('rejects malformed --delay-ms', async () => {
    for (const n of ['abc', '1.5']) {
      const { exit, text } = await run(['--delay-ms', n]);
      expect(exit).toBe(1);
      expect(text).toMatch(/--delay-ms expects a non-negative integer/);
    }
    // Negative numbers need the = form (a bare '-1' token is ambiguous).
    const neg = await run(['--delay-ms=-1']);
    expect(neg.exit).toBe(1);
    expect(neg.text).toMatch(/--delay-ms expects a non-negative integer/);
  });

  it('forwards --delay-ms to the provider as politenessDelayMs', async () => {
    let seen;
    registerProvider({
      id: 'delay-probe',
      name: 'Delay Probe',
      baseUrl: 'https://example.invalid',
      scrape: async (opts) => {
        seen = opts.politenessDelayMs;
        return {
          channels: [{ id: 'ATV.tr', name: 'ATV' }],
          programmes: [
            {
              channel: 'ATV.tr',
              start: '2026-09-08T06:00:00+03:00',
              stop: '2026-09-08T07:00:00+03:00',
              title: 'Probe Show',
            },
          ],
          days: 1,
          failures: 0,
        };
      },
    });
    const runProbe = async (argv) =>
      runCli({
        argv: ['--provider', 'delay-probe', '--no-gzip', '--out', path.join(tmpDir, 'probe.xml'), ...argv],
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        cwd: tmpDir,
      });

    expect(await runProbe(['--delay-ms', '750'])).toBe(0);
    expect(seen).toBe(750);

    // Without the flag the provider default applies (nothing forwarded).
    expect(await runProbe([])).toBe(0);
    expect(seen).toBeUndefined();
  });

  it('rejects negative or non-numeric day windows', async () => {
    const neg = await run(['--days-forward=-1']);
    expect(neg.exit).toBe(1);
    expect(neg.text).toMatch(/non-negative integers/);
    const bad = await run(['--days-back', 'abc']);
    expect(bad.exit).toBe(1);
    expect(bad.text).toMatch(/non-negative integers/);
  });

  it('rejects an empty provider list', async () => {
    for (const provider of [',', ' , ', '']) {
      const { exit, text } = await run(['--provider', provider]);
      expect(exit).toBe(1);
      expect(text).toMatch(/--provider expects at least one provider id/);
    }
  });

  it('returns exit 1 with a clean message for unknown or malformed flags', async () => {
    const unknown = await run(['--bogus']);
    expect(unknown.exit).toBe(1);
    expect(unknown.text).toMatch(/Unknown option/);
    const boolWithArg = await run(['--gzip=maybe']);
    expect(boolWithArg.exit).toBe(1);
    expect(boolWithArg.text).toMatch(/does not take an argument/);
    const missingValue = await run(['--out']);
    expect(missingValue.exit).toBe(1);
    expect(missingValue.text).toMatch(/argument missing/);
  });

  it('still accepts a valid leap-day --date', async () => {
    const { exit } = await run(['--date', '2028-02-29', '--list-providers']);
    expect(exit).toBe(0);
  });
});