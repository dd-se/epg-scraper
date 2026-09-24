import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';
import {
  buildEventsUrl,
  parseApiEnvelope,
  parseDayEvents,
  scrape,
} from '../src/providers/sporekraniapi.js';
import { CHANNELS } from '../src/providers/sporekrani.js';

const dayFixture = readFileSync(
  fileURLToPath(new URL('./fixtures/sporekraniapi/2026-09-30.json', import.meta.url)),
  'utf8'
);
const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => body,
});

describe('sporekraniapi API contract', () => {
  it('builds the authenticated events URL and unwraps the data envelope', () => {
    const url = new URL(
      buildEventsUrl('2026-09-30', { appId: 'test-app', apiKey: 'test-key' })
    );

    expect(url.origin).toBe('https://api.sporekrani.com');
    expect(url.pathname).toBe('/v3/events');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      app_id: 'test-app',
      api_key: 'test-key',
      day: '2026-09-30',
    });
    expect(parseApiEnvelope('{"data":[{"id":485823}]}')).toEqual([{ id: 485823 }]);
  });

  it('degrades malformed and non-array envelopes to an empty event list', () => {
    expect(parseApiEnvelope('<html>maintenance</html>')).toEqual([]);
    expect(parseApiEnvelope('')).toEqual([]);
    expect(parseApiEnvelope(null)).toEqual([]);
    expect(parseApiEnvelope('[]')).toEqual([]);
    expect(parseApiEnvelope('{"data":{"id":1}}')).toEqual([]);
    expect(parseApiEnvelope('{"events":[]}')).toEqual([]);
    expect(parseDayEvents(parseApiEnvelope('{"data":17}'), '2026-09-30')).toEqual({
      slots: [],
      channelIcons: new Map(),
    });
  });

  it('rejects invalid or non-canonical API days before building a request', () => {
    const credentials = { appId: 'test-app', apiKey: 'test-key' };
    for (const day of ['2026-02-30', '2026-13-01', '2026-00-10', 'not-a-date', '2026-9-3', '20260930']) {
      expect(() => buildEventsUrl(day, credentials)).toThrow(/Invalid API day/);
    }
    expect(() => buildEventsUrl('2026-09-30', credentials)).not.toThrow();
  });

  it('parses only valid, same-day slots owned by a curated channel', () => {
    const events = parseApiEnvelope(
      JSON.stringify({
        data: [
          {
            id: 1,
            name: 'Panathinaikos - Asvel Villeurbanne',
            date_time: '2026-09-30 21:15:00',
            sport_name: 'Basketbol',
            channels: [
              {
                name: 'S Sport Plus',
                icon: 'https://img.sporekrani.com/channels/valid.png',
              },
            ],
          },
          {
            id: 2,
            name: 'Shared simulcast',
            date_time: '2026-09-30 22:00:00',
            sport_name: 'Futbol',
            channels: [{ name: 'tabii Spor 1' }, { name: 'tabii Spor 2' }],
          },
          {
            id: 3,
            name: 'Impossible clock',
            date_time: '2026-09-30 24:30:00',
            channels: [{ name: 'S Sport Plus' }],
          },
          {
            id: 4,
            name: 'Wrong response day',
            date_time: '2026-10-09 19:30:00',
            channels: [{ name: 'S Sport Plus' }],
          },
        ],
      }),
      '2026-09-30'
    );

    expect(parseDayEvents(events, '2026-09-30')).toEqual({
      slots: [
        {
          channel: 'S.SPORT.PLUS.tr',
          date: '2026-09-30',
          startMin: 21 * 60 + 15,
          title: 'Panathinaikos - Asvel Villeurbanne',
          category: 'Basketbol',
        },
        {
          channel: 'TABII.SPOR.1.tr',
          date: '2026-09-30',
          startMin: 22 * 60,
          title: 'Shared simulcast',
          category: 'Futbol',
        },
        {
          channel: 'TABII.SPOR.2.tr',
          date: '2026-09-30',
          startMin: 22 * 60,
          title: 'Shared simulcast',
          category: 'Futbol',
        },
      ],
      channelIcons: new Map([
        ['S.SPORT.PLUS.tr', 'https://img.sporekrani.com/channels/valid.png'],
      ]),
    });
  });
});

describe('sporekraniapi scrape', () => {
  const originalAppId = process.env.SPOREKRANI_API_APP_ID;
  const originalApiKey = process.env.SPOREKRANI_API_KEY;

  beforeEach(() => {
    process.env.SPOREKRANI_API_APP_ID = 'test-app';
    process.env.SPOREKRANI_API_KEY = 'test-key';
  });

  afterEach(() => {
    if (originalAppId == null) delete process.env.SPOREKRANI_API_APP_ID;
    else process.env.SPOREKRANI_API_APP_ID = originalAppId;
    if (originalApiKey == null) delete process.env.SPOREKRANI_API_KEY;
    else process.env.SPOREKRANI_API_KEY = originalApiKey;
  });

  it('fetches once per day and stops the final event at that day midnight', async () => {
    const requests = [];
    const result = await scrape({
      dates: ['2026-09-30'],
      fetchImpl: async (url, options) => {
        requests.push({ url: String(url), options });
        return response(dayFixture);
      },
      log: () => {},
      politenessDelayMs: 0,
    });

    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(new URL(requests[0].url).searchParams)).toEqual({
      app_id: 'test-app',
      api_key: 'test-key',
      day: '2026-09-30',
    });
    expect(requests[0].options.headers.accept).toContain('application/json');
    expect(requests[0].options.headers['user-agent']).toContain('Mozilla/5.0');
    expect(result.channels).toHaveLength(9);
    expect(result.channels.find((channel) => channel.id === 'S.SPORT.PLUS.tr')).toEqual({
      id: 'S.SPORT.PLUS.tr',
      name: 'S Sport Plus',
      icon: 'https://img.sporekrani.com/channels/s-sport-plus.png',
    });
    expect(result.programmes).toEqual([
      {
        channel: 'S.SPORT.PLUS.tr',
        start: '2026-09-30T21:05:00+03:00',
        stop: '2026-09-30T21:15:00+03:00',
        title: 'Maccabi Fox - Beşiktaş',
        category: 'Basketbol',
      },
      {
        channel: 'S.SPORT.PLUS.tr',
        start: '2026-09-30T21:15:00+03:00',
        stop: '2026-10-01T00:00:00+03:00',
        title: 'Panathinaikos - Asvel Villeurbanne',
        category: 'Basketbol',
      },
    ]);
    expect(result.failures).toBe(0);
  });

  it('keeps valid programmes when one date in the window fails', async () => {
    const requestedDays = [];
    const result = await scrape({
      dates: ['2026-09-29', '2026-09-30', '2026-10-01'],
      fetchImpl: async (url) => {
        const day = new URL(url).searchParams.get('day');
        requestedDays.push(day);
        if (day === '2026-09-30') return response('Not Found', { ok: false, status: 404 });
        return response(
          JSON.stringify({
            data: [
              {
                name: `Survives ${day}`,
                date_time: `${day} 20:00:00`,
                sport_name: 'Basketbol',
                channels: [{ name: 'S Sport Plus' }],
              },
            ],
          })
        );
      },
      log: () => {},
      politenessDelayMs: 0,
      fetchOptions: { retries: 0 },
    });

    expect(requestedDays).toEqual(['2026-09-29', '2026-09-30', '2026-10-01']);
    expect(result.failures).toBe(1);
    expect(result.programmes).toEqual([
      {
        channel: 'S.SPORT.PLUS.tr',
        start: '2026-09-29T20:00:00+03:00',
        stop: '2026-09-30T00:00:00+03:00',
        title: 'Survives 2026-09-29',
        category: 'Basketbol',
      },
      {
        channel: 'S.SPORT.PLUS.tr',
        start: '2026-10-01T20:00:00+03:00',
        stop: '2026-10-02T00:00:00+03:00',
        title: 'Survives 2026-10-01',
        category: 'Basketbol',
      },
    ]);
  });

  it('applies maxChannels by locally filtering the shared day response', async () => {
    const result = await scrape({
      dates: ['2026-09-30'],
      fetchImpl: async () => response(dayFixture),
      log: () => {},
      politenessDelayMs: 0,
      maxChannels: 8,
    });

    expect(result.channels).toEqual(
      CHANNELS.slice(0, 8).map((channel) => ({ id: channel.id, name: channel.name }))
    );
    expect(result.programmes).toEqual([]);
  });

  it('treats a malformed response body as an empty day, not a failure', async () => {
    const logs = [];
    const result = await scrape({
      dates: ['2026-09-30'],
      fetchImpl: async () => response('<html>maintenance</html>'),
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
    });

    expect(result.failures).toBe(0);
    expect(result.programmes).toEqual([]);
    expect(logs.join('\n')).toContain('2026-09-30: 0 programme starts');
  });

  it('fails before fetching when API credentials are missing', async () => {
    await expect(
      scrape({
        dates: ['2026-09-30'],
        fetchImpl: async () => {
          throw new Error('must not fetch');
        },
        env: {},
      })
    ).rejects.toThrow('SPOREKRANI_API_APP_ID is required');
  });

  it('warns per failed day without exposing credentials', async () => {
    const logs = [];
    const result = await scrape({
      dates: ['2026-09-30'],
      fetchImpl: async () => response('Unauthorized', { ok: false, status: 401 }),
      log: (line) => logs.push(line),
      politenessDelayMs: 0,
      fetchOptions: { retries: 0 },
    });

    expect(result.programmes).toEqual([]);
    expect(result.failures).toBe(1);
    expect(logs.join('\n')).toContain('2026-09-30 request failed: HTTP 401');
    expect(logs.join('\n')).not.toContain('test-key');
    expect(logs.join('\n')).not.toContain('test-app');
  });
});

describe('sporekraniapi CLI integration', () => {
  let tmpDir;
  const originalFetch = globalThis.fetch;
  const originalAppId = process.env.SPOREKRANI_API_APP_ID;
  const originalApiKey = process.env.SPOREKRANI_API_KEY;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-sporekraniapi-test-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
    process.env.SPOREKRANI_API_APP_ID = 'test-app';
    process.env.SPOREKRANI_API_KEY = 'test-key';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalAppId == null) delete process.env.SPOREKRANI_API_APP_ID;
    else process.env.SPOREKRANI_API_APP_ID = originalAppId;
    if (originalApiKey == null) delete process.env.SPOREKRANI_API_KEY;
    else process.env.SPOREKRANI_API_KEY = originalApiKey;
  });

  it('writes a gzipped single-provider guide', async () => {
    globalThis.fetch = async () => response(dayFixture);
    const out = path.join(tmpDir, 'sporekraniapi.xml.gz');
    const exit = await runCli({
      argv: [
        '--provider', 'sporekraniapi',
        '--date', '2026-09-30',
        '--out', out,
        '--delay-ms', '0',
        '--quiet',
      ],
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    expect(existsSync(out)).toBe(true);
    const xml = gunzipSync(readFileSync(out)).toString('utf8');
    expect(xml).toContain('generator-info-name="epg-scraper (sporekraniapi)"');
    expect(xml).toContain('start="20260930211500 +0300" stop="20261001000000 +0300"');
  });

  it('refuses to write an empty guide when every API response has no relevant events', async () => {
    globalThis.fetch = async () => response('{"data":[]}');
    const stderr = [];
    const out = path.join(tmpDir, 'none.xml.gz');
    const exit = await runCli({
      argv: [
        '--provider', 'sporekraniapi',
        '--date', '2026-09-30',
        '--out', out,
        '--delay-ms', '0',
        '--quiet',
      ],
      stdout: { write: () => {} },
      stderr: { write: (line) => stderr.push(line) },
      cwd: tmpDir,
    });

    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/nothing scraped/);
    expect(existsSync(out)).toBe(false);
  });

  it('rejects --browser before scraping because the source is a JSON API', async () => {
    globalThis.fetch = async () => {
      throw new Error('must not fetch');
    };
    const stderr = [];
    const out = path.join(tmpDir, 'browser.xml.gz');
    const exit = await runCli({
      argv: [
        '--provider', 'sporekraniapi',
        '--date', '2026-09-30',
        '--browser',
        '--out', out,
        '--quiet',
      ],
      stdout: { write: () => {} },
      stderr: { write: (line) => stderr.push(line) },
      cwd: tmpDir,
    });

    expect(exit).toBe(1);
    expect(stderr.join('')).toMatch(/HTTP-only and cannot use browser transport/);
    expect(existsSync(out)).toBe(false);
  });

  it('keeps credentials out of CLI output when every request fails', async () => {
    globalThis.fetch = async () => response('Unauthorized', { ok: false, status: 401 });
    const stdout = [];
    const stderr = [];
    const out = path.join(tmpDir, 'unauthorized.xml.gz');
    const exit = await runCli({
      argv: [
        '--provider', 'sporekraniapi',
        '--date', '2026-09-30',
        '--out', out,
        '--delay-ms', '0',
        '--retries', '0',
      ],
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: (line) => stderr.push(line) },
      cwd: tmpDir,
    });

    expect(exit).toBe(1);
    expect(existsSync(out)).toBe(false);
    const output = stdout.join('') + stderr.join('');
    expect(output).toContain('HTTP 401');
    expect(output).not.toContain('test-app');
    expect(output).not.toContain('test-key');
  });

  it('keeps both adapters available to the two-provider comparison mode', async () => {
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('https://api.sporekrani.com/v3/events')) {
        return response(dayFixture);
      }
      const state = { common: { events: JSON.parse(dayFixture).data } };
      return response(`<script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`);
    };
    const stdout = [];
    const exit = await runCli({
      argv: [
        '--provider', 'sporekrani,sporekraniapi',
        '--compare',
        '--date', '2026-09-30',
        '--out', path.join(tmpDir, 'benchmark'),
        '--delay-ms', '0',
      ],
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: () => {} },
      cwd: tmpDir,
    });

    expect(exit).toBe(0);
    expect(stdout.join('')).toContain('compare providers: sporekrani vs sporekraniapi');
    expect(existsSync(path.join(tmpDir, 'benchmark.sporekrani.xml.gz'))).toBe(true);
    expect(existsSync(path.join(tmpDir, 'benchmark.sporekraniapi.xml.gz'))).toBe(true);
  });
});
