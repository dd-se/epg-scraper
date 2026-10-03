// TRT Yayın Akışı (trthaber.com) — parser, scrape and CLI integration.
//
// Everything runs against fixtures under test/fixtures/trt/ with a stubbed
// fetchImpl: no live network.  The fixtures are trimmed real pages: a day page
// keeps its <title> (which is what the provider verifies the served date
// against) plus the first and last `epg-list` items, and the index keeps the
// 11 channel cards with their logos.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BASE_URL,
  INDEX_URL,
  CHANNELS,
  CHANNEL_ID_MAP,
  dayPageUrl,
  daySlug,
  mapChannelId,
  parseChannelLogos,
  parseDayPage,
  parseServedDate,
  scrape,
} from '../src/providers/trt.js';
import { runCli } from '../src/cli.js';
import { readXmltvFile } from '../src/xmltv.js';
import { mergeResults } from '../src/merge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(path.join(HERE, 'fixtures', 'trt', name), 'utf8');

const INDEX = fixture('index.html');
const HABER = fixture('trt-haber-2026-10-03.html');
const SPOR = fixture('trt-spor-2026-10-03.html');

const html = (body) => ({ ok: true, status: 200, text: async () => body });

// Serves the index plus a day page per channel from the two fixtures.
const stubFetch = (log = () => {}) => async (url) => {
  log(url);
  if (url === INDEX_URL) return html(INDEX);
  if (url.includes('/trt-spor/')) return html(SPOR);
  return html(HABER);
};

describe('trt channel table', () => {
  it('curates the eleven channels the site serves', () => {
    expect(CHANNELS.map((c) => c.slug)).toEqual([
      'trt-1',
      'trt-2',
      'trt-haber',
      'trt-spor',
      'trt-spor-2',
      'trt-belgesel',
      'trt-cocuk',
      'trt-muzik',
      'trt-turk',
      'trt-avaz',
      'trt-kurdi',
    ]);
  });

  it('normalizes ids to the epgshare01 reference, diacritics included', () => {
    expect(mapChannelId('TRT Haber')).toBe('TRT.HABER.tr');
    expect(mapChannelId('TRT 1')).toBe('TRT.1.tr');
    expect(mapChannelId('TRT Çocuk')).toBe('TRT.ÇOCUK.tr');
    expect(mapChannelId('TRT Müzik')).toBe('TRT.MÜZİK.tr');
    expect(mapChannelId('TRT Türk')).toBe('TRT.TÜRK.tr');
    expect(mapChannelId('trt kurdî')).toBe('TRT.KURDİ.tr'); // case-insensitive
    expect(mapChannelId('TRT Avaz')).toBe('TRT.AVAZ.HD.tr'); // HD-only upstream
    expect(mapChannelId('TRT Spor Yıldız')).toBe('TRT.SPOR.YILDIZ.tr');
    expect(mapChannelId('No Such Channel')).toBeUndefined();
  });

  it('maps every channel through CHANNEL_ID_MAP for the reference test', () => {
    for (const channel of CHANNELS) {
      expect(mapChannelId(channel.name)).toBe(channel.id);
      expect(Object.values(CHANNEL_ID_MAP)).toContain(channel.id);
    }
  });
});

describe('trt URLs', () => {
  it('uses the DD-MM-YYYY path the site publishes', () => {
    expect(daySlug('2026-10-03')).toBe('03-10-2026');
    expect(dayPageUrl('trt-haber', '2026-10-03')).toBe(`${BASE_URL}/yayin-akisi/trt-haber/03-10-2026`);
    expect(INDEX_URL).toBe('https://www.trthaber.com/yayin-akisi.html');
  });
});

describe('parseServedDate', () => {
  it('reads the date the page says it serves', () => {
    expect(parseServedDate(HABER)).toBe('2026-10-03');
    expect(parseServedDate(SPOR)).toBe('2026-10-03');
  });

  it('handles every Turkish month the site can write', () => {
    const months = [
      ['Ocak', 1],
      ['Şubat', 2],
      ['Mart', 3],
      ['Nisan', 4],
      ['Mayıs', 5],
      ['Haziran', 6],
      ['Temmuz', 7],
      ['Ağustos', 8],
      ['Eylül', 9],
      ['Ekim', 10],
      ['Kasım', 11],
      ['Aralık', 12],
    ];
    for (const [name, month] of months) {
      const page = `<title>TRT Haber 09 ${name} 2026 tarihli Yayın Akışı</title>`;
      expect(parseServedDate(page)).toBe(`2026-${String(month).padStart(2, '0')}-09`);
    }
  });

  it('rejects hostile and missing titles instead of guessing', () => {
    expect(parseServedDate('<title>TRT Haber 32 Ekim 2026 tarihli</title>')).toBeUndefined();
    expect(parseServedDate('<title>TRT Haber 31 Şubat 2026 tarihli</title>')).toBeUndefined();
    expect(parseServedDate('<title>TRT Haber 03 Bilinmeyen 2026 tarihli</title>')).toBeUndefined();
    expect(parseServedDate('<title>Yayın Akışı</title>')).toBeUndefined();
    expect(parseServedDate('<html>no title at all</html>')).toBeUndefined();
    expect(parseServedDate(null)).toBeUndefined();
    expect(parseServedDate(undefined)).toBeUndefined();
  });
});

describe('parseDayPage', () => {
  it('reads the slot times and titles', () => {
    const slots = parseDayPage(HABER);
    expect(slots[0]).toEqual({ startMin: 360, title: 'Haber 06 (Canlı)' });
    expect(slots.map((s) => s.startMin)).toEqual([...slots.map((s) => s.startMin)].sort((a, b) => a - b));
  });

  it('degrades to an empty list for junk, wrong markup and non-strings', () => {
    expect(parseDayPage('<html><body>nothing here</body></html>')).toEqual([]);
    expect(parseDayPage('<ul class="epg-list"><li>no time div</li></ul>')).toEqual([]);
    expect(parseDayPage(null)).toEqual([]);
    expect(parseDayPage(42)).toEqual([]);
  });

  it('drops hostile clock values and blank titles, keeping valid slots', () => {
    const page = `<ul class="epg-list">
      <li><div class="time">24:30</div><div class="program-name">Too late</div></li>
      <li><div class="time">-5:00</div><div class="program-name">Negative</div></li>
      <li><div class="time">99:99</div><div class="program-name">Absurd</div></li>
      <li><div class="time">10:00</div><div class="program-name">   </div></li>
      <li><div class="time">11:00</div><div class="program-name">Valid &amp; kept</div></li>
    </ul>`;
    expect(parseDayPage(page)).toEqual([{ startMin: 660, title: 'Valid & kept' }]);
  });
});

describe('parseChannelLogos', () => {
  it('maps every card slug to its logo', () => {
    const logos = parseChannelLogos(INDEX);
    expect(logos.size).toBe(CHANNELS.length);
    expect(logos.get('trt-haber')).toBe(
      'https://trthaberstatic.cdn.wp.trt.com.tr/static/images/kanal-logo/trt-haber-logo-fix.jpg'
    );
    expect(logos.get('trt-spor-2')).toContain('trt-spor-yildiz-logo-fix.jpg');
  });

  it('degrades to an empty map instead of throwing', () => {
    expect(parseChannelLogos('<html></html>').size).toBe(0);
    expect(parseChannelLogos(null).size).toBe(0);
    expect(parseChannelLogos('not html').size).toBe(0);
  });

  it('rejects a logo that is not a clean absolute URL', () => {
    const page = '<a href="https://www.trthaber.com/yayin-akisi/trt-1/03-10-2026"><img src="javascript:alert(1)"></a>';
    expect(parseChannelLogos(page).size).toBe(0);
  });
});

describe('trt scrape (stubbed)', () => {
  it('returns every requested channel-day with derived stops', async () => {
    const result = await scrape({
      dates: ['2026-10-03'],
      fetchImpl: stubFetch(),
      politenessDelayMs: 0,
    });

    expect(result.failures).toBe(0);
    expect(result.channels).toHaveLength(CHANNELS.length);
    expect(result.channels.find((c) => c.id === 'TRT.HABER.tr')).toMatchObject({
      id: 'TRT.HABER.tr',
      name: 'TRT Haber',
    });
    // Logos come from the single index fetch.
    expect(result.channels.find((c) => c.id === 'TRT.HABER.tr').icon).toContain('trt-haber-logo');

    const haber = result.programmes.filter((p) => p.channel === 'TRT.HABER.tr');
    expect(haber[0].start).toBe('2026-10-03T06:00:00+03:00');
    // The last slot of the fixture runs to 24:00 (explicit end-of-day).
    const last = haber[haber.length - 1];
    expect(last.stop).toBe('2026-10-04T00:00:00+03:00');
    expect(new Date(last.stop) > new Date(last.start)).toBe(true);

    // No programme may reference a channel the result never listed.
    const ids = new Set(result.channels.map((c) => c.id));
    for (const programme of result.programmes) expect(ids.has(programme.channel)).toBe(true);
  });

  it('honors maxChannels', async () => {
    const result = await scrape({
      dates: ['2026-10-03'],
      fetchImpl: stubFetch(),
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0].id).toBe('TRT.1.tr');
  });

  it('skips a page that serves a different date than requested', async () => {
    const lines = [];
    const result = await scrape({
      // The fixture says 03-10-2026, so asking for another date must not be
      // silently misdated.
      dates: ['2026-10-05'],
      fetchImpl: stubFetch(),
      log: lines.push.bind(lines),
      politenessDelayMs: 0,
      maxChannels: 3,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(3);
    expect(lines.join('\n')).toMatch(/served 2026-10-03 instead/);
  });

  it('degrades gracefully when every fetch fails', async () => {
    const lines = [];
    const result = await scrape({
      dates: ['2026-10-03'],
      fetchImpl: async () => {
        throw new Error('network down');
      },
      log: lines.push.bind(lines),
      politenessDelayMs: 0,
      maxChannels: 2,
    });
    expect(result.channels).toHaveLength(2); // still declared, logoless
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBeGreaterThan(0);
    expect(lines.join('\n')).toMatch(/network down/);
  });

  it('degrades when the index fetch fails but the day pages work', async () => {
    const result = await scrape({
      dates: ['2026-10-03'],
      fetchImpl: async (url) => {
        if (url === INDEX_URL) throw new Error('index down');
        return html(HABER);
      },
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.channels[0].icon).toBeUndefined();
    expect(result.programmes.length).toBeGreaterThan(0);
  });
});

describe('trt + hurriyet merge (exclusive channels)', () => {
  const trtGuide = {
    channels: [
      { id: 'TRT.1.tr', name: 'TRT 1', icon: 'https://trt/1.png' },
      { id: 'TRT.HABER.tr', name: 'TRT Haber', icon: 'https://trt/haber.png' },
    ],
    programmes: [
      { channel: 'TRT.1.tr', start: '2026-10-03T06:00:00+03:00', stop: '2026-10-03T09:00:00+03:00', title: 'TRT 06' },
      { channel: 'TRT.HABER.tr', start: '2026-10-03T06:00:00+03:00', stop: '2026-10-03T07:00:00+03:00', title: 'Haber 06' },
    ],
    days: 1,
  };
  const hurriyetGuide = {
    channels: [
      { id: 'TRT.1.tr', name: 'TRT 1', icon: 'https://hurriyet/1.png' },
      { id: 'ATV.tr', name: 'ATV' },
    ],
    programmes: [
      // Same channel as TRT's, different boundaries: an additive merge would
      // keep both and split the day.
      { channel: 'TRT.1.tr', start: '2026-10-03T06:30:00+03:00', stop: '2026-10-03T08:30:00+03:00', title: 'Hürriyet TRT 1' },
      { channel: 'ATV.tr', start: '2026-10-03T06:00:00+03:00', stop: '2026-10-03T07:00:00+03:00', title: 'ATV 06' },
    ],
    days: 1,
  };

  it('additive by default: both feeds survive', () => {
    const merged = mergeResults([trtGuide, hurriyetGuide], (id) => id);
    expect(merged.shadowed).toBe(0);
    expect(merged.programmes.filter((p) => p.channel === 'TRT.1.tr')).toHaveLength(2);
  });

  it('exclusive: the first provider owns the channel, the duplicate is dropped', () => {
    const merged = mergeResults([trtGuide, hurriyetGuide], (id) => id, { exclusiveChannels: true });
    expect(merged.shadowed).toBe(1);
    const trt1 = merged.programmes.filter((p) => p.channel === 'TRT.1.tr');
    expect(trt1).toHaveLength(1);
    expect(trt1[0].title).toBe('TRT 06');
    // Channels are still unioned, and Hürriyet's channels-only entry fills gaps.
    expect(merged.programmes.filter((p) => p.channel === 'ATV.tr')).toHaveLength(1);
    expect(merged.channels.find((c) => c.id === 'ATV.tr')).toBeTruthy();
  });

  it('exclusive: the owner keeps its own logo, never the later provider’s', () => {
    const merged = mergeResults([trtGuide, hurriyetGuide], (id) => id, { exclusiveChannels: true });
    expect(merged.channels.find((c) => c.id === 'TRT.1.tr').icon).toBe('https://trt/1.png');
  });

  it('exclusive: a logo-less owner is still backfilled from a later provider', () => {
    const merged = mergeResults(
      [{ ...trtGuide, channels: [{ id: 'TRT.1.tr', name: 'TRT 1' }] }, hurriyetGuide],
      (id) => id,
      { exclusiveChannels: true }
    );
    expect(merged.channels.find((c) => c.id === 'TRT.1.tr').icon).toBe('https://hurriyet/1.png');
  });

  it('exclusive respects an alias map: ownership follows the canonical id', () => {
    const aliased = {
      channels: [{ id: 'TRT1.tr', name: 'TRT 1' }],
      programmes: [
        { channel: 'TRT1.tr', start: '2026-10-03T06:00:00+03:00', stop: '2026-10-03T07:00:00+03:00', title: 'Aliased' },
      ],
      days: 1,
    };
    const merged = mergeResults([trtGuide, aliased], (id) => (id === 'TRT1.tr' ? 'TRT.1.tr' : id), {
      exclusiveChannels: true,
    });
    expect(merged.programmes.filter((p) => p.channel === 'TRT.1.tr')).toHaveLength(1);
    expect(merged.shadowed).toBe(1);
  });
});

describe('trt cli integration (stubbed, temp output)', () => {
  let dir;
  let stdout;
  let stderr;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'trt-cli-'));
    stdout = [];
    stderr = [];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // runCli writes through stream-like sinks, so collect with { write }.
  const collector = (lines) => ({ write: (text) => lines.push(text.replace(/\n$/, '')) });
  const run = (argv, providerLoader) =>
    runCli({
      argv,
      cwd: dir,
      stdout: collector(stdout),
      stderr: collector(stderr),
      providerLoader,
    });

  const loader = () => [
    { id: 'trt', country: 'TR', language: 'tr', scrape, browserCompatible: true },
  ];

  it('writes a gzipped guide named after the provider', async () => {
    const fetchImpl = stubFetch();
    const code = await run(
      ['--provider', 'trt', '--date', '2026-10-03', '--days-forward', '0', '--delay-ms', '0'],
      () => [
        {
          id: 'trt',
          country: 'TR',
          language: 'tr',
          scrape: (options) => scrape({ ...options, fetchImpl }),
        },
      ]
    );

    expect(code).toBe(0);
    const out = path.join(dir, 'epg_trt_TR.xml.gz');
    expect(existsSync(out)).toBe(true);
    const parsed = await readXmltvFile(out);
    expect(parsed.language).toBe('tr');
    expect(parsed.channels.map((c) => c.id)).toContain('TRT.HABER.tr');
    expect(parsed.programmes.length).toBeGreaterThan(0);
  });

  it('refuses to write an empty guide when every page fails', async () => {
    const code = await run(
      ['--provider', 'trt', '--date', '2026-10-03', '--days-forward', '0', '--delay-ms', '0'],
      () => [
        {
          id: 'trt',
          country: 'TR',
          language: 'tr',
          scrape: (options) =>
            scrape({
              ...options,
              fetchImpl: async () => {
                throw new Error('down');
              },
            }),
        },
      ]
    );

    expect(code).toBe(1);
    expect(stderr.join('\n')).toMatch(/refusing to write an empty guide/);
    expect(existsSync(path.join(dir, 'epg_trt_TR.xml.gz'))).toBe(false);
  });

  it('rejects --exclusive-channels without --merge', async () => {
    const code = await run(['--provider', 'trt', '--exclusive-channels'], loader);
    expect(code).toBe(1);
    expect(stderr.join('\n')).toMatch(/--exclusive-channels requires --merge/);
  });

  it('--help documents the merge ownership flag', async () => {
    expect(await run(['--help'], loader)).toBe(0);
    expect(stdout.join('\n')).toContain('--exclusive-channels');
  });
});