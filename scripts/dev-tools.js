#!/usr/bin/env node
/**
 * dev-tools.js — unified lifecycle for the epg-scraper development stack.
 *
 * One CLI manages every detached background service the scraper harness
 * and browser experiments need: the shared headless Chromium (Playwright)
 * for browser-mode scraping, and a lightweight static file server for
 * previewing EPG output and test fixtures.  Both are launched detached
 * (own process group, pidfile + log under the state dir) so they survive
 * the launching call — the same pattern as the sports-tv dev-tools.
 *
 * Usage:
 *   node scripts/dev-tools.js install [service]     # fetch prerequisites
 *   node scripts/dev-tools.js start  [service|all]  # launch detached (default: all)
 *   node scripts/dev-tools.js stop   [service|all]  # SIGTERM the recorded tree
 *   node scripts/dev-tools.js status [service|all]  # health-check (default: all)
 *   node scripts/dev-tools.js logs <service>        # tail the service log
 *
 * Services: browser (Playwright Chromium CDP), server (static file server).
 *
 * Env:
 *   DEV_STATE_DIR        pidfile/log directory (default ~/.cache/epg-scraper)
 *   CHROME_DEBUG_HOST    CDP bind address (default 127.0.0.1)
 *   CHROME_DEBUG_PORT    CDP port (default 9222)
 *   CHROME_CACHE_DIR     browser binary/profile cache (default ~/.cache/ms-playwright)
 *   SERVER_PORT          static server port (default 8080)
 *   SERVER_ROOT          static server document root (default project root)
 */

'use strict';

import { spawn } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const STATE_DIR = process.env.DEV_STATE_DIR ||
  path.join(os.homedir(), '.cache', 'epg-scraper');
const CHROME_CACHE = process.env.CHROME_CACHE_DIR ||
  path.join(os.homedir(), '.cache', 'ms-playwright');
const CHROME_HOST = process.env.CHROME_DEBUG_HOST || '127.0.0.1';
const CHROME_PORT = parseInt(process.env.CHROME_DEBUG_PORT || '9222', 10);
const SERVER_PORT = parseInt(process.env.SERVER_PORT || '8080', 10);
const SERVER_ROOT = process.env.SERVER_ROOT || ROOT;

// ---------------------------------------------------------------------------
// Service registry — the whole tool is driven by this table.
// ---------------------------------------------------------------------------

const SERVICES = {
  browser: {
    name: 'browser',
    tag: '[browser]',
    desc: 'shared headless Chromium for browser-mode EPG scraping',
    installable: true,
    endpoints: () => [
      { name: 'CDP', url: 'http://' + CHROME_HOST + ':' + CHROME_PORT + '/json/version', kind: 'json' },
    ],
    spawn: async () => {
      const bin = await resolveBrowser();
      const profile = path.join(CHROME_CACHE, 'epg-scraper-shared-profile');
      return {
        file: bin,
        args: [
          '--headless=new',
          '--no-sandbox',            // container/root dev environment
          '--disable-dev-shm-usage', // docker /tmp often small
          '--disable-gpu',
          '--mute-audio',
          '--hide-scrollbars',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-networking',
          '--disable-extensions',
          '--window-size=1920,1080',
          '--remote-debugging-address=' + CHROME_HOST,
          '--remote-debugging-port=' + CHROME_PORT,
          '--user-data-dir=' + profile,
          'about:blank',
        ],
        cwd: os.tmpdir(),
        env: process.env,
        // A stale singleton lock can block a new launch after a crash.
        pre: () => {
          try {
            const lock = path.join(profile, 'SingletonLock');
            if (fs.existsSync(lock)) fs.unlinkSync(lock);
          } catch (e) { /* ignore */ }
        },
        readyTimeout: 15000,
      };
    },
  },

  server: {
    name: 'server',
    tag: '[server]',
    desc: 'static file server for EPG output and test fixtures',
    endpoints: () => [
      { name: 'http', url: 'http://' + HOST + ':' + SERVER_PORT + '/', kind: 'http' },
    ],
    spawn: async () => ({
      file: process.execPath,
      args: ['scripts/scraper-server.js'],
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        SERVER_PORT: String(SERVER_PORT),
        SERVER_ROOT: SERVER_ROOT,
      }),
      readyTimeout: 8000,
    }),
  },
};

const SERVICE_NAMES = Object.keys(SERVICES);

// ---------------------------------------------------------------------------
// Shared machinery
// ---------------------------------------------------------------------------

function pidPath(name) { return path.join(STATE_DIR, name + '.pid'); }
function logPath(name) { return path.join(STATE_DIR, name + '.log'); }

/** HTTP GET a URL. kind 'json' resolves the parsed body (or null when the
 *  endpoint is not a CDP-style blob); kind 'http' resolves the status code.
 *  Any error/timeout resolves null (down). */
function probe(url, kind) {
  return new Promise(resolve => {
    const req = http.get(url, res => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => {
        if (kind === 'json') {
          try {
            const j = JSON.parse(body);
            resolve(j && j.webSocketDebuggerUrl ? j : null);
          } catch (e) { resolve(null); }
        } else {
          resolve(res.statusCode);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}

function recordedPid(name) {
  try { return parseInt(fs.readFileSync(pidPath(name), 'utf8'), 10); } catch (e) { return null; }
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/** Any still-alive pid recorded for the service. */
function findLivePid(name) {
  const file = pidPath(name);
  try {
    const pid = parseInt(fs.readFileSync(file, 'utf8'), 10);
    if (pid && pidAlive(pid)) return { pid: pid, file: file };
  } catch (e) { /* missing/unreadable */ }
  return null;
}

/** Health-check one service: print OK/DOWN lines, resolve true when every
 *  endpoint answers. */
async function health(name) {
  const svc = SERVICES[name];
  const eps = svc.endpoints();
  const results = await Promise.all(eps.map(ep => probe(ep.url, ep.kind)));
  const allUp = results.every(r => r !== null);
  if (allUp) {
    results.forEach((r, i) => {
      const ep = eps[i];
      const extra = ep.kind === 'json' && r && r.Browser
        ? ' ' + String(r.Browser).replace(/\s+/g, ' ')
        : ep.kind === 'http' ? ' (HTTP ' + r + ')' : '';
      console.log(svc.tag + ' OK  ' + ep.name + '  ' + ep.url + extra);
    });
  } else {
    results.forEach((r, i) => {
      const ep = eps[i];
      console.error(svc.tag + ' DOWN  ' + ep.name + '  ' + ep.url +
        '  ' + (r !== null ? (ep.kind === 'json' ? 'not a CDP endpoint' : 'HTTP ' + r) : 'unreachable'));
    });
    console.error(svc.tag + ' start it with: node scripts/dev-tools.js start ' + name);
  }
  return allUp;
}

/** Detach-spawn the service command, write the pidfile, poll endpoints until
 *  ready (or the per-service deadline). Resolves true when ready. */
async function startOne(name) {
  const svc = SERVICES[name];
  const existing = findLivePid(name);
  if (existing) {
    console.log(svc.tag + ' already running — pid ' + existing.pid);
    console.log(svc.tag + ' log: ' + logPath(name));
    return true;
  }

  const cmd = await svc.spawn();
  if (cmd.pre) cmd.pre();
  console.log(svc.tag + ' launching → ' + svc.endpoints().map(e => e.url).join(' + '));

  fs.mkdirSync(STATE_DIR, { recursive: true });
  const logFd = fs.openSync(logPath(name), 'a');
  const child = spawn(cmd.file, cmd.args, {
    cwd: cmd.cwd,
    detached: true, // own process group: a SIGTERM to -pid reaches the whole tree
    stdio: ['ignore', logFd, logFd],
    env: cmd.env,
  });
  child.unref();

  try { fs.writeFileSync(pidPath(name), String(child.pid)); } catch (e) { /* non-fatal */ }

  const deadline = Date.now() + cmd.readyTimeout;
  const eps = svc.endpoints();
  return await new Promise(resolve => {
    const poll = setInterval(async () => {
      const results = await Promise.all(eps.map(ep => probe(ep.url, ep.kind)));
      if (results.every(r => r !== null)) {
        clearInterval(poll);
        console.log(svc.tag + ' ready — pid ' + child.pid);
        console.log(svc.tag + ' log: ' + logPath(name));
        resolve(true);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        console.error(svc.tag + ' timed out waiting for ' +
          eps.map((ep, i) => ep.name + ' (' + (results[i] !== null ? 'up' : 'down') + ')').join(', '));
        console.error(svc.tag + ' log tail: ' + logPath(name));
        resolve(false);
      }
    }, 400);
  });
}

function stopOne(name) {
  const svc = SERVICES[name];
  const found = findLivePid(name);
  if (!found) {
    console.log(svc.tag + ' no running pidfile — nothing to stop');
    return;
  }
  let signaled = false;
  try { process.kill(found.pid, 'SIGTERM'); signaled = true; } catch (e) { /* stale */ }
  // SIGTERM the process GROUP (-pid) too, so the whole tree dies even when the
  // recorded leader is gone but a detached descendant still holds the ports.
  try { process.kill(-found.pid, 'SIGTERM'); } catch (e) { /* no group left */ }
  console.log(svc.tag + ' sent SIGTERM to ' +
    (signaled ? 'pid ' + found.pid : 'group of pid ' + found.pid));
  try { fs.unlinkSync(found.file); } catch (e) { /* ignore */ }
}

function tailLog(name) {
  const svc = SERVICES[name];
  const file = logPath(name);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    console.error(svc.tag + ' no log yet: ' + file + '  (start the service first)');
    process.exit(1);
  }
  const lines = text.split('\n').filter(Boolean);
  const tail = lines.slice(-40).join('\n');
  console.log(svc.tag + ' log: ' + file);
  console.log('----');
  console.log(tail || '(empty)');
}

// ---------------------------------------------------------------------------
// Browser binary resolution (install on demand)
// ---------------------------------------------------------------------------

/** Resolve the Chromium executable, installing it when missing via Playwright.
 *  The binary lands in CHROME_CACHE so Playwright can reuse it. */
async function resolveBrowser() {
  // Use playwright's own installed Chromium if available.
  try {
    const pw = await import('playwright');
    if (pw.chromium && typeof pw.chromium.executablePath === 'function') {
      const bin = pw.chromium.executablePath();
      if (bin && fs.existsSync(bin)) return bin;
    }
  } catch (e) { /* playwright not installed — fall through */ }

  // Try @playwright/browser for standalone resolution.
  try {
    const pwb = await import('@playwright/browser');
    if (pwb.chromium && typeof pwb.chromium.executablePath === 'function') {
      const bin = pwb.chromium.executablePath();
      if (bin && fs.existsSync(bin)) return bin;
    }
  } catch (e) { /* not available */ }

  // Nothing found — guide the user.
  console.error('[browser] Chromium not found.  Install with:');
  console.error('  npm install playwright');
  console.error('  npx playwright install chromium');
  console.error('  — or — npm run install:playwright');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.error('usage: node scripts/dev-tools.js (install|start|stop|status|logs) [service|all]');
  console.error('  services: ' + SERVICE_NAMES.join(', ') + '   (start/stop/status default: all)');
  process.exit(2);
}

function resolveTargets(arg, allowAll) {
  if (!arg || arg === 'all') {
    if (!allowAll) usage();
    return SERVICE_NAMES;
  }
  if (SERVICE_NAMES.indexOf(arg) < 0) usage();
  return [arg];
}

async function main() {
  const verb = process.argv[2];
  const arg = process.argv[3];
  if (!verb) usage();

  if (verb === 'install') {
    const targets = resolveTargets(arg, false);
    for (const name of targets) {
      const svc = SERVICES[name];
      if (!svc.installable) {
        console.error(svc.tag + ' nothing to install');
        process.exit(2);
      }
      await resolveBrowser();
      console.log(svc.tag + ' ready');
    }
    return;
  }

  if (verb === 'start' || verb === 'up') {
    const targets = resolveTargets(arg, true);
    let allOk = true;
    for (const name of targets) allOk = (await startOne(name)) && allOk;
    process.exit(allOk ? 0 : 1);
  }

  if (verb === 'stop' || verb === 'down') {
    const targets = resolveTargets(arg, true);
    targets.forEach(stopOne);
    return;
  }

  if (verb === 'status' || verb === 'check') {
    const targets = resolveTargets(arg, true);
    const states = await Promise.all(targets.map(health));
    process.exit(states.every(Boolean) ? 0 : 1);
  }

  if (verb === 'logs') {
    const targets = resolveTargets(arg, false);
    targets.forEach(tailLog);
    return;
  }

  usage();
}

main().catch(err => {
  console.error('fatal:', err && err.message ? err.message : err);
  process.exit(1);
});
