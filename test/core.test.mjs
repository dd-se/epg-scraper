import { describe, it, expect, vi } from 'vitest';
import { decodeEntities } from '../src/entities.js';
import { channelIdFromName } from '../src/slug.js';
import { toXmltvTimestamp, generateXmltv } from '../src/xmltv.js';
import { buildDateRange, registerProvider, getProvider, listProviders } from '../src/registry.js';
import { createGuideResult, validateGuideResult, normalizeLanguageTag } from '../src/model.js';
import { parseClockMinutes, wallToInstant, parseGuideInstant } from '../src/time.js';
import { runCli } from '../src/cli.js';

describe('entities', () => {
  it('decodes numeric hex/dec references', () => {
    expect(decodeEntities('&#x131;')).toBe('ı');
    expect(decodeEntities('&#x130;')).toBe('İ');
    expect(decodeEntities('&#xDC;')).toBe('Ü');
    expect(decodeEntities('&#39;')).toBe("'");
    expect(decodeEntities('&#x27;la Joker')).toBe("'la Joker");
  });

  it('decodes named entities', () => {
    expect(decodeEntities('A&amp;B')).toBe('A&B');
    expect(decodeEntities('&ccedil;ilek')).toBe('çilek');
  });

  it('leaves unknown entities intact', () => {
    expect(decodeEntities('&nope;')).toBe('&nope;');
  });

  it('handles null/undefined and non-string input', () => {
    expect(decodeEntities(null)).toBe('');
    expect(decodeEntities(undefined)).toBe('');
    expect(decodeEntities(42)).toBe('42');
  });
});

describe('slug', () => {
  it('follows the epgshare01 convention', () => {
    expect(channelIdFromName('KANAL D')).toBe('KANAL.D.tr');
    expect(channelIdFromName('TRT BELGESEL')).toBe('TRT.BELGESEL.tr');
    expect(channelIdFromName('  360  ')).toBe('360.tr');
    expect(channelIdFromName('A Haber')).toBe('A.HABER.tr');
  });

  it('never returns an empty id', () => {
    expect(channelIdFromName('///')).toBe('UNKNOWN.tr');
  });
});

describe('xmltv timestamps', () => {
  it('formats ISO instants with explicit offsets', () => {
    expect(toXmltvTimestamp('2026-09-07T15:00:00+03:00')).toBe('20260907150000 +0300');
    expect(toXmltvTimestamp('2026-09-07T15:00+03:00')).toBe('20260907150000 +0300');
    expect(toXmltvTimestamp('2026-09-07T12:00:00Z')).toBe('20260907120000 +0000');
  });

  it('rejects non-ISO and fractional input', () => {
    expect(() => toXmltvTimestamp('nonsense')).toThrow();
    expect(() => toXmltvTimestamp('2026-09-07T15:00:00.500+03:00')).toThrow(/Fractional/);
  });
});

describe('xmltv writer', () => {
  const channels = [
    { id: 'KANAL.D.tr', name: 'KANAL D', icon: 'https://x/94.png', url: 'https://y/' },
    { id: 'ATV.tr', name: 'ATV' },
  ];

  it('emits the epgshare01 reference shape', () => {
    const xml = generateXmltv({
      channels,
      programmes: [
        {
          channel: 'KANAL.D.tr',
          start: '2026-09-07T15:00:00+03:00',
          stop: '2026-09-07T17:00:00+03:00',
          title: 'Program Adı',
          category: 'Dizi',
        },
        {
          channel: 'ATV.tr',
          start: '2026-09-07T06:00:00+03:00',
          stop: '2026-09-07T10:00:00+03:00',
          title: 'ATV & Friends <live>',
        },
      ],
      generatorInfoName: 'test',
    });

    expect(xml).toContain('<tv generator-info-name="test" generator-info-url="none">');
    expect(xml).toContain('<channel id="KANAL.D.tr">');
    expect(xml).toContain('<display-name lang="tr">KANAL D</display-name>');
    expect(xml).toContain('<icon src="https://x/94.png" />');
    expect(xml).toContain('<url>https://y/</url>');
    expect(xml).toContain('</channel>');
    expect(xml).toContain(
      '<programme start="20260907150000 +0300" stop="20260907170000 +0300" channel="KANAL.D.tr">'
    );
    expect(xml).toContain('<title lang="tr">Program Adı</title>');
    expect(xml).toContain('<category lang="tr">Dizi</category>');
    expect(xml).toContain('<title lang="tr">ATV &amp; Friends &lt;live&gt;</title>');
    expect(xml.trimEnd().endsWith('</tv>')).toBe(true);
  });

  it('omits optional sub-title/desc/category/icon when absent', () => {
    const xml = generateXmltv({
      channels,
      programmes: [
        {
          channel: 'ATV.tr',
          start: '2026-09-07T06:00:00+03:00',
          stop: '2026-09-07T07:00:00+03:00',
          title: 'X',
        },
      ],
    });
    expect(xml).not.toContain('<sub-title');
    expect(xml).not.toContain('<desc');
    expect(xml).not.toContain('<category');
  });

  it('accepts the canonical guide language field', () => {
    const xml = generateXmltv({
      channels,
      programmes: [
        {
          channel: 'ATV.tr',
          start: '2026-09-07T06:00:00+03:00',
          stop: '2026-09-07T07:00:00+03:00',
          title: 'Svenska',
        },
      ],
      language: 'sv',
    });
    expect(xml).toContain('lang="sv"');
  });

  it('sorts programmes by channel then start', () => {
    const xml = generateXmltv({
      channels,
      programmes: [
        {
          channel: 'KANAL.D.tr',
          start: '2026-09-07T15:00:00+03:00',
          stop: '2026-09-07T16:00:00+03:00',
          title: 'later',
        },
        {
          channel: 'ATV.tr',
          start: '2026-09-07T09:00:00+03:00',
          stop: '2026-09-07T10:00:00+03:00',
          title: 'atv',
        },
        {
          channel: 'KANAL.D.tr',
          start: '2026-09-07T06:00:00+03:00',
          stop: '2026-09-07T07:00:00+03:00',
          title: 'earlier',
        },
      ],
    });
    const order = [...xml.matchAll(/<title lang="tr">([^<]+)<\/title>/g)].map((m) => m[1]);
    expect(order).toEqual(['atv', 'earlier', 'later']);
  });

  it('rejects programmes on unknown channels', () => {
    expect(() =>
      generateXmltv({
        channels,
        programmes: [
          {
            channel: 'NOPE.tr',
            start: '2026-09-07T06:00:00+03:00',
            stop: '2026-09-07T07:00:00+03:00',
            title: 'x',
          },
        ],
      })
    ).toThrow(/unknown channel/);
  });

  it('dedupes programmes with identical (channel, start, stop)', () => {
    const programme = {
      channel: 'ATV.tr',
      start: '2026-09-07T06:00:00+03:00',
      stop: '2026-09-07T07:00:00+03:00',
      title: 'x',
    };
    const xml = generateXmltv({ channels, programmes: [programme, programme] });
    expect(xml.match(/<programme /g)).toHaveLength(1);
  });
});

describe('registry', () => {
  it('registers, lists and resolves providers', () => {
    const provider = { id: 'test-a', name: 'Test A', scrape: async () => ({}) };
    registerProvider(provider);
    expect(getProvider('test-a')).toBe(provider);
    expect(listProviders().map((p) => p.id)).toContain('test-a');
    expect(() => getProvider('missing')).toThrow(/Unknown provider/);
    expect(() => registerProvider({ id: 'bad', name: 'no scrape' })).toThrow(/scrape/);
  });

  it('rejects invalid browser compatibility declarations', () => {
    expect(() =>
      registerProvider({ id: 'bad-browser-metadata', scrape: async () => ({}), browserCompatible: 'no' })
    ).toThrow(/browserCompatible/);
    expect(() =>
      registerProvider({
        id: 'contradictory-browser-metadata',
        scrape: async () => ({}),
        requiresBrowser: true,
        browserCompatible: false,
      })
    ).toThrow(/browserCompatible/);
  });
});

describe('cli provider transport preflight', () => {
  it('rejects browser transport for an HTTP-only provider before scraping', async () => {
    const scrape = vi.fn(async () => ({ channels: [], programmes: [], days: 0, failures: 0 }));
    const stdout = [];
    const stderr = [];
    const exitCode = await runCli({
      argv: [
        '--provider',
        'test-http-only',
        '--browser',
        '--date',
        '2026-09-08',
        '--days-forward',
        '0',
      ],
      providerLoader: () => [
        {
          id: 'test-http-only',
          name: 'HTTP only',
          baseUrl: 'https://example.test',
          browserCompatible: false,
          scrape,
        },
      ],
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: (line) => stderr.push(line) },
    });
    expect(exitCode).toBe(1);
    expect(scrape).not.toHaveBeenCalled();
    expect(stderr.join('')).toMatch(/HTTP-only/);
  });
});

describe('buildDateRange', () => {
  it('builds today + daysForward in Istanbul wall time', () => {
    const dates = buildDateRange({
      referenceDate: new Date('2026-09-08T10:00:00Z'), // 13:00 Istanbul
      daysBack: 0,
      daysForward: 6,
    });
    expect(dates).toHaveLength(7);
    expect(dates[0]).toBe('2026-09-08');
    expect(dates[6]).toBe('2026-09-14');
  });

  it('honors daysBack', () => {
    const dates = buildDateRange({
      referenceDate: new Date('2026-09-08T10:00:00Z'),
      daysBack: 2,
      daysForward: 0,
    });
    expect(dates).toEqual(['2026-09-06', '2026-09-07', '2026-09-08']);
  });
});

describe('guide result', () => {
  it('sanitizes hostile provider results without mutating the input', () => {
    const issues = [];
    const input = {
      channels: [
        { id: 'X.tr', name: 'X' },
        { id: 'X.tr', name: 'Later', icon: 'https://x/i.png', url: 'https://x/' },
        { id: '', name: 'No id' },
        null,
      ],
      programmes: [
        {
          channel: 'X.tr',
          start: '2026-09-07T06:00:00+03:00',
          stop: '2026-09-07T07:00:00+03:00',
          title: 'Keep',
          desc: { hostile: true },
        },
        {
          channel: 'X.tr',
          start: '2026-09-07T06:00:00+03:00',
          stop: '2026-09-07T07:00:00+03:00',
          title: 'Keep',
        },
        {
          channel: 'MISSING.tr',
          start: '2026-09-07T08:00:00+03:00',
          stop: '2026-09-07T09:00:00+03:00',
          title: 'Drop',
        },
        {
          channel: 'X.tr',
          start: '2026-09-07T09:00:00+03:00',
          stop: '2026-09-07T08:00:00+03:00',
          title: 'Reversed',
        },
      ],
      days: 1,
      failures: 0,
    };
    const result = createGuideResult(input, {
      onIssue: (code, count) => issues.push([code, count]),
    });

    expect(result.channels).toEqual([
      { id: 'X.tr', name: 'X', icon: 'https://x/i.png', url: 'https://x/' },
    ]);
    expect(result.programmes).toHaveLength(1);
    expect(result.programmes[0].desc).toBeUndefined();
    expect(result).toMatchObject({ days: 1, failures: 0, language: 'tr' });
    expect(issues).toEqual(
      expect.arrayContaining([
        ['invalid-channel', 2],
        ['duplicate-programme', 1],
        ['unknown-channel', 1],
        ['invalid-programme', 1],
      ])
    );
    expect(input.channels[0]).toEqual({ id: 'X.tr', name: 'X' });
    expect(input.programmes).toHaveLength(4);
  });

  it('sorts by instant while keeping literal start strings deterministic', () => {
    const laterInstant = {
      channel: 'X.tr',
      start: '2026-10-25T02:30:00+02:00',
      stop: '2026-10-25T03:30:00+02:00',
      title: 'Earlier instant',
    };
    const earlierText = {
      channel: 'X.tr',
      start: '2026-10-25T02:00:00+01:00',
      stop: '2026-10-25T03:00:00+01:00',
      title: 'Later instant',
    };
    const result = createGuideResult({
      channels: [{ id: 'X.tr', name: 'X' }],
      programmes: [earlierText, laterInstant],
    });
    expect(result.programmes.map((programme) => programme.title)).toEqual([
      'Earlier instant',
      'Later instant',
    ]);
  });

  it('keeps the writer validation seam strict', () => {
    expect(() =>
      validateGuideResult({
        channels: [
          { id: 'X.tr', name: 'X' },
          { id: 'X.tr', name: 'Duplicate' },
        ],
        programmes: [],
        lang: 'tr',
      })
    ).toThrow(/duplicate channel/);
    expect(() =>
      validateGuideResult({
        channels: [{ id: 'X.tr', name: 'X' }],
        programmes: [
          {
            channel: 'X.tr',
            start: '2026-09-07T06:00:00+03:00',
            stop: '2026-09-07T07:00:00+03:00',
            title: '',
          },
        ],
        lang: 'tr',
      })
    ).toThrow(/title/);
  });

  it('rejects empty optional metadata at the writer seam', () => {
    expect(() =>
      validateGuideResult({
        channels: [{ id: 'X.tr', name: 'X', icon: '' }],
        programmes: [],
        lang: 'tr',
      })
    ).toThrow(/non-empty string/);
  });

  it('normalizes guide language tags', () => {
    expect(normalizeLanguageTag(' sv-SE ')).toBe('sv-SE');
    expect(normalizeLanguageTag('bad tag')).toBeUndefined();
  });
});

describe('guide time semantics', () => {
  it('accepts end-of-day only where the source wall time allows it', () => {
    expect(parseClockMinutes(23, 59)).toBe(1439);
    expect(parseClockMinutes(24, 0, { allowEndOfDay: true })).toBe(1440);
    expect(parseClockMinutes(24, 0)).toBeUndefined();
    expect(parseClockMinutes(24, 30, { allowEndOfDay: true })).toBeUndefined();
  });

  it('converts validated wall dates without Date.UTC rollover', () => {
    expect(wallToInstant(2026, 9, 7, 1440)).toBe('2026-09-08T00:00:00+03:00');
    expect(wallToInstant(2026, 2, 30, 0)).toBeUndefined();
    expect(wallToInstant(2026, 9, 7, 1441)).toBeUndefined();
    expect(wallToInstant(2026, 9, 7, -1)).toBeUndefined();
  });

  it('requires canonical offset-bearing guide instants', () => {
    expect(parseGuideInstant('2026-09-07T06:00:00+03:00')?.epochMs).toBeTypeOf('number');
    expect(parseGuideInstant('2026-09-07T06:00:00')).toBeUndefined();
    expect(parseGuideInstant('2026-09-07T06:00:00Z')).toBeUndefined();
    expect(parseGuideInstant('2026-09-07T06:00:00.000+03:00')).toBeUndefined();
    expect(parseGuideInstant('2026-09-07T06:00:00+0300')).toBeUndefined();
  });
});
