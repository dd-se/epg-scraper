// Adversarial tests: hostile, malformed and boundary inputs that a scraper
// fed from the open web can legitimately encounter.  The contract under test
// (see AGENTS.md): malformed remote data degrades to an empty/warned result —
// never a crash — and the emitted XMLTV stays well-formed and matches the
// epgshare01 reference shape even when scraped content tries to break out of
// the markup.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodeEntities } from '../src/entities.js';
import { channelIdFromName } from '../src/slug.js';
import { toXmltvTimestamp, generateXmltv } from '../src/xmltv.js';
import { fetchText } from '../src/http.js';
import { parseDayPage, wallToIso } from '../src/providers/hurriyet.js';
import { parseMainPage, parseChannelPage } from '../src/providers/mynet.js';
import {
  parseDayPage as parseBeinDayPage,
  parseChannelList as parseBeinChannelList,
} from '../src/providers/beinsports.js';
import {
  parseDayPage as parseDbDayPage,
  parseServedDate,
} from '../src/providers/digiturkburada.js';
import {
  extractInitialState,
  parseChannelPage as parseSkChannelPage,
} from '../src/providers/sporekrani.js';
import {
  parseChannelPage as parseTvChannelPage,
  parsePrevueResponse,
} from '../src/providers/tivibu.js';
import {
  parsePlatformInfo,
  parseApiInstant,
  parsePlaybill,
  extractSessionCookie,
} from '../src/providers/tvplus.js';
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
// wallToIso — the shared wall-clock converter the providers feed
// ---------------------------------------------------------------------------

describe('adversarial: wallToIso', () => {
  it('rolls minutes >= 1440 into the next day instead of emitting 24:xx', () => {
    expect(wallToIso(2026, 9, 7, 1440)).toBe('2026-09-08T00:00:00+03:00');
    expect(wallToIso(2026, 9, 7, 1500)).toBe('2026-09-08T01:00:00+03:00');
    expect(wallToIso(2026, 12, 31, 1500)).toBe('2027-01-01T01:00:00+03:00'); // year rollover
  });

  it('rolls negative minutes back into the previous day', () => {
    expect(wallToIso(2026, 9, 7, -30)).toBe('2026-09-06T23:30:00+03:00');
    expect(wallToIso(2026, 1, 1, -1)).toBe('2025-12-31T23:59:00+03:00'); // year rollback
  });

  it('keeps the fixed +03:00 offset on every output', () => {
    expect(wallToIso(2026, 9, 7, 0)).toBe('2026-09-07T00:00:00+03:00');
    expect(wallToIso(2026, 1, 1, 1439)).toBe('2026-01-01T23:59:00+03:00');
  });
});

// ---------------------------------------------------------------------------
// generateXmltv — XML/attribute injection through scraped content
// ---------------------------------------------------------------------------

describe('adversarial: generateXmltv', () => {
  const channels = [{ id: 'X.tr', name: 'X' }];
  // Overriding `start` must also move `stop` (a zero-length slot is itself
  // corrupt); derive stop from the given start when one is supplied.
  const programme = (title, extra = {}) => {
    const merged = {
      channel: 'X.tr',
      start: '2026-09-07T00:00:00+03:00',
      stop: '2026-09-07T01:00:00+03:00',
      title,
      ...extra,
    };
    if (extra.start != null && extra.stop == null) {
      const hour = Number(String(extra.start).slice(11, 13));
      merged.stop = `2026-09-07T${String(hour + 1).padStart(2, '0')}:00:00+03:00`;
    }
    return merged;
  };

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
        programme('lone \uD800 surrogate', { start: '2026-09-07T01:00:00+03:00' }),
        programme('U+FFFE\uFFFEnonchar', { start: '2026-09-07T02:00:00+03:00' }),
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

  it('rejects zero-length programmes (stop == start)', () => {
    expect(() =>
      generateXmltv({ channels, programmes: [programme('x', { stop: '2026-09-07T00:00:00+03:00' })] })
    ).toThrow(/stop <= start/);
  });

  it('rejects reversed programmes (stop < start)', () => {
    // A negative duration is corrupt data — never emitted.
    expect(() =>
      generateXmltv({ channels, programmes: [programme('x', { stop: '2026-09-06T23:00:00+03:00' })] })
    ).toThrow(/stop <= start/);
    // Cross-midnight is fine as long as the stop follows the start.
    expect(() =>
      generateXmltv({
        channels,
        programmes: [programme('x', { start: '2026-09-07T23:30:00+03:00', stop: '2026-09-08T01:15:00+03:00' })],
      })
    ).not.toThrow();
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
// new provider parsers — beinsports, digiturkburada, sporekrani, tivibu, tvplus
// ---------------------------------------------------------------------------

describe('adversarial: beinsports parsers', () => {
  const nextData = (pageProps) =>
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps } })}</script>`;

  it('parseDayPage degrades on malformed or truncated __NEXT_DATA__ JSON', () => {
    expect(parseBeinDayPage('<script id="__NEXT_DATA__">{broken json}</script>')).toEqual({
      date: undefined,
      slots: [],
    });
    expect(parseBeinDayPage('<script id="__NEXT_DATA__" type="application/json">{"props":</script>')).toEqual({
      date: undefined,
      slots: [],
    });
    expect(parseBeinDayPage('<script>no matching id here</script>')).toEqual({ date: undefined, slots: [] });
    expect(parseBeinDayPage('<script id="__NEXT_DATA__">never closes')).toEqual({ date: undefined, slots: [] });
    expect(
      parseBeinDayPage(nextData({ data: { event_date: 'yesterday', listTvGuides: [] } })).date
    ).toBeUndefined();
  });

  it('parseDayPage drops out-of-clock times, missing names and hostile titles', () => {
    const page = nextData({
      data: {
        event_date: '2026-09-08',
        listTvGuides: [
          { name: 'Good', event_time: '10:30:00', channel_id: 1 },
          { name: '25 Oclock', event_time: '25:00:00', channel_id: 1 },
          { name: 'Bad Minutes', event_time: '10:99:00', channel_id: 1 },
          { name: '', event_time: '11:00:00', channel_id: 1 },
          { name: '&#x3C;script&#x3E;', event_time: '12:00:00', channel_id: 1 }, // decoded, writer escapes later
          { name: 'No time at all', channel_id: 1 },
          { name: 'Not an object', event_time: '13:00:00' }, // missing channel_id is fine, time+name keep it
        ],
      },
    });
    const { date, slots } = parseBeinDayPage(page);
    expect(date).toBe('2026-09-08');
    expect(slots.map((s) => s.title)).toEqual(['Good', '<script>', 'Not an object']);
    expect(slots.every((s) => s.startMin >= 0 && s.startMin <= 1440)).toBe(true);
  });

  it('parseChannelList skips entries missing rewriteId or channelId', () => {
    const page = nextData({
      activeLeagues: [
        { rewriteId: 'beinsports', channelId: 1 },
        { channelId: 2 }, // no rewriteId
        { rewriteId: 'no-id' }, // no channelId
        null,
        'x',
        { rewriteId: 'non-numeric', channelId: 'abc' }, // Number('abc') = NaN, still listed
      ],
    });
    expect(parseBeinChannelList(page)).toEqual([
      { rewriteId: 'beinsports', channelId: 1 },
      { rewriteId: 'non-numeric', channelId: NaN },
    ]);
  });
});

describe('adversarial: digiturkburada parsers', () => {
  const row = (title, time) =>
    `<tr><td style="padding:2px"><strong>${title}</strong></td><td style="padding:2px"><strong>${time}</strong></td></tr>`;

  it('parseServedDate rejects impossible or foreign dates', () => {
    for (const heading of [
      '32 Ocak 2026 - X', // day out of range
      '0 Ocak 2026 - X',
      '8 Fevral 2026 - X', // not a Turkish month
      '8 Ocak', // no year
      'Ocak 2026 8', // wrong order
      '8 Ocak 26', // short year
      '8 Ocak 2026xyz', // no word boundary after the year
    ]) {
      expect(parseServedDate(heading)).toBeUndefined();
    }
    expect(parseServedDate('08 Ocak 2026 - Pazar')).toBe('2026-01-08'); // leading zero ok
    expect(parseServedDate('8 Şubat 2026 - Pazar')).toBe('2026-02-08');
  });

  it('parseDayPage drops out-of-clock times and empty titles', () => {
    const { slots } = parseDbDayPage(
      `<h2>8 Eylül 2026 - Salı</h2><table>` +
        row('Good', '10:00') +
        row('25 Hours', '25:00') +
        row('Bad Minutes', '10:99') +
        row('', '12:00') +
        row('Late', '24:00') +
        '</table>'
    );
    expect(slots).toEqual([
      { startMin: 600, title: 'Good' },
      { startMin: 1440, title: 'Late' },
    ]);
  });

  it('parseDayPage ignores rows that do not match the exact cell markup', () => {
    const { slots } = parseDbDayPage(
      `<h2>8 Eylül 2026 - Salı</h2>` +
        row('Real', '10:00') +
        '<tr><td><strong>No padding style</strong></td><td><strong>11:00</strong></td></tr>' +
        '<tr><td style="padding:2px"><strong>No time cell</strong></td></tr>'
    );
    expect(slots).toEqual([{ startMin: 600, title: 'Real' }]);
  });

  it('parseDayPage still parses slots when the served-date heading is absent', () => {
    // No <h2> -> date undefined; the slot regex does not depend on the heading.
    expect(parseDbDayPage(row('X', '10:00'))).toEqual({
      date: undefined,
      slots: [{ startMin: 600, title: 'X' }],
    });
  });
});

describe('adversarial: sporekrani parsers', () => {
  it('extractInitialState survives braces and escaped quotes inside string values', () => {
    // The page source carries a single backslash before the quote (x \" y),
    // so the brace scan must not treat the escaped quote as a string end.
    const page =
      '<script>window.__INITIAL_STATE__={"common":{"events":[{' +
      '"name":"x \\" y { }","date_time":"2026-09-08 20:00:00"' +
      '}]}}</script>';
    const state = extractInitialState(page);
    expect(state.common.events[0].name).toBe('x " y { }');
  });

  it('extractInitialState degrades on truncated state and non-object states', () => {
    expect(extractInitialState('<script>window.__INITIAL_STATE__={"a":1</script>')).toBeUndefined();
    // The extractor is brace-based and object-only by design: array/null
    // assignments have no opening brace, so they degrade like missing markup.
    expect(extractInitialState('<script>window.__INITIAL_STATE__=[]</script>')).toBeUndefined();
    expect(extractInitialState('<script>window.__INITIAL_STATE__=null</script>')).toBeUndefined();
    // After the closing brace, trailing script content is ignored.
    expect(extractInitialState('<script>window.__INITIAL_STATE__={"a":1}var x = 2;</script>')).toEqual({
      a: 1,
    });
  });

  it('parseChannelPage drops hostile events and non-array channel lists', () => {
    const page =
      '<script>window.__INITIAL_STATE__=' +
      JSON.stringify({
        common: {
          events: [
            { name: 'Good', date_time: '2026-09-08 20:00:00', sport_name: 'Futbol', channels: [{ name: 'tabii Spor 1' }] },
            { name: '25 Oclock', date_time: '2026-09-08 25:00:00', sport_name: 'Futbol', channels: [{ name: 'tabii Spor 1' }] },
            { name: 'Bad Minutes', date_time: '2026-09-08 10:99:00', sport_name: 'Futbol', channels: [{ name: 'tabii Spor 1' }] },
            { name: 'No Time', date_time: '', sport_name: 'Futbol', channels: [{ name: 'tabii Spor 1' }] },
            { name: 'Other Channel', date_time: '2026-09-08 21:00:00', sport_name: 'Futbol', channels: [{ name: 'CBC Sport' }] },
            { name: 'Channels Not Array', date_time: '2026-09-08 22:00:00', sport_name: 'Futbol', channels: 'x' },
            { name: 'Raw &amp; <b>markup</b>', date_time: '2026-09-08 23:00:00', sport_name: 'Futbol', channels: [{ name: 'tabii Spor 1' }] },
            null,
          ],
        },
      }) +
      '</script>';
    // Titles pass through raw (no entity decoding here — the XMLTV writer
    // escapes whatever reaches it).  Events on other channels are excluded.
    expect(parseSkChannelPage(page, 'tabii Spor 1').events.map((e) => e.title)).toEqual([
      'Good',
      'Raw &amp; <b>markup</b>',
    ]);
  });
});

describe('adversarial: tivibu parsers', () => {
  it('parseChannelPage truncates hostile token values at the first quote', () => {
    expect(parseTvChannelPage('<input class="token" value="abc" onclick="evil()">')).toEqual({
      channelCode: undefined,
      token: 'abc',
    });
  });

  it('parseChannelPage requires a full 20-digit lowercase channel code', () => {
    expect(parseTvChannelPage('<a href="/rv?i=2|ch1234567890123456789">x</a>')).toEqual({
      channelCode: undefined,
      token: undefined,
    }); // 19 digits
    expect(parseTvChannelPage('<a href="/rv?i=2|CH00000000000000001356">x</a>')).toEqual({
      channelCode: undefined,
      token: undefined,
    }); // uppercase
  });

  it('parsePrevueResponse drops out-of-clock times and hostile items', () => {
    const { slots } = parsePrevueResponse({
      mobilPrevueViewModel: [
        { prevueName: 'Good', beginTime: '2026.09.08 10:00:00', endTime: '2026.09.08 11:00:00' },
        { prevueName: '25 Oclock', beginTime: '2026.09.08 25:00:00', endTime: '2026.09.08 26:00:00' },
        { prevueName: 'Bad Minutes', beginTime: '2026.09.08 10:99:00', endTime: '2026.09.08 11:00:00' },
        { prevueName: 'No Times', beginTime: undefined, endTime: undefined },
        { prevueName: '', beginTime: '2026.09.08 12:00:00', endTime: '2026.09.08 13:00:00' },
        null,
      ],
    });
    expect(slots.map((s) => s.title)).toEqual(['Good']);
  });

  it('parsePrevueResponse rejects impossible calendar dates that would roll forward', () => {
    // Month 13 / Feb 30 / day 32 would silently land in a different month
    // via wallToIso — drop the slot instead of stamping it a month off.
    const { slots } = parsePrevueResponse({
      mobilPrevueViewModel: [
        { prevueName: 'Good', beginTime: '2026.09.08 10:00:00', endTime: '2026.09.08 11:00:00' },
        { prevueName: 'Month 13', beginTime: '2026.13.09 10:00:00', endTime: '2026.13.09 11:00:00' },
        { prevueName: 'Feb 30', beginTime: '2026.02.30 10:00:00', endTime: '2026.02.30 11:00:00' },
        { prevueName: 'Apr 31', beginTime: '2026.04.31 10:00:00', endTime: '2026.04.31 11:00:00' },
        { prevueName: 'Day 32', beginTime: '2026.09.32 10:00:00', endTime: '2026.09.32 11:00:00' },
        { prevueName: 'Day 0', beginTime: '2026.09.00 10:00:00', endTime: '2026.09.00 11:00:00' },
      ],
    });
    expect(slots.map((s) => s.title)).toEqual(['Good']);
    // Legal leap-day instants still parse.
    const leap = parsePrevueResponse({
      mobilPrevueViewModel: [
        { prevueName: 'Leap', beginTime: '2028.02.29 23:30:00', endTime: '2028.03.01 00:30:00' },
      ],
    });
    expect(leap.slots[0].beginDate).toBe('2028-02-29');
  });

  it('parsePrevueResponse keeps a 24:00 begin that crosses midnight', () => {
    const { slots } = parsePrevueResponse({
      mobilPrevueViewModel: [
        { prevueName: 'Cross', beginTime: '2026.09.08 24:00:00', endTime: '2026.09.09 01:00:00' },
      ],
    });
    expect(slots[0]).toEqual({
      beginDate: '2026-09-08',
      beginMin: 1440,
      endDate: '2026-09-09',
      endMin: 60,
      title: 'Cross',
      category: undefined,
      desc: undefined,
    });
  });
});

describe('adversarial: tvplus parsers', () => {
  it('parsePlatformInfo rejects hostile JSON shapes', () => {
    for (const body of [
      '[]',
      'null',
      '42',
      '"https"',
      '{"https":""}',
      '{"https":123}',
      '{"https":null}',
      '{"other":1}',
      'not json',
      undefined,
    ]) {
      expect(parsePlatformInfo(body)).toBeUndefined();
    }
    expect(parsePlatformInfo('{"https":"https://x.tvplus.com.tr:33207"}')).toBe(
      'https://x.tvplus.com.tr:33207'
    );
  });

  it('parseApiInstant rejects hostile timestamps', () => {
    for (const value of [
      '2026-09-09', // no time
      '2026-09-09 25:00:00 UTC+03:00',
      '2026-09-09 10:99:00',
      '09.09.2026 10:00:00', // wrong date format
      '2026-13-09 10:00:00', // impossible month would roll a year forward via wallToIso
      '2026-02-30 10:00:00', // impossible day-in-month would roll into March
      '2026-09-00 10:00:00', // impossible day
      '2026-09-32 10:00:00',
      '2026-09-09T10:00:00Z', // ISO with T is not the API format
      42,
      null,
      undefined,
      '',
    ]) {
      expect(parseApiInstant(value)).toBeNull();
    }
    // 24:00 is a legal end-of-day wall instant.
    expect(parseApiInstant('2026-09-09 24:00:00 UTC+03:00')).toEqual({
      year: 2026,
      month: 9,
      day: 9,
      minutes: 1440,
    });
  });

  it('parsePlaybill drops reversed and zero-length slots instead of emitting garbage', () => {
    const slots = parsePlaybill(
      JSON.stringify({
        playbilllist: [
          {
            name: 'Good',
            starttime: '2026-09-09 10:00:00 UTC+03:00',
            endtime: '2026-09-09 11:00:00 UTC+03:00',
          },
          {
            name: 'Reversed',
            starttime: '2026-09-09 11:00:00 UTC+03:00',
            endtime: '2026-09-09 10:00:00 UTC+03:00',
          },
          {
            name: 'Zero length',
            starttime: '2026-09-09 10:00:00 UTC+03:00',
            endtime: '2026-09-09 10:00:00 UTC+03:00',
          },
          { name: 'Gap filler', starttime: null, endtime: null },
          {
            name: 'Array genre',
            starttime: '2026-09-09 12:00:00 UTC+03:00',
            endtime: '2026-09-09 13:00:00 UTC+03:00',
            genres: ['Spor', 'Canlı'],
          },
        ],
      })
    );
    expect(slots.map((s) => s.title)).toEqual(['Good', 'Array genre']);
    expect(slots.every((s) => s.stop > s.start)).toBe(true);
    expect(slots.find((s) => s.title === 'Array genre').category).toBeUndefined();
  });

  it('parsePlaybill degrades on non-object bodies and hostile items', () => {
    for (const body of ['[]', 'null', '42', '"x"', 'garbage', undefined, '{"playbilllist":"x"}', '{}']) {
      expect(parsePlaybill(body)).toEqual([]);
    }
    const slots = parsePlaybill(
      JSON.stringify({ playbilllist: [null, 'x', { name: '' }, { name: 'No times' }, { name: 42 }] })
    );
    expect(slots).toEqual([]);
  });

  it('extractSessionCookie tolerates hostile set-cookie values', () => {
    expect(extractSessionCookie({ headers: { getSetCookie: () => [] } })).toBeUndefined();
    expect(extractSessionCookie({ headers: { getSetCookie: () => [';', '   '] } })).toBeUndefined();
    expect(extractSessionCookie({ headers: { get: () => '' } })).toBeUndefined();
    expect(extractSessionCookie({ headers: {} })).toBeUndefined();
    expect(extractSessionCookie(null)).toBeUndefined();
    expect(extractSessionCookie(undefined)).toBeUndefined();
    // A plain (undici-style fallback) set-cookie header still works.
    expect(extractSessionCookie({ headers: { get: () => 'JSESSIONID=a; Path=/' } })).toBe('JSESSIONID=a');
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

  it('mergeResults skips null programme entries instead of crashing', () => {
    const merged = mergeResults([
      {
        channels: [{ id: 'A.tr', name: 'A' }],
        programmes: [null, undefined, { channel: 'A.tr', start: 's', stop: 't', title: 'T' }],
      },
    ]);
    expect(merged.programmes).toHaveLength(1);
    expect(merged.programmes[0].title).toBe('T');
  });

  it('mergeResults tolerates non-array channels/programmes via || []', () => {
    // A hostile result with string fields would otherwise be iterated char
    // by char — the guard keeps the merge to real arrays.
    expect(mergeResults([{ channels: null, programmes: null }])).toEqual({
      channels: [],
      programmes: [],
      duplicates: 0,
    });
    expect(mergeResults([{ channels: 'x', programmes: 42 }]).programmes).toEqual([]);
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

  it('compareProviderResults tolerates null programme entries on a live side', () => {
    const report = compareProviderResults({
      a: {
        channels: [{ id: 'A.tr', name: 'A' }],
        programmes: [null, { channel: 'A.tr', start: 's', stop: 't', title: 'X' }],
      },
      b: { channels: [{ id: 'A.tr', name: 'A' }], programmes: [] },
    });
    expect(report.summary.programmesA).toBe(1); // the null entry is filtered out
    expect(report.summary.onlyA).toHaveLength(1);
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

  it('beinsports scrape skips duplicated-time slots instead of emitting zero-length programmes', async () => {
    const { scrape } = await import('../src/providers/beinsports.js');
    const page =
      '<script id="__NEXT_DATA__" type="application/json">' +
      JSON.stringify({
        props: {
          pageProps: {
            data: {
              event_date: '2026-09-08',
              listTvGuides: [
                { name: 'A', event_time: '10:00:00', channel_id: 1 },
                { name: 'B', event_time: '10:00:00', channel_id: 1 },
                { name: 'C', event_time: '12:00:00', channel_id: 1 },
              ],
            },
          },
        },
      }) +
      '</script>';
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => response(page),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    // The channel list is static (beinsports scrape takes no maxChannels),
    // so every channel-day gets the page: 4 channels x 7 week days.  On
    // each page slot A's stop equals duplicated B's 10:00 start, so A is
    // dropped; B(10:00-12:00) and C(12:00-24:00) survive.
    expect(result.programmes).toHaveLength(56);
    expect(result.programmes.every((p) => p.stop > p.start)).toBe(true);
    expect(result.programmes.filter((p) => p.title === 'A')).toHaveLength(0);
  });

  it('beinsports scrape survives truncated pages on every request', async () => {
    const { scrape } = await import('../src/providers/beinsports.js');
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => response('<script id="__NEXT_DATA__">{"props":</script>'),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 2,
    });
    expect(result.channels).toHaveLength(4); // static channel list survives
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(0);
  });

  it('digiturkburada scrape skips zero-length duplicated-time rows', async () => {
    const { scrape } = await import('../src/providers/digiturkburada.js');
    const page =
      '<h2>8 Eylül 2026 - Salı</h2><table>' +
      '<tr><td style="padding:2px"><strong>A</strong></td><td style="padding:2px"><strong>10:00</strong></td></tr>' +
      '<tr><td style="padding:2px"><strong>B</strong></td><td style="padding:2px"><strong>10:00</strong></td></tr>' +
      '<tr><td style="padding:2px"><strong>C</strong></td><td style="padding:2px"><strong>12:00</strong></td></tr>' +
      '</table>';
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => response(page),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.programmes.map((p) => p.title)).toEqual(['B', 'C']);
    expect(result.programmes.every((p) => p.stop > p.start)).toBe(true);
  });

  it('digiturkburada scrape stamps slots when the page omits the served-date heading', async () => {
    const { scrape } = await import('../src/providers/digiturkburada.js');
    // No <h2> means servedDate is undefined; the scrape cannot verify the
    // date, so it proceeds rather than silently dropping the slots.
    const page =
      '<table><tr><td style="padding:2px"><strong>Only</strong></td><td style="padding:2px"><strong>10:00</strong></td></tr></table>';
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => response(page),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.programmes).toHaveLength(1);
    expect(result.programmes[0].start).toBe('2026-09-08T10:00:00+03:00');
  });

  it('sporekrani scrape skips duplicate-start events and sorts unsorted pages', async () => {
    const { scrape } = await import('../src/providers/sporekrani.js');
    const page =
      '<script>window.__INITIAL_STATE__=' +
      JSON.stringify({
        common: {
          events: [
            { name: 'Z Late', date_time: '2026-09-08 22:00:00', sport_name: 'Futbol', channels: [{ name: 'tabii Spor 1' }] },
            { name: 'A First', date_time: '2026-09-08 20:00:00', sport_name: 'Futbol', channels: [{ name: 'tabii Spor 1' }] },
            { name: 'B Duplicate', date_time: '2026-09-08 20:00:00', sport_name: 'Futbol', channels: [{ name: 'tabii Spor 1' }] },
          ],
        },
      }) +
      '</script>';
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: async () => response(page),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    // The page is unsorted; scrape sorts to A(20:00), B(20:00), Z(22:00).
    // A's stop equals B's 20:00 start -> dropped; B(20:00-22:00) and
    // Z(22:00-24:00) survive.
    expect(result.programmes.map((p) => p.title)).toEqual(['B Duplicate', 'Z Late']);
    expect(result.programmes.every((p) => p.stop > p.start)).toBe(true);
  });

  it('tivibu scrape drops slots the API returns for the wrong day', async () => {
    const { scrape } = await import('../src/providers/tivibu.js');
    const json = {
      mobilPrevueViewModel: [
        { prevueName: 'Wrong Day', beginTime: '2026.09.10 10:00:00', endTime: '2026.09.10 11:00:00', genre: 'Spor' },
      ],
    };
    const fetchImpl = async (url, options) => {
      if (options?.method === 'POST') return response(JSON.stringify(json));
      return response('<input class="token" value="tok"><a href="/rv?i=2|ch00000000000000001356">x</a>');
    };
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl,
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(0);
  });

  it('tvplus scrape degrades when platform discovery returns garbage', async () => {
    const { scrape } = await import('../src/providers/tvplus.js');
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl: async () => response('<!doctype html><html>waf page</html>'),
      log: () => {},
      politenessDelayMs: 0,
    });
    expect(result.channels).toEqual([]);
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(1);
  });

  it('tvplus scrape treats a garbage PlayBillList as an empty guide', async () => {
    const { scrape } = await import('../src/providers/tvplus.js');
    const fetchImpl = async (url) => {
      if (url.includes('/get-platform-info')) return response('{"https":"https://api.tvplus.com.tr:33207"}');
      if (url.endsWith('/EPG/JSON/Authenticate')) return response('{}');
      return response('not json at all');
    };
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl,
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 2,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(0); // parsePlaybill degrades, not a transport failure
    expect(result.channels).toHaveLength(2);
  });

  it('tvplus scrape never emits reversed or zero-length slots', async () => {
    const { scrape } = await import('../src/providers/tvplus.js');
    const playbill = JSON.stringify({
      playbilllist: [
        { name: 'Reversed', starttime: '2026-09-09 11:00:00 UTC+03:00', endtime: '2026-09-09 10:00:00 UTC+03:00' },
        { name: 'Zero length', starttime: '2026-09-09 10:00:00 UTC+03:00', endtime: '2026-09-09 10:00:00 UTC+03:00' },
        { name: 'Good', starttime: '2026-09-09 12:00:00 UTC+03:00', endtime: '2026-09-09 13:00:00 UTC+03:00' },
      ],
    });
    const fetchImpl = async (url) => {
      if (url.includes('/get-platform-info')) return response('{"https":"https://api.tvplus.com.tr:33207"}');
      if (url.endsWith('/EPG/JSON/Authenticate')) return response('{}');
      return response(playbill);
    };
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl,
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.programmes.map((p) => p.title)).toEqual(['Good']);
    expect(result.programmes.every((p) => p.stop > p.start)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createCanonicalizer — alias chains and cycles must converge, never loop
// ---------------------------------------------------------------------------

describe('adversarial: createCanonicalizer', () => {
  it('resolves single-level aliases like before', async () => {
    const { createCanonicalizer } = await import('../src/aliases.js');
    const canon = createCanonicalizer({ 'AHABER.tr': 'A.HABER.tr' });
    expect(canon('AHABER.tr')).toBe('A.HABER.tr');
    expect(canon('A.HABER.tr')).toBe('A.HABER.tr');
    expect(canon('NTV.tr')).toBe('NTV.tr');
  });

  it('collapses alias chains onto one canonical id', async () => {
    const { createCanonicalizer } = await import('../src/aliases.js');
    const canon = createCanonicalizer({
      'AHABER.tr': 'A.HABER.tr',
      'A.HABER.tr': 'A.HABER.ALT.tr',
    });
    expect(canon('AHABER.tr')).toBe('A.HABER.ALT.tr');
    expect(canon('A.HABER.tr')).toBe('A.HABER.ALT.tr');
  });

  it('terminates on alias cycles instead of looping forever', async () => {
    const { createCanonicalizer } = await import('../src/aliases.js');
    const canon = createCanonicalizer({ 'A.tr': 'B.tr', 'B.tr': 'A.tr' });
    // Must return promptly — the visited set breaks the cycle.
    expect(canon('A.tr')).toBe('A.tr');
    expect(canon('B.tr')).toBe('B.tr');
    const self = createCanonicalizer({ 'A.tr': 'A.tr' });
    expect(self('A.tr')).toBe('A.tr');
  });

  it('keeps an empty alias map as identity', async () => {
    const { createCanonicalizer } = await import('../src/aliases.js');
    const canon = createCanonicalizer({});
    expect(canon('ANY.tr')).toBe('ANY.tr');
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

  it('rejects malformed --retries, --timeout-ms and --retry-delay-ms', async () => {
    for (const bad of [
      ['--retries', 'abc'],
      ['--retries=1.5'],
      ['--retries=-1'],
      ['--timeout-ms', 'abc'],
      ['--timeout-ms=0'],
      ['--timeout-ms=-100'],
      ['--retry-delay-ms', 'abc'],
      ['--retry-delay-ms=2.5'],
      ['--retry-delay-ms=-1'],
    ]) {
      const { exit, text } = await run(bad);
      expect(exit, bad.join(' ')).toBe(1);
      expect(text, bad.join(' ')).toMatch(
        /--(retries|timeout-ms|retry-delay-ms) expects/
      );
    }
  });

  it('forwards --retries/--timeout-ms/--retry-delay-ms as fetchOptions', async () => {
    let seen;
    registerProvider({
      id: 'transport-probe',
      name: 'Transport Probe',
      baseUrl: 'https://example.invalid',
      scrape: async (opts) => {
        seen = opts.fetchOptions;
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
        argv: ['--provider', 'transport-probe', '--no-gzip', '--out', path.join(tmpDir, 'transport-probe.xml'), ...argv],
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        cwd: tmpDir,
      });

    expect(await runProbe(['--retries', '5', '--timeout-ms', '8000', '--retry-delay-ms', '100'])).toBe(0);
    expect(seen).toEqual({ retries: 5, timeoutMs: 8000, retryDelayMs: 100 });

    // Partial flags forward only what was passed.
    expect(await runProbe(['--retries', '0'])).toBe(0);
    expect(seen).toEqual({ retries: 0 });

    // Without flags nothing is forwarded — provider/transport defaults hold.
    expect(await runProbe([])).toBe(0);
    expect(seen).toEqual({});
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

  it('resolves a relative --out inside the injected cwd (single mode)', async () => {
    registerProvider({
      id: 'adv-out-single',
      name: 'Out Single',
      baseUrl: 'https://example.invalid',
      scrape: async () => ({
        channels: [{ id: 'ATV.tr', name: 'ATV' }],
        programmes: [
          {
            channel: 'ATV.tr',
            start: '2026-09-08T06:00:00+03:00',
            stop: '2026-09-08T07:00:00+03:00',
            title: 'Show',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    const stdout = [];
    // A relative path with a subdirectory proves the resolution: the file can
    // only be written under the injected cwd (tmpDir), never process.cwd().
    mkdirSync(path.join(tmpDir, 'rel'), { recursive: true });
    const exit = await runCli({
      argv: ['--provider', 'adv-out-single', '--no-gzip', '--out', 'rel/out.xml'],
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stdout.push(s) },
      cwd: tmpDir,
    });
    expect(exit).toBe(0);
    // The relative path must land under the injected cwd, not process.cwd().
    expect(existsSync(path.join(tmpDir, 'rel/out.xml'))).toBe(true);
    const output = stdout.join('');
    expect(output).toContain('written:');
    expect(output).toContain(path.join(tmpDir, 'rel/out.xml'));
  });

  it('resolves a relative --out inside the injected cwd (merge mode)', async () => {
    const provider = (id, title) => ({
      id,
      name: `Out ${id}`,
      baseUrl: 'https://example.invalid',
      scrape: async () => ({
        channels: [{ id: 'ATV.tr', name: 'ATV' }],
        programmes: [
          {
            channel: 'ATV.tr',
            start: '2026-09-08T06:00:00+03:00',
            stop: '2026-09-08T07:00:00+03:00',
            title,
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    registerProvider(provider('adv-out-merge-a', 'From A'));
    registerProvider(provider('adv-out-merge-b', 'From B'));
    const stderr = [];
    mkdirSync(path.join(tmpDir, 'sub'), { recursive: true });
    const exit = await runCli({
      argv: [
        '--provider', 'adv-out-merge-a,adv-out-merge-b',
        '--merge',
        '--no-gzip',
        '--out',
        'sub/merged.xml',
        '--quiet',
      ],
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });
    expect(exit).toBe(0);
    expect(existsSync(path.join(tmpDir, 'sub/merged.xml'))).toBe(true);
  });

  it('fails cleanly when a merged programme references an undeclared channel', async () => {
    registerProvider({
      id: 'adv-ghost-a',
      name: 'Ghost A',
      baseUrl: 'https://example.invalid',
      scrape: async () => ({
        channels: [{ id: 'ATV.tr', name: 'ATV' }],
        programmes: [
          {
            channel: 'ATV.tr',
            start: '2026-09-08T06:00:00+03:00',
            stop: '2026-09-08T07:00:00+03:00',
            title: 'Real',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    registerProvider({
      id: 'adv-ghost-b',
      name: 'Ghost B',
      baseUrl: 'https://example.invalid',
      scrape: async () => ({
        channels: [],
        programmes: [
          {
            channel: 'GHOST.tr', // declared by no provider
            start: '2026-09-08T20:00:00+03:00',
            stop: '2026-09-08T21:00:00+03:00',
            title: 'Orphan',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    const stderr = [];
    const exit = await runCli({
      argv: [
        '--provider', 'adv-ghost-a,adv-ghost-b',
        '--merge',
        '--no-gzip',
        '--out',
        path.join(tmpDir, 'ghost.xml'),
      ],
      stdout: { write: () => {} },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });
    // Honest error: the merge keeps the orphan programme, the writer refuses
    // to emit it — exit 1 with a clear message, not a silent partial guide.
    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/unknown channel "GHOST.tr"/);
    expect(existsSync(path.join(tmpDir, 'ghost.xml'))).toBe(false);
  });

  it('applies an alias chain so merged programmes land on one canonical channel', async () => {
    const aliasPath = path.join(tmpDir, 'chain-aliases.json');
    writeFileSync(aliasPath, JSON.stringify({ 'AHABER.tr': 'A.HABER.tr', 'A.HABER.tr': 'A.HABER.ALT.tr' }));
    registerProvider({
      id: 'adv-chain-a',
      name: 'Chain A',
      baseUrl: 'https://example.invalid',
      scrape: async () => ({
        channels: [{ id: 'A.HABER.tr', name: 'A Haber' }],
        programmes: [
          {
            channel: 'A.HABER.tr',
            start: '2026-09-08T15:00:00+03:00',
            stop: '2026-09-08T16:00:00+03:00',
            title: 'From A',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    registerProvider({
      id: 'adv-chain-b',
      name: 'Chain B',
      baseUrl: 'https://example.invalid',
      scrape: async () => ({
        channels: [{ id: 'AHABER.tr', name: 'A Haber' }],
        programmes: [
          {
            channel: 'AHABER.tr',
            start: '2026-09-08T20:00:00+03:00',
            stop: '2026-09-08T21:00:00+03:00',
            title: 'From B',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    const stdout = [];
    const stderr = [];
    const out = path.join(tmpDir, 'chain.xml');
    const exit = await runCli({
      argv: [
        '--provider', 'adv-chain-a,adv-chain-b',
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
    const { readFileSync } = await import('node:fs');
    const xml = readFileSync(out, 'utf8');
    // Both providers' ids resolve through the chain onto the final canonical
    // id — one channel, both programmes referencing it.
    expect(xml.match(/<channel id="A\.HABER\.ALT\.tr">/g)).toHaveLength(1);
    expect(xml.match(/channel="A\.HABER\.ALT\.tr"/g)).toHaveLength(2);
    expect(xml).not.toContain('AHABER.tr');
  });

  it('fails cleanly when --alias-map points at a missing or malformed file', async () => {
    // A non-existent provider id is fine: the alias-map is validated before
    // providers are resolved, so the run must fail on the map, not the id.
    const runAlias = (argv) => run(['--provider', 'no-such-provider', ...argv]);

    const missing = await runAlias(['--alias-map', path.join(tmpDir, 'no-such.json')]);
    expect(missing.exit).toBe(1);
    expect(missing.text).toMatch(/failed to read alias map/);

    const bad = path.join(tmpDir, 'bad.json');
    writeFileSync(bad, '{ not json');
    const malformed = await runAlias(['--alias-map', bad]);
    expect(malformed.exit).toBe(1);
    expect(malformed.text).toMatch(/not valid JSON/);

    const arr = path.join(tmpDir, 'arr.json');
    writeFileSync(arr, '["AHABER.tr"]');
    const notObject = await runAlias(['--alias-map', arr]);
    expect(notObject.exit).toBe(1);
    expect(notObject.text).toMatch(/must be a JSON object/);
  });
});

// ---------------------------------------------------------------------------
// merge/compare pipelines — hostile provider results end-to-end through runCli
// ---------------------------------------------------------------------------

describe('adversarial: merge and compare pipelines through runCli', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-scraper-adv-pipe-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  const run = async (argv) => {
    const stdout = [];
    const stderr = [];
    const exit = await runCli({
      argv,
      stdout: { write: (s) => stdout.push(s) },
      stderr: { write: (s) => stderr.push(s) },
      cwd: tmpDir,
    });
    return { exit, stdout: stdout.join(''), stderr: stderr.join('') };
  };

  const goodProvider = (id, title = `From ${id}`) => ({
    id,
    name: `Adv Pipe ${id}`,
    baseUrl: 'https://example.invalid',
    scrape: async () => ({
      channels: [{ id: 'ATV.tr', name: 'ATV' }],
      programmes: [
        { channel: 'ATV.tr', start: '2026-09-08T06:00:00+03:00', stop: '2026-09-08T07:00:00+03:00', title },
      ],
      days: 1,
      failures: 0,
    }),
  });

  it('merge: a provider that throws fails the run cleanly without writing a file', async () => {
    registerProvider({
      id: 'adv-pipe-mrg-throw',
      name: 'Adv Pipe Merge Throw',
      baseUrl: 'https://example.invalid',
      scrape: async () => {
        throw new Error('scrape exploded');
      },
    });
    const out = path.join(tmpDir, 'throw.xml');
    const { exit, stderr } = await run([
      '--provider', 'adv-pipe-mrg-throw', '--merge', '--no-gzip', '--out', out,
    ]);
    expect(exit).toBe(1);
    expect(stderr).toMatch(/scrape exploded/);
    expect(existsSync(out)).toBe(false);
  });

  it('merge: corrupt programme timestamps fail with an honest error, never a partial guide', async () => {
    registerProvider(goodProvider('adv-pipe-mrg-good'));
    registerProvider({
      id: 'adv-pipe-mrg-corrupt',
      name: 'Adv Pipe Merge Corrupt',
      baseUrl: 'https://example.invalid',
      scrape: async () => ({
        channels: [{ id: 'NTV.tr', name: 'NTV' }],
        programmes: [
          {
            channel: 'NTV.tr',
            start: '2026-09-08T11:00:00+03:00',
            stop: '2026-09-08T10:00:00+03:00', // reversed — corrupt remote data
            title: 'Corrupt',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    const out = path.join(tmpDir, 'corrupt.xml');
    const { exit, stderr } = await run([
      '--provider', 'adv-pipe-mrg-good,adv-pipe-mrg-corrupt', '--merge', '--no-gzip', '--out', out,
    ]);
    // The corrupt slot survives the merge (merging does not validate
    // timestamps), so the writer refuses to emit it — exit 1 with a clear
    // message, not a silently wrong guide.
    expect(exit).toBe(1);
    expect(stderr).toMatch(/stop <= start/);
    expect(existsSync(out)).toBe(false);
  });

  it('merge: null programme entries from a provider are skipped, the guide still writes', async () => {
    registerProvider(goodProvider('adv-pipe-mrg-null-a'));
    registerProvider({
      id: 'adv-pipe-mrg-null-b',
      name: 'Adv Pipe Merge Null B',
      baseUrl: 'https://example.invalid',
      scrape: async () => ({
        channels: [{ id: 'NTV.tr', name: 'NTV' }],
        programmes: [
          null, // hostile entry — must be skipped, never crash the merge
          {
            channel: 'NTV.tr',
            start: '2026-09-08T20:00:00+03:00',
            stop: '2026-09-08T21:00:00+03:00',
            title: 'From B',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    const out = path.join(tmpDir, 'nulls.xml');
    const { exit } = await run([
      '--provider', 'adv-pipe-mrg-null-a,adv-pipe-mrg-null-b', '--merge', '--no-gzip', '--out', out,
    ]);
    expect(exit).toBe(0);
    const { readFileSync } = await import('node:fs');
    const xml = readFileSync(out, 'utf8');
    expect(xml).toContain('<title lang="tr">From adv-pipe-mrg-null-a</title>');
    expect(xml).toContain('<title lang="tr">From B</title>');
    expect(xml).not.toContain('undefined');
  });

  it('compare: a provider that throws fails the run cleanly without writing files', async () => {
    registerProvider(goodProvider('adv-pipe-cmp-ok'));
    registerProvider({
      id: 'adv-pipe-cmp-throw',
      name: 'Adv Pipe Compare Throw',
      baseUrl: 'https://example.invalid',
      scrape: async () => {
        throw new Error('provider b exploded');
      },
    });
    const out = path.join(tmpDir, 'cmp.xml');
    const { exit, stderr } = await run([
      '--provider', 'adv-pipe-cmp-ok,adv-pipe-cmp-throw', '--compare', '--no-gzip', '--out', out,
    ]);
    expect(exit).toBe(1);
    expect(stderr).toMatch(/provider b exploded/);
    expect(existsSync(path.join(tmpDir, 'cmp.adv-pipe-cmp-ok.xml'))).toBe(false);
    expect(existsSync(path.join(tmpDir, 'cmp.adv-pipe-cmp-throw.xml'))).toBe(false);
  });

  it('compare: an empty side is skipped with a note, the other side still writes', async () => {
    registerProvider(goodProvider('adv-pipe-cmp-full'));
    registerProvider({
      id: 'adv-pipe-cmp-empty',
      name: 'Adv Pipe Compare Empty',
      baseUrl: 'https://example.invalid',
      scrape: async () => ({ channels: [], programmes: [], days: 1, failures: 0 }),
    });
    const out = path.join(tmpDir, 'half.xml');
    const { exit, stdout } = await run([
      '--provider', 'adv-pipe-cmp-full,adv-pipe-cmp-empty', '--compare', '--no-gzip', '--out', out,
    ]);
    expect(exit).toBe(0);
    expect(stdout).toContain('programmes: adv-pipe-cmp-full 1 | adv-pipe-cmp-empty 0');
    expect(stdout).toContain('note: adv-pipe-cmp-empty produced no data');
    expect(existsSync(path.join(tmpDir, 'half.adv-pipe-cmp-full.xml'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'half.adv-pipe-cmp-empty.xml'))).toBe(false);
  });

  it('compare: two empty providers exit 1 with a clear message and write nothing', async () => {
    const empty = (id) => ({
      id,
      name: `Adv Pipe ${id}`,
      baseUrl: 'https://example.invalid',
      scrape: async () => ({ channels: [], programmes: [], days: 1, failures: 0 }),
    });
    registerProvider(empty('adv-pipe-cmp-e1'));
    registerProvider(empty('adv-pipe-cmp-e2'));
    const out = path.join(tmpDir, 'none.xml');
    const { exit, stderr } = await run([
      '--provider', 'adv-pipe-cmp-e1,adv-pipe-cmp-e2', '--compare', '--no-gzip', '--out', out,
    ]);
    expect(exit).toBe(1);
    expect(stderr).toMatch(/nothing scraped in either provider/);
    expect(existsSync(path.join(tmpDir, 'none.adv-pipe-cmp-e1.xml'))).toBe(false);
    expect(existsSync(path.join(tmpDir, 'none.adv-pipe-cmp-e2.xml'))).toBe(false);
  });

  it('compare: corrupt programme data on one side fails with an honest error', async () => {
    registerProvider(goodProvider('adv-pipe-cmp-c1'));
    registerProvider({
      id: 'adv-pipe-cmp-c2',
      name: 'Adv Pipe Compare Corrupt',
      baseUrl: 'https://example.invalid',
      scrape: async () => ({
        channels: [{ id: 'ATV.tr', name: 'ATV' }],
        programmes: [
          {
            channel: 'ATV.tr',
            start: '2026-09-08T11:00:00+03:00',
            stop: '2026-09-08T10:00:00+03:00', // reversed
            title: 'Corrupt',
          },
        ],
        days: 1,
        failures: 0,
      }),
    });
    const out = path.join(tmpDir, 'corrupt-cmp.xml');
    const { exit, stderr } = await run([
      '--provider', 'adv-pipe-cmp-c1,adv-pipe-cmp-c2', '--compare', '--no-gzip', '--out', out,
    ]);
    // The comparison itself renders fine (it does not validate timestamps);
    // the corrupt side aborts at write time — side A was already written, so
    // the run stops at the first corrupt side rather than emitting garbage.
    expect(exit).toBe(1);
    expect(stderr).toMatch(/stop <= start/);
    expect(existsSync(path.join(tmpDir, 'corrupt-cmp.adv-pipe-cmp-c1.xml'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'corrupt-cmp.adv-pipe-cmp-c2.xml'))).toBe(false);
  });
});