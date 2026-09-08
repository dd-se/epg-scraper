import { describe, it, expect } from 'vitest';
import { decodeEntities } from '../src/entities.js';
import { channelIdFromName } from '../src/slug.js';
import { toXmltvTimestamp, generateXmltv } from '../src/xmltv.js';
import { buildDateRange, registerProvider, getProvider, listProviders } from '../src/registry.js';
import { createChannel, createProgramme } from '../src/model.js';

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

describe('model', () => {
  it('validates required fields', () => {
    expect(() => createChannel({ name: 'X' })).toThrow(/id/);
    expect(() => createChannel({ id: 'X.tr' })).toThrow(/name/);
    expect(() => createProgramme({ channel: 'a', start: 's', title: 't' })).toThrow(/stop/);
  });

  it('keeps optional fields undefined when empty', () => {
    const channel = createChannel({ id: 'X.tr', name: 'X', icon: '', url: undefined });
    expect(channel.icon).toBeUndefined();
    expect(channel.url).toBeUndefined();
    const programme = createProgramme({
      channel: 'X.tr',
      start: '2026-09-07T06:00:00+03:00',
      stop: '2026-09-07T07:00:00+03:00',
      title: 't',
      desc: null,
    });
    expect(programme.desc).toBeUndefined();
  });
});
