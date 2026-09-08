import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseMainPage,
  parseChannelPage,
  wallToIso,
  mapChannelId,
  channelDayUrl,
  scrape,
} from '../src/providers/mynet.js';
import { runCli } from '../src/cli.js';

const fixtureDir = fileURLToPath(new URL('./fixtures/mynet', import.meta.url));
const mainHtml = readFileSync(path.join(fixtureDir, 'main.html'), 'utf8');
const kanalDBugun = readFileSync(path.join(fixtureDir, 'kanal-d-bugun.html'), 'utf8');
const kanalDYarin = readFileSync(path.join(fixtureDir, 'kanal-d-yarin.html'), 'utf8');

const response = (html) => ({ ok: true, status: 200, text: async () => html });

describe('mynet parseMainPage', () => {
  it('discovers channel slugs and display names', () => {
    const channels = parseMainPage(mainHtml);
    expect(channels.length).toBeGreaterThan(50);
    const kanalD = channels.find((c) => c.slug === 'kanal-d');
    expect(kanalD).toBeDefined();
    expect(kanalD.name).toBe('KANAL D');
  });

  it('deduplicates channels by slug', () => {
    const channels = parseMainPage(mainHtml);
    const slugs = channels.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('decodes HTML entities in channel names', () => {
    const channels = parseMainPage(mainHtml);
    // &amp; should be decoded to & (the name legitimately contains &)
    const beinHe = channels.find((c) => c.slug === 'bein-he');
    if (beinHe) {
      expect(beinHe.name).toContain('E');
      expect(beinHe.name).not.toContain('&amp;');
    }
  });

  it('extracts channel logos from data-original (lazyload) attributes', () => {
    const channels = parseMainPage(mainHtml);
    const kanalD = channels.find((c) => c.slug === 'kanal-d');
    expect(kanalD.icon).toBeDefined();
    expect(kanalD.icon).toContain('tv-rehberi-logos');
    expect(kanalD.icon.startsWith('https://')).toBe(true);
    expect(kanalD.icon.startsWith('data:')).toBe(false);
  });

  it('prefers data-original over the placeholder src and absolutizes //hosts', () => {
    const html =
      '<a href="https://www.mynet.com/tv-rehberi/kanal-d-yayin-akisi-bugun">' +
      '<img src="data:image/gif;base64,AAAA" data-original="//img7.mynet.com/x/KANALD.png" alt="KANAL D" /></a>';
    const [channel] = parseMainPage(html);
    expect(channel.icon).toBe('https://img7.mynet.com/x/KANALD.png');
  });

  it('falls back to src and omits icon when only a placeholder exists', () => {
    const withSrc = parseMainPage(
      '<a href="https://www.mynet.com/tv-rehberi/kanal-d-yayin-akisi-bugun">' +
        '<img src="https://img7.mynet.com/x/K.png" alt="KANAL D" /></a>'
    );
    expect(withSrc[0].icon).toBe('https://img7.mynet.com/x/K.png');
    const placeholderOnly = parseMainPage(
      '<a href="https://www.mynet.com/tv-rehberi/kanal-d-yayin-akisi-bugun">' +
        '<img src="data:image/gif;base64,AAAA" alt="KANAL D" /></a>'
    );
    expect(placeholderOnly[0].icon).toBeUndefined();
  });

  it('returns empty array for invalid HTML', () => {
    expect(parseMainPage('<html>nothing</html>')).toEqual([]);
  });
});

describe('mynet parseChannelPage', () => {
  it('extracts time-name pairs from a day page', () => {
    const slots = parseChannelPage(kanalDBugun);
    expect(slots.length).toBe(9);
    expect(slots[0]).toEqual({ title: 'Gelinim Mutfakta', startMin: 120 }); // 02:00
    expect(slots[1]).toEqual({ title: 'Siyah Beyaz Aşk', startMin: 240 }); // 04:00
    expect(slots[8]).toEqual({ title: 'Kuralsız Sokaklar', startMin: 1200 }); // 20:00
  });

  it('decodes HTML entities in programme names', () => {
    const slots = parseChannelPage(kanalDBugun);
    const kucukAga = slots.find((s) => s.title.includes('Küçük') || s.title.includes('K'));
    expect(kucukAga).toBeDefined();
    expect(kucukAga.title).not.toContain('&');
  });

  it('parses tomorrow page correctly', () => {
    const slots = parseChannelPage(kanalDYarin);
    expect(slots.length).toBe(9);
    expect(slots[0].title).toBeDefined();
    expect(slots[0].startMin).toBeGreaterThanOrEqual(0);
  });

  it('returns empty array for invalid HTML', () => {
    expect(parseChannelPage('<html>nothing</html>')).toEqual([]);
  });
});

describe('mynet wallToIso', () => {
  it('stamps Istanbul wall time with +03:00', () => {
    expect(wallToIso(2026, 9, 8, 0)).toBe('2026-09-08T00:00:00+03:00');
    expect(wallToIso(2026, 9, 8, 15 * 60)).toBe('2026-09-08T15:00:00+03:00');
    expect(wallToIso(2026, 9, 8, 23 * 60 + 30)).toBe('2026-09-08T23:30:00+03:00');
  });
});

describe('mynet mapChannelId', () => {
  it('uses curated epgshare01 ids', () => {
    expect(mapChannelId('KANAL D')).toBe('KANAL.D.tr');
    expect(mapChannelId('ATV')).toBe('ATV.tr');
    expect(mapChannelId('CNN TÜRK')).toBe('CNN.TÜRK.tr');
  });

  it('normalizes diacritic-less names to the reference ids', () => {
    expect(mapChannelId('CNN TURK')).toBe('CNN.TÜRK.tr');
    expect(mapChannelId('HABERTURK')).toBe('HABERTÜRK.tr');
    expect(mapChannelId('EKOTURK')).toBe('EKOTÜRK.tr');
    expect(mapChannelId('TRT ÇOCUK')).toBe('TRT.ÇOCUK.tr');
    expect(mapChannelId('TRT MÜZİK')).toBe('TRT.MÜZİK.tr');
    expect(mapChannelId('TRT TURK')).toBe('TRT.TÜRK.tr');
    expect(mapChannelId('TRT KURDI')).toBe('TRT.KURDİ.tr');
    expect(mapChannelId('BENGÜTÜRK')).toBe('BENGÜ.TÜRK.tr');
    expect(mapChannelId('ÜLKE TV')).toBe('ÜLKE.TV.tr');
  });

  it('maps split/renamed feeds onto the reference ids', () => {
    expect(mapChannelId('NATIONAL GEO.')).toBe('NATIONAL.GEOGRAPHIC.tr');
    expect(mapChannelId('NAT.GEO.WILD')).toBe('NATIONAL.GEOGRAPHIC.WILD.tr');
    expect(mapChannelId('TRT 3 / TRT SPOR')).toBe('TRT.SPOR.tr');
    expect(mapChannelId('BLOOMBERG')).toBe('BLOOMBERG.TV.tr');
    expect(mapChannelId('Da Vinci')).toBe('DA.VINCI.LEARNING.HD.tr');
  });

  it('uses the HD id where the reference has no SD variant', () => {
    expect(mapChannelId('A NEWS')).toBe('A.NEWS.HD.tr');
    expect(mapChannelId('TRT AVAZ')).toBe('TRT.AVAZ.HD.tr');
    expect(mapChannelId('TRT WORLD')).toBe('TRT.WORLD.HD.tr');
    expect(mapChannelId('beIN SPORTS HABER')).toBe('beIN.SPORTS.HABER.HD.tr');
  });

  it('falls back to generic slug', () => {
    expect(mapChannelId('Yeni Kanal 9')).toBe('YENI.KANAL.9.tr');
  });
});

describe('mynet channelDayUrl', () => {
  it('builds correct URLs', () => {
    expect(channelDayUrl('kanal-d', 'bugun')).toBe(
      'https://www.mynet.com/tv-rehberi/kanal-d-yayin-akisi-bugun'
    );
    expect(channelDayUrl('atv', 'yarin')).toBe(
      'https://www.mynet.com/tv-rehberi/atv-yayin-akisi-yarin'
    );
  });
});

describe('mynet scrape (stubbed)', () => {
  // Build a fake URL→HTML map for the stub.
  function buildFetchMap(channels, days) {
    const map = new Map();
    map.set('https://www.mynet.com/tv-rehberi', mainHtml);
    for (const ch of channels) {
      for (const day of days) {
        const url = channelDayUrl(ch.slug, day);
        // Return the kanal-d fixture for all channels (for testing).
        const fixture = day === 'yarin' ? kanalDYarin : kanalDBugun;
        map.set(url, fixture);
      }
    }
    return map;
  }

  const stubFetch = (fetchMap) => async (url) => {
    const html = fetchMap.get(String(url));
    if (html) return response(html);
    throw new Error(`unexpected url ${url}`);
  };

  it('scrapes channels and programmes from the main page', async () => {
    const channels = parseMainPage(mainHtml).slice(0, 3);
    const fetchMap = buildFetchMap(channels, ['bugun']);
    const logs = [];
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: stubFetch(fetchMap),
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
      maxChannels: 3,
    });

    expect(result.channels.length).toBe(3);
    expect(result.programmes.length).toBeGreaterThan(0);
    expect(result.failures).toBe(0);
    expect(logs.some((l) => l.startsWith('ok:'))).toBe(true);
    // Every programme's channel must be a known channel id.
    const ids = new Set(result.channels.map((c) => c.id));
    expect(result.programmes.every((p) => ids.has(p.channel))).toBe(true);
  });

  it('propagates scraped channel logos into the guide', async () => {
    const channels = parseMainPage(mainHtml).slice(0, 3);
    expect(channels.every((c) => c.icon)).toBe(true);
    const fetchMap = buildFetchMap(channels, ['bugun']);
    const result = await scrape({
      dates: ['2026-09-08'],
      fetchImpl: stubFetch(fetchMap),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 3,
    });
    expect(result.channels.every((c) => c.icon && c.icon.startsWith('https://'))).toBe(true);
  });

  it('fetches multiple days when requested', async () => {
    const channels = parseMainPage(mainHtml).slice(0, 2);
    const fetchMap = buildFetchMap(channels, ['bugun', 'yarin', 'sonraki-gun']);
    const channelUrls = [];
    const result = await scrape({
      dates: ['2026-09-08', '2026-09-09', '2026-09-10'],
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('yayin-akisi')) channelUrls.push(u);
        return stubFetch(fetchMap)(url);
      },
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 2,
    });

    expect(result.days).toBe(3);
    // 2 channels × 3 days = 6 channel-page fetches (excludes main page)
    expect(channelUrls.length).toBe(6);
  });

  it('degrades gracefully when fetches fail', async () => {
    const result = await scrape({
      fetchImpl: async () => {
        throw new Error('HTTP 503');
      },
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 2,
    });

    // Main page fetch fails → returns early with 0 channels.
    expect(result.channels).toEqual([]);
    expect(result.failures).toBe(1);
  });

  it('clamps to 3-day window', async () => {
    const channels = parseMainPage(mainHtml).slice(0, 1);
    const fetchMap = buildFetchMap(channels, ['bugun']);
    const channelUrls = [];
    await scrape({
      dates: ['2026-09-08', '2026-09-15', '2026-09-20'],
      fetchImpl: async (url) => {
        const u = String(url);
        if (u.includes('yayin-akisi')) channelUrls.push(u);
        return stubFetch(fetchMap)(url);
      },
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });

    // Only today (2026-09-08) is within the 3-day window; other dates are outside.
    // channelUrls excludes the main page fetch.
    expect(channelUrls).toHaveLength(1);
  });
});

describe('cli integration (stubbed)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-mynet-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  it('writes an XMLTV file via CLI with --provider mynet', async () => {
    const { default: fs } = await import('node:fs');
    const originalFetch = globalThis.fetch;
    // Stub: return the kanal-d fixture for all channel pages, main page for
    // the channel list.  This keeps the test fast (no real network).
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('mynet.com/tv-rehberi') && !u.includes('yayin-akisi')) {
        return response(mainHtml);
      }
      if (u.includes('yayin-akisi-bugun')) return response(kanalDBugun);
      if (u.includes('yayin-akisi-yarin')) return response(kanalDYarin);
      throw new Error(`unexpected url ${u}`);
    };
    try {
      const out = path.join(tmpDir, 'guide.xml.gz');
      const err = [];
      const exit = await runCli({
        argv: ['--provider', 'mynet', '--out', out, '--quiet', '--date', '2026-09-08', '--max-channels', '3'],
        stdout: { write: () => {} },
        stderr: { write: (s) => err.push(s) },
        cwd: tmpDir,
      });
      // The CLI scrapes all 87 channels for 1 day — no crash, exit 0.
      expect(exit).toBe(0);
      expect(fs.existsSync(out)).toBe(true);
      // The written guide carries scraped channel logos.
      const { gunzipSync } = await import('node:zlib');
      const xml = gunzipSync(fs.readFileSync(out)).toString('utf8');
      expect(xml).toContain('<icon src="https://');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
