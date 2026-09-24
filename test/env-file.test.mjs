// Tests for the optional `.env` loader and its CLI wiring.  No network: the
// sporekraniapi provider is driven by a stubbed fetchImpl and a fixed date,
// like the other provider suites (see AGENTS.md).
//
// The CLI flag is `--dotenv`, not `--env-file`: Node parses `--env-file` (and
// `--env-file-if-exists`) anywhere in argv — even after the script path — so
// that name never reaches the CLI's own parser.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyEnv, readEnvFile } from '../src/env-file.js';
import { runCli } from '../src/cli.js';

const dayFixture = readFileSync(
  fileURLToPath(new URL('./fixtures/sporekraniapi/2026-09-30.json', import.meta.url)),
  'utf8'
);
const response = (body, { ok = true, status = 200 } = {}) => ({
  ok,
  status,
  text: async () => body,
});

describe('env file parsing', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-env-file-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('parses comments, quotes, export prefixes and blank values', () => {
    const file = path.join(tmpDir, '.env');
    writeFileSync(
      file,
      [
        '# a comment',
        '',
        'PLAIN=value',
        'export EXPORTED="quoted value"',
        "SINGLE='single quoted'",
        'EMPTY=',
      ].join('\n')
    );

    expect(readEnvFile(file)).toEqual({
      PLAIN: 'value',
      EXPORTED: 'quoted value',
      SINGLE: 'single quoted',
      EMPTY: '',
    });
  });

  it('returns undefined for a missing file and a readable error for an unreadable path', () => {
    expect(readEnvFile(path.join(tmpDir, 'absent.env'))).toBeUndefined();
    expect(() => readEnvFile(tmpDir)).toThrow(/cannot read/);
  });

  it('applies only names that the environment does not already define', () => {
    const target = { KEEP: 'original' };
    const applied = applyEnv({ KEEP: 'from-file', FRESH: 'from-file' }, { target });

    expect(applied).toEqual(['FRESH']);
    expect(target).toEqual({ KEEP: 'original', FRESH: 'from-file' });
  });

  it('ignores a __proto__ entry instead of rewiring the target', () => {
    const target = {};
    const applied = applyEnv(JSON.parse('{"__proto__": "polluted", "OK": "1"}'), { target });

    expect(applied).toEqual(['OK']);
    expect(Object.getPrototypeOf(target)).toBe(Object.prototype);
    expect(target.OK).toBe('1');
  });
});

describe('CLI env file wiring', () => {
  let tmpDir;
  let requests;
  const originalFetch = globalThis.fetch;
  const originalAppId = process.env.SPOREKRANI_API_APP_ID;
  const originalApiKey = process.env.SPOREKRANI_API_KEY;

  const scrapeArgs = [
    '--provider', 'sporekraniapi',
    '--date', '2026-09-30',
    '--days-forward', '0',
    '--out', 'guide.xml.gz',
    '--delay-ms', '0',
  ];

  beforeEach(() => {
    tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-env-cli-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
    requests = [];
    delete process.env.SPOREKRANI_API_APP_ID;
    delete process.env.SPOREKRANI_API_KEY;
    globalThis.fetch = async (url) => {
      requests.push(String(url));
      return response(dayFixture);
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(tmpDir, { recursive: true, force: true });
    if (originalAppId == null) delete process.env.SPOREKRANI_API_APP_ID;
    else process.env.SPOREKRANI_API_APP_ID = originalAppId;
    if (originalApiKey == null) delete process.env.SPOREKRANI_API_KEY;
    else process.env.SPOREKRANI_API_KEY = originalApiKey;
  });

  const run = (argv, { stdout, stderr } = {}) =>
    runCli({
      argv,
      stdout: stdout ?? { write: () => {} },
      stderr: stderr ?? { write: () => {} },
      cwd: tmpDir,
    });

  const requestParams = () => Object.fromEntries(new URL(requests[0]).searchParams);

  it('loads ./.env so a provider can read credentials without shell variables', async () => {
    writeFileSync(
      path.join(tmpDir, '.env'),
      'SPOREKRANI_API_APP_ID=from-file\nSPOREKRANI_API_KEY=from-file-key\n'
    );
    const stdout = [];
    const exit = await run(scrapeArgs, { stdout: { write: (line) => stdout.push(line) } });

    expect(exit).toBe(0);
    expect(existsSync(path.join(tmpDir, 'guide.xml.gz'))).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requestParams()).toMatchObject({ app_id: 'from-file', api_key: 'from-file-key' });
    expect(stdout.join('')).toContain('env: .env: applied 2/2 variable(s)');
  });

  it('keeps real environment values when .env disagrees', async () => {
    process.env.SPOREKRANI_API_APP_ID = 'from-shell';
    writeFileSync(
      path.join(tmpDir, '.env'),
      'SPOREKRANI_API_APP_ID=from-file\nSPOREKRANI_API_KEY=from-file-key\n'
    );
    const stdout = [];
    const exit = await run(scrapeArgs, { stdout: { write: (line) => stdout.push(line) } });

    expect(exit).toBe(0);
    expect(requestParams()).toMatchObject({ app_id: 'from-shell', api_key: 'from-file-key' });
    expect(stdout.join('')).toContain('applied 1/2 variable(s) (existing environment values kept)');
  });

  it('reads the file named by --dotenv', async () => {
    writeFileSync(
      path.join(tmpDir, 'local.env'),
      'SPOREKRANI_API_APP_ID=from-named\nSPOREKRANI_API_KEY=from-named-key\n'
    );
    const exit = await run([...scrapeArgs, '--dotenv', 'local.env', '--quiet']);

    expect(exit).toBe(0);
    expect(requestParams()).toMatchObject({ app_id: 'from-named', api_key: 'from-named-key' });
  });

  it('rejects a missing --dotenv before any request', async () => {
    const stderr = [];
    const exit = await run([...scrapeArgs, '--dotenv', 'absent.env'], {
      stderr: { write: (line) => stderr.push(line) },
    });

    expect(exit).toBe(1);
    expect(stderr.join('')).toContain('--dotenv "absent.env" not found');
    expect(requests).toEqual([]);
    expect(existsSync(path.join(tmpDir, 'guide.xml.gz'))).toBe(false);
  });

  it('does not offer --env-file, which Node intercepts before this parser', async () => {
    // Node parses --env-file (and --env-file-if-exists) anywhere in argv, even
    // after the script path, so the CLI flag is deliberately named --dotenv.
    const stderr = [];
    const exit = await run(['--provider', 'sporekraniapi', '--env-file', 'local.env'], {
      stderr: { write: (line) => stderr.push(line) },
    });

    expect(exit).toBe(1);
    expect(stderr.join('')).toContain("Unknown option '--env-file'");
    expect(requests).toEqual([]);
  });

  it('stays silent when no .env exists', async () => {
    process.env.SPOREKRANI_API_APP_ID = 'from-shell';
    process.env.SPOREKRANI_API_KEY = 'from-shell-key';
    const stdout = [];
    const exit = await run(scrapeArgs, { stdout: { write: (line) => stdout.push(line) } });

    expect(exit).toBe(0);
    expect(stdout.join('')).not.toContain('env:');
  });

  it('never prints the values it loaded', async () => {
    writeFileSync(
      path.join(tmpDir, '.env'),
      'SPOREKRANI_API_APP_ID=super-secret-id\nSPOREKRANI_API_KEY=super-secret-key\n'
    );
    const stdout = [];
    const stderr = [];
    const exit = await run(scrapeArgs, {
      stdout: { write: (line) => stdout.push(line) },
      stderr: { write: (line) => stderr.push(line) },
    });

    expect(exit).toBe(0);
    const output = stdout.join('') + stderr.join('');
    expect(output).toContain('env: .env: applied 2/2 variable(s)');
    expect(output).not.toContain('super-secret');
  });
});

