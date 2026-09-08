import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseChannelPage,
  parsePrevueResponse,
  mapChannelId,
  normalizeChannelKey,
  channelPageUrl,
  sessionGet,
  prevuePost,
  scrape,
  CHANNELS,
} from '../src/providers/tivibu.js';
import { runCli } from '../src/cli.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/tivibu/${name}`, import.meta.url)), 'utf8');

const page1 = fixture('tivibu-spor-1.html');
const page2 = fixture('tivibu-spor-2.html');
const day1_08 = fixture('tivibu-spor-1-2026-09-08.json');
const day1_09 = fixture('tivibu-spor-1-2026-09-09.json');
const day2_09 = fixture('tivibu-spor-2-2026-09-09.json');
const day3_09 = fixture('tivibu-spor-3-2026-09-09.json');
const day4_09 = fixture('tivibu-spor-4-2026-09-09.json');

const pageResponse = (html, setCookie) => ({
  ok: true,
  status: 200,
  headers: { get: (name) => (name === 'set-cookie' ? setCookie : undefined) },
  text: async () => html,
});
const jsonResponse = (json) => ({ ok: true, status: 200, text: async () => JSON.stringify(json) });
const parse = (text) => JSON.parse(text);

describe('tivibu pure parsers', () => {
  it('extracts the channel code and CSRF token from a channel page', () => {
    const { channelCode, token } = parseChannelPage(page1);
    expect(channelCode).toBe('ch00000000000000001356');
    expect(token).toMatch(/^CfDJ8/);
  });

  it('degrades gracefully on missing markup', () => {
    expect(parseChannelPage('<html>nothing</html>')).toEqual({ channelCode: undefined, token: undefined });
    expect(parseChannelPage(undefined)).toEqual({ channelCode: undefined, token: undefined });
  });

  it('parses a day response into explicit begin/end slots', () => {
    const { slots } = parsePrevueResponse(parse(day1_08));
    expect(slots).toHaveLength(12);
    expect(slots[0]).toEqual({
      beginDate: '2026-09-08',
      beginMin: 0,
      endDate: '2026-09-08',
      endMin: 3 * 60 + 35,
      title: 'Türk Telekom - eSüper Lig',
      category: 'Spor Programı',
      desc: expect.stringContaining('eSüper Lig'),
    });
    expect(slots[1].title).toBe('Türk Telekom - eSüper Lig');
    expect(slots[2].title).toBe('Bursa Yıldırım - Söke 1970');
    // The last slot crosses midnight with an explicit end on the next day.
    expect(slots[slots.length - 1].endDate).toBe('2026-09-09');
  });

  it('includes the previous day\'s cross-midnight tail in the day response', () => {
    const { slots } = parsePrevueResponse(parse(day1_09));
    expect(slots).toHaveLength(12);
    expect(slots[0].title).toBe('KDZ. Ereğli Belediyespor - Fatsa Belediyespor');
    expect(slots[0].beginDate).toBe('2026-09-08'); // started yesterday 23:30
    expect(slots[0].endDate).toBe('2026-09-09');
  });

  it('parses idle promo-loop days (Tivibu Spor 2-4)', () => {
    const { slots } = parsePrevueResponse(parse(day2_09));
    expect(slots).toHaveLength(5);
    expect(slots.every((s) => s.title === 'Tivibu Spor Tanıtım')).toBe(true);
    expect(slots[0].beginMin).toBe(0);
    expect(slots[0].endMin).toBe(5 * 60);
  });

  it('degrades gracefully on malformed responses', () => {
    expect(parsePrevueResponse(null)).toEqual({ slots: [] });
    expect(parsePrevueResponse({ mobilPrevueViewModel: 'x' })).toEqual({ slots: [] });
    expect(parsePrevueResponse({ mobilPrevueViewModel: [{ prevueName: 'no times' }] })).toEqual({
      slots: [],
    });
  });

  it('drops slots whose end precedes or equals their begin (corrupt responses)', () => {
    const { slots } = parsePrevueResponse({
      mobilPrevueViewModel: [
        {
          prevueName: 'Good',
          beginTime: '2026.09.08 10:00:00',
          endTime: '2026.09.08 11:00:00',
        },
        {
          prevueName: 'Reversed same day',
          beginTime: '2026.09.08 23:30:00',
          endTime: '2026.09.08 01:15:00',
        },
        {
          prevueName: 'Zero length',
          beginTime: '2026.09.08 10:00:00',
          endTime: '2026.09.08 10:00:00',
        },
        {
          prevueName: 'End before begin entirely',
          beginTime: '2026.09.09 10:00:00',
          endTime: '2026.09.08 11:00:00',
        },
        {
          prevueName: 'Cross midnight',
          beginTime: '2026.09.08 23:30:00',
          endTime: '2026.09.09 01:15:00',
        },
      ],
    });
    expect(slots.map((s) => s.title)).toEqual(['Good', 'Cross midnight']);
  });

  it('rejects impossible calendar dates instead of rolling them forward', () => {
    // Month 13 / Feb 30 / day 32 would silently land in a different month
    // via wallToIso — drop the slot rather than stamp it a month off.
    const { slots } = parsePrevueResponse({
      mobilPrevueViewModel: [
        {
          prevueName: 'Month 13',
          beginTime: '2026.13.09 10:00:00',
          endTime: '2026.13.09 11:00:00',
        },
        {
          prevueName: 'Feb 30',
          beginTime: '2026.02.30 10:00:00',
          endTime: '2026.02.30 11:00:00',
        },
        {
          prevueName: 'Apr 31',
          beginTime: '2026.04.31 10:00:00',
          endTime: '2026.04.31 11:00:00',
        },
        {
          prevueName: 'Day 0',
          beginTime: '2026.09.00 10:00:00',
          endTime: '2026.09.00 11:00:00',
        },
      ],
    });
    expect(slots).toEqual([]);
    // Legal leap-day instants still parse.
    const leap = parsePrevueResponse({
      mobilPrevueViewModel: [
        { prevueName: 'Leap', beginTime: '2028.02.29 23:30:00', endTime: '2028.03.01 00:30:00' },
      ],
    });
    expect(leap.slots[0].beginDate).toBe('2028-02-29');
    expect(leap.slots[0].endDate).toBe('2028-03-01');
  });

  it('maps display names to slugs and ids', () => {
    expect(mapChannelId('Tivibu Spor 1')).toBe('TIVIBU.SPOR.1.tr');
    expect(mapChannelId('TIVIBU SPOR 4')).toBe('TIVIBU.SPOR.4.tr');
    expect(mapChannelId('Tivibu Spor 5')).toBeUndefined();
    expect(normalizeChannelKey('  tivibu   spor 2 ')).toBe('TIVIBU SPOR 2');
    expect(channelPageUrl('tivibu-spor-1')).toBe('https://www.tivibu.com.tr/kanallar/tivibu-spor-1');
    expect(CHANNELS).toHaveLength(4);
    for (const channel of CHANNELS) {
      expect(channel.id.endsWith('.tr')).toBe(true);
      expect(channel.slug.startsWith('tivibu-spor-')).toBe(true);
    }
  });
});

describe('tivibu transport (stubbed fetch)', () => {
  it('sessionGet captures the antiforgery cookie from set-cookie', async () => {
    const setCookie =
      'X-CSRF-TOKEN-TVBUDNBX=abc123; path=/; httponly; samesite=strict, Detection=def456; path=/';
    const { html, cookie } = await sessionGet('https://www.tivibu.com.tr/kanallar/tivibu-spor-1', {
      fetchImpl: async () => pageResponse(page1, setCookie),
    });
    expect(html).toBe(page1);
    expect(cookie).toContain('X-CSRF-TOKEN-TVBUDNBX=abc123');
    expect(cookie).toContain('Detection=def456');
  });

  it('sessionGet throws on a bad status', async () => {
    await expect(
      sessionGet('https://www.tivibu.com.tr/kanallar/tivibu-spor-1', {
        fetchImpl: async () => ({ ok: false, status: 500 }),
      })
    ).rejects.toThrow(/HTTP 500/);
  });

  it('prevuePost sends the token, cookie and YYYY.MM.DD window', async () => {
    let seen;
    const json = await prevuePost(
      'https://www.tivibu.com.tr/Channel/GetPrevueList',
      {
        channelCode: 'ch00000000000000001356',
        token: 'tok123',
        cookie: 'X-CSRF-TOKEN-TVBUDNBX=abc123',
        referer: 'https://www.tivibu.com.tr/kanallar/tivibu-spor-1',
        date: '2026-09-09',
      },
      {
        fetchImpl: async (url, options) => {
          seen = { url, options };
          return jsonResponse(parse(day1_09));
        },
      }
    );
    expect(seen.options.method).toBe('POST');
    expect(seen.options.headers['RequestVerificationToken']).toBe('tok123');
    expect(seen.options.headers.cookie).toContain('X-CSRF-TOKEN-TVBUDNBX=abc123');
    expect(seen.options.headers['content-type']).toContain('x-www-form-urlencoded');
    expect(seen.options.body).toContain('channelCode=ch00000000000000001356');
    expect(seen.options.body).toContain('channelDateBegin=2026.09.09+00%3A00%3A00');
    expect(seen.options.body).toContain('channelDateEnd=2026.09.09+23%3A59%3A59');
    expect(json.mobilPrevueViewModel.length).toBe(12);
  });
});

describe('tivibu scrape (stubbed fetch)', () => {
  // GET → channel page (with cookie); POST → day JSON keyed by slug+date.
  const byUrl = (url, options, body) => {
    const u = String(url);
    if (options?.method === 'POST') {
      const date = /channelDateBegin=(\d{4})\.(\d{2})\.(\d{2})/.exec(body);
      const key = date ? `${date[1]}-${date[2]}-${date[3]}` : '';
      if (u.includes('GetPrevueList')) {
        if (url.endsWith('tivibu-spor-1') || body.includes('ch00000000000000001356')) {
          return jsonResponse(parse(key === '2026-09-08' ? day1_08 : day1_09));
        }
        if (body.includes('ch00000000000000001270')) return jsonResponse(parse(day2_09));
        if (body.includes('ch00000000000000001357')) return jsonResponse(parse(day3_09));
        if (body.includes('ch00000000000000001971')) return jsonResponse(parse(day4_09));
      }
      return jsonResponse({ mobilPrevueViewModel: [] });
    }
    const page = /kanallar\/(tivibu-spor-[1-4])/.exec(u);
    const bySlug = { 'tivibu-spor-1': page1, 'tivibu-spor-2': page2, 'tivibu-spor-3': page2, 'tivibu-spor-4': page2 };
    return pageResponse(bySlug[page?.[1]] || page1, 'X-CSRF-TOKEN-TVBUDNBX=cookie123; path=/');
  };

  it('scrapes every channel-day with explicit start/stop', async () => {
    const posts = [];
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl: async (url, options) => {
        if (options?.method === 'POST') posts.push(options.body);
        return byUrl(url, options, options?.body);
      },
      log: () => {},
      politenessDelayMs: 0,
    });

    expect(result.failures).toBe(0);
    expect(result.channels.map((c) => c.id)).toEqual([
      'TIVIBU.SPOR.1.tr',
      'TIVIBU.SPOR.2.tr',
      'TIVIBU.SPOR.3.tr',
      'TIVIBU.SPOR.4.tr',
    ]);
    expect(posts).toHaveLength(4);
    expect(result.programmes).toHaveLength(11 + 5 + 5 + 5); // spor-1 keeps 11 of 12 (drops yesterday's tail)

    const t1 = result.programmes.filter((p) => p.channel === 'TIVIBU.SPOR.1.tr');
    expect(t1).toHaveLength(11);
    expect(t1[0]).toEqual({
      channel: 'TIVIBU.SPOR.1.tr',
      start: '2026-09-09T01:15:00+03:00',
      stop: '2026-09-09T04:45:00+03:00',
      title: 'Türk Telekom - eSüper Lig',
      category: 'Spor Programı',
      desc: expect.stringContaining('eSüper Lig'),
    });
    expect(result.programmes.every((p) => p.start.endsWith('+03:00'))).toBe(true);

    const promo = result.programmes.filter((p) => p.title === 'Tivibu Spor Tanıtım');
    expect(promo).toHaveLength(15); // 2, 3, 4 are idle promo loops today — emitted as-is
    expect(promo.every((p) => p.stop > p.start)).toBe(true);
  });

  it('keeps cross-midnight programmes with their explicit stop on the next day', async () => {
    const result = await scrape({
      dates: ['2026-09-08', '2026-09-09'],
      fetchImpl: async (url, options) => byUrl(url, options, options?.body),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    const t1 = result.programmes.filter((p) => p.channel === 'TIVIBU.SPOR.1.tr');
    expect(t1).toHaveLength(12 + 11);
    const lastOf08 = t1.find((p) => p.start === '2026-09-08T23:30:00+03:00');
    expect(lastOf08.title).toBe('KDZ. Ereğli Belediyespor - Fatsa Belediyespor');
    expect(lastOf08.stop).toBe('2026-09-09T01:15:00+03:00');
    // The 09.09 request's response carries that same 08.09 23:30 slot as a
    // cross-midnight tail, which is dropped — it is NOT duplicated.  (The
    // title does legitimately air twice: a 16:30 rebroadcast on 09.09.)
    expect(t1.filter((p) => p.start === '2026-09-08T23:30:00+03:00')).toHaveLength(1);
    expect(t1.filter((p) => p.title === 'KDZ. Ereğli Belediyespor - Fatsa Belediyespor')).toHaveLength(2);
  });

  it('sends the session cookie and token with every POST', async () => {
    let headers;
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl: async (url, options) => {
        if (options?.method === 'POST') headers = options.headers;
        return byUrl(url, options, options?.body);
      },
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 1,
    });
    expect(result.failures).toBe(0);
    expect(headers.cookie).toContain('X-CSRF-TOKEN-TVBUDNBX=cookie123');
    expect(headers.RequestVerificationToken).toMatch(/^CfDJ8/);
  });

  it('degrades gracefully when every request fails', async () => {
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl: async () => {
        throw new Error('HTTP 503');
      },
      log: () => {},
      politenessDelayMs: 0,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(4);
  });

  it('counts a page without a token or code as a failure', async () => {
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl: async () => pageResponse('<html><body>no token here</body></html>', 'X-CSRF-TOKEN-TVBUDNBX=c; path=/'),
      log: () => {},
      politenessDelayMs: 0,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(4);
  });
});

describe('tivibu cli integration (stubbed fetch, temp output)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-scraper-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  const stubFetch = (failSession = false) => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (failSession) return pageResponse('<html><body>no token</body></html>', 'X-CSRF-TOKEN-TVBUDNBX=c; path=/');
      const u = String(url);
      if (options?.method === 'POST') {
        const body = String(options.body);
        if (body.includes('ch00000000000000001356')) return jsonResponse(parse(day1_09));
        if (body.includes('ch00000000000000001270')) return jsonResponse(parse(day2_09));
        if (body.includes('ch00000000000000001357')) return jsonResponse(parse(day3_09));
        if (body.includes('ch00000000000000001971')) return jsonResponse(parse(day4_09));
        return jsonResponse({ mobilPrevueViewModel: [] });
      }
      const page = /kanallar\/(tivibu-spor-[1-4])/.exec(u);
      const bySlug = { 'tivibu-spor-1': page1, 'tivibu-spor-2': page2, 'tivibu-spor-3': page2, 'tivibu-spor-4': page2 };
      return pageResponse(bySlug[page?.[1]] || page1, 'X-CSRF-TOKEN-TVBUDNBX=cookie123; path=/');
    };
    return originalFetch;
  };

  it('writes a gzipped xmltv file and reports success', async () => {
    const { default: fs } = await import('node:fs');
    const originalFetch = stubFetch();
    try {
      const out = path.join(tmpDir, 'tivibu.xml.gz');
      const exit = await runCli({
        argv: [
          '--provider', 'tivibu',
          '--out', out,
          '--date', '2026-09-09',
          '--days-forward', '0',
          '--delay-ms', '0',
          '--quiet',
        ],
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        cwd: tmpDir,
      });
      expect(exit).toBe(0);
      expect(fs.existsSync(out)).toBe(true);
      expect(fs.statSync(out).size).toBeGreaterThan(500);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses to write an empty guide when sessions fail', async () => {
    const originalFetch = stubFetch(true);
    try {
      const stderr = [];
      const exit = await runCli({
        argv: [
          '--provider', 'tivibu',
          '--out', path.join(tmpDir, 'none.xml.gz'),
          '--quiet',
        ],
        stdout: { write: () => {} },
        stderr: { write: (s) => stderr.push(s) },
        cwd: tmpDir,
      });
      expect(exit).toBe(1);
      expect(stderr.join('')).toMatch(/nothing scraped/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});