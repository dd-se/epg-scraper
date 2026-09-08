import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parsePlatformInfo,
  parseApiInstant,
  parsePlaybill,
  extractSessionCookie,
  mapChannelId,
  normalizeChannelKey,
  scrape,
  CHANNELS,
} from '../src/providers/tvplus.js';
import { runCli } from '../src/cli.js';

const fixture = (name) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/tvplus/${name}`, import.meta.url)), 'utf8');

const platformInfo = fixture('platform-info.json');
const playbill4399 = fixture('playbill-4399-2026-09-09.json');

// Response-like object with optional headers (getSetCookie) — mirrors the
// convention that fetchImpl stubs return { ok, status, text }.
const jsonResponse = (body, headers) => ({
  ok: true,
  status: 200,
  headers,
  text: async () => body,
});

const SESSION_HEADERS = {
  getSetCookie: () => [
    'XSESSIONID=TEST123; Domain=gbzottvsc99.tvplus.com.tr; Path=/; HttpOnly',
    'JSESSIONID=TEST123; Domain=gbzottvsc99.tvplus.com.tr; Path=/; HttpOnly',
  ],
};

describe('tvplus pure parsers', () => {
  it('parsePlatformInfo extracts the rotating api base', () => {
    const base = parsePlatformInfo(platformInfo);
    expect(base).toMatch(/^https:\/\/.+\.tvplus\.com\.tr:33207$/);
    expect(parsePlatformInfo('not json')).toBeUndefined();
    expect(parsePlatformInfo(undefined)).toBeUndefined();
  });

  it('parseApiInstant normalizes API timestamps to wall components', () => {
    expect(parseApiInstant('2026-09-09 00:00:00 UTC+03:00')).toEqual({
      year: 2026,
      month: 9,
      day: 9,
      minutes: 0,
    });
    expect(parseApiInstant('2026-09-09 23:45:00 UTC+03:00').minutes).toBe(23 * 60 + 45);
    expect(parseApiInstant('2026-09-09 00:00')).toEqual({
      year: 2026,
      month: 9,
      day: 9,
      minutes: 0,
    });
    expect(parseApiInstant('garbage')).toBeNull();
    expect(parseApiInstant(undefined)).toBeNull();
  });

  it('rejects out-of-clock wall times instead of rolling them forward', () => {
    // 25:00 / 10:99 would silently become tomorrow's 01:00 via wallToIso.
    expect(parseApiInstant('2026-09-09 25:00:00 UTC+03:00')).toBeNull();
    expect(parseApiInstant('2026-09-09 10:99:00 UTC+03:00')).toBeNull();
    expect(parseApiInstant('2026-09-09 99:99:00 UTC+03:00')).toBeNull();
    // End-of-day 24:00 is a legal wall instant.
    expect(parseApiInstant('2026-09-09 24:00:00 UTC+03:00')).toEqual({
      year: 2026,
      month: 9,
      day: 9,
      minutes: 1440,
    });
  });

  it('rejects impossible calendar dates instead of rolling them forward', () => {
    // Month 13 / Feb 30 / day 32 would silently land in a different month
    // via wallToIso — reject them like the out-of-clock times.
    expect(parseApiInstant('2026-13-09 10:00:00 UTC+03:00')).toBeNull();
    expect(parseApiInstant('2026-02-30 10:00:00 UTC+03:00')).toBeNull();
    expect(parseApiInstant('2026-04-31 10:00:00 UTC+03:00')).toBeNull();
    expect(parseApiInstant('2026-09-00 10:00:00 UTC+03:00')).toBeNull();
    expect(parseApiInstant('2026-09-32 10:00:00 UTC+03:00')).toBeNull();
    // Legal leap-day instants still parse.
    expect(parseApiInstant('2028-02-29 23:30:00 UTC+03:00')).toEqual({
      year: 2028,
      month: 2,
      day: 29,
      minutes: 23 * 60 + 30,
    });
  });

  it('parsePlaybill maps API entries to +03:00 programme slots', () => {
    const slots = parsePlaybill(playbill4399);
    // The live API occasionally returns a null-name gap filler; it is dropped.
    expect(slots.length).toBe(12);
    const first = slots[0];
    expect(first.title).toBe('TRT Spor Yıldız Ortak Yayın');
    expect(first.start).toBe('2026-09-09T00:00:00+03:00');
    expect(first.stop).toBe('2026-09-09T09:30:00+03:00');
    expect(first.category).toBe('Spor');
    expect(slots.every((s) => s.title.length > 0)).toBe(true);
    expect(slots.every((s) => s.start.endsWith('+03:00'))).toBe(true);
    expect(slots[slots.length - 1].title).toBe('Liverpool - Atletico Madrid');
    expect(parsePlaybill('not json')).toEqual([]);
    expect(parsePlaybill(undefined)).toEqual([]);
  });

  it('parsePlaybill drops slots with out-of-clock or missing times', () => {
    const slots = parsePlaybill(
      JSON.stringify({
        playbilllist: [
          {
            name: 'Ok',
            starttime: '2026-09-09 10:00:00 UTC+03:00',
            endtime: '2026-09-09 11:00:00 UTC+03:00',
          },
          {
            name: 'Bogus Hours',
            starttime: '2026-09-09 25:00:00 UTC+03:00',
            endtime: '2026-09-09 26:00:00 UTC+03:00',
          },
          {
            name: 'Bogus Minutes',
            starttime: '2026-09-09 10:99:00 UTC+03:00',
            endtime: '2026-09-09 11:00:00 UTC+03:00',
          },
          { name: 'No Times', starttime: 'garbage', endtime: 'garbage' },
          { name: null, starttime: '2026-09-09 10:00:00 UTC+03:00', endtime: '2026-09-09 11:00:00 UTC+03:00' },
        ],
      })
    );
    expect(slots).toHaveLength(1);
    expect(slots[0].title).toBe('Ok');
    expect(slots[0].start).toBe('2026-09-09T10:00:00+03:00');
  });

  it('extractSessionCookie reads XSESSIONID/JSESSIONID pairs', () => {
    const cookie = extractSessionCookie({ headers: SESSION_HEADERS });
    expect(cookie).toContain('XSESSIONID=TEST123');
    expect(cookie).toContain('JSESSIONID=TEST123');
    expect(extractSessionCookie({ headers: {} })).toBeUndefined();
    expect(extractSessionCookie({})).toBeUndefined();
  });

  it('maps display names to epgshare01 ids', () => {
    expect(mapChannelId('TRT SPOR')).toBe('TRT.SPOR.tr');
    expect(mapChannelId('tabii spor')).toBe('TABII.SPOR.tr');
    expect(mapChannelId('S SPORT 2')).toBe('SSport.2.tr');
    expect(mapChannelId('TV8,5')).toBe('TV8.5.tr');
    expect(mapChannelId('BEIN SPORTS 1')).toBeUndefined(); // not on TV+
    expect(normalizeChannelKey('  trt   spor ')).toBe('TRT SPOR');
  });

  it('every curated channel id carries the .tr suffix', () => {
    for (const channel of CHANNELS) {
      expect(channel.id.endsWith('.tr')).toBe(true);
      expect(channel.tvId).toMatch(/^\d+$/);
    }
  });
});

describe('tvplus scrape (stubbed json api)', () => {
  it('authenticates and scrapes one channel for one date', async () => {
    const seenCookies = [];
    const fetchImpl = async (url, options) => {
      expect(options.method).toBe('POST');
      if (url.includes('/get-platform-info')) return jsonResponse(platformInfo);
      if (url.endsWith('/EPG/JSON/Authenticate')) return jsonResponse('{}', SESSION_HEADERS);
      if (url.endsWith('/EPG/JSON/PlayBillList')) {
        const body = JSON.parse(options.body);
        // maxChannels 1 -> the first configured channel (TRT 1, tvId 144).
        expect(body.channelid).toBe('144');
        expect(body.begintime).toBe('20260909000000');
        expect(body.endtime).toBe('20260909235959');
        seenCookies.push(options.headers.cookie);
        return jsonResponse(playbill4399);
      }
      throw new Error(`unexpected url ${url}`);
    };

    const logs = [];
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl,
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
      maxChannels: 1,
    });

    expect(result.days).toBe(1);
    expect(result.failures).toBe(0);
    expect(result.channels).toHaveLength(1);
    expect(result.channels[0].id).toBe('TRT.1.tr');
    expect(result.programmes.length).toBe(12);
    expect(result.programmes.every((p) => p.channel === 'TRT.1.tr')).toBe(true);
    // The session cookie captured at Authenticate must be sent with PlayBillList.
    expect(seenCookies).toHaveLength(1);
    expect(seenCookies[0]).toContain('XSESSIONID=TEST123');
    expect(logs.some((l) => l.startsWith('ok:'))).toBe(true);
  });

  it('degrades gracefully when discovery fails', async () => {
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl: async () => {
        throw new Error('HTTP 503');
      },
      log: () => {},
      politenessDelayMs: 0,
    });
    expect(result.channels).toEqual([]);
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(1);
  });

  it('counts per-request failures and skips empty playbills', async () => {
    const fetchImpl = async (url) => {
      if (url.includes('/get-platform-info')) return jsonResponse(platformInfo);
      if (url.endsWith('/EPG/JSON/Authenticate')) return jsonResponse('{}', SESSION_HEADERS);
      if (url.endsWith('/EPG/JSON/PlayBillList')) {
        return jsonResponse('{"counttotal":"0","playbilllist":[]}');
      }
      throw new Error('boom');
    };
    const result = await scrape({
      dates: ['2026-09-09'],
      fetchImpl,
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 2,
    });
    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(0);
    expect(result.channels).toHaveLength(2);
  });
});

describe('tvplus cli integration (stubbed fetch, temp output)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-scraper-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  it('writes a gzipped xmltv file and reports success', async () => {
    const { default: fs } = await import('node:fs');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (url.includes('/get-platform-info')) return jsonResponse(platformInfo);
      if (url.endsWith('/EPG/JSON/Authenticate')) return jsonResponse('{}', SESSION_HEADERS);
      if (url.endsWith('/EPG/JSON/PlayBillList')) return jsonResponse(playbill4399);
      throw new Error(`unexpected url ${url}`);
    };
    try {
      const out = path.join(tmpDir, 'tvplus.xml.gz');
      const stdout = [];
      const exit = await runCli({
        argv: [
          '--provider', 'tvplus',
          '--out', out,
          '--date', '2026-09-09',
          '--days-forward', '0',
          '--max-channels', '1',
          '--delay-ms', '0',
          '--quiet',
        ],
        stdout: { write: (s) => stdout.push(s) },
        stderr: { write: (s) => stdout.push(s) },
        cwd: tmpDir,
      });
      expect(exit).toBe(0);
      expect(fs.existsSync(out)).toBe(true);
      expect(fs.statSync(out).size).toBeGreaterThan(500);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses to write an empty guide when the api is down', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'not json' });
    try {
      const stderr = [];
      const exit = await runCli({
        argv: [
          '--provider', 'tvplus',
          '--out', path.join(tmpDir, 'none.xml.gz'),
          '--quiet',
        ],
        stdout: { write: () => {} },
        stderr: { write: (s) => stderr.push(s) },
        cwd: tmpDir,
      });
      expect(exit).toBe(1);
      expect(stderr.join('')).toMatch(/nothing scraped|api base|authenticat/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});