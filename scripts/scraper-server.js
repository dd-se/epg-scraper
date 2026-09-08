#!/usr/bin/env node
/**
 * scraper-server.js — lightweight static file server for epg-scraper.
 *
 * Serves the project root (EPG output files, test fixtures, docs) for
 * browser experiments and local previewing.  The dev-tools.js lifecycle
 * manager spawns this as a detached service.
 *
 * Usage:
 *   node scripts/scraper-server.js           # foreground, port 8080
 *   # (normally launched via: node scripts/dev-tools.js start server)
 *
 * Config (env):
 *   SERVER_PORT    listen port (default 8080)
 *   SERVER_ROOT    document root (default project root)
 */

'use strict';

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const HOST = '127.0.0.1';
const PORT = parseInt(process.env.SERVER_PORT || '8080', 10);
const DOCROOT = process.env.SERVER_ROOT || ROOT;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml':  'application/xml; charset=utf-8',
  '.gz':   'application/gzip',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};
const DEFAULT_MIME = 'application/octet-stream';

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body) res.end(body);
  else res.end();
}

function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, { 'Content-Type': 'text/plain' }, 'method not allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent((req.url.split('?')[0]) || '/');
  } catch (e) {
    send(res, 400, { 'Content-Type': 'text/plain' }, 'bad request');
    return;
  }

  // Resolve safely inside the document root.
  const requested = path.normalize(path.join(DOCROOT, pathname));
  if (requested !== DOCROOT && requested.indexOf(DOCROOT + path.sep) !== 0) {
    send(res, 403, { 'Content-Type': 'text/plain' }, 'forbidden');
    return;
  }

  let filePath = requested;
  try {
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      // Serve index.html from directories, or fall back to directory listing.
      const index = path.join(filePath, 'index.html');
      if (fs.existsSync(index)) {
        filePath = index;
      } else {
        // Simple directory listing.
        const entries = fs.readdirSync(filePath);
        const html = entries.map(e => '<li><a href="' +
          path.join(pathname, e).replace(/\\/g, '/') + '">' + e + '</a></li>'
        ).join('\n');
        send(res, 200, { 'Content-Type': 'text/html; charset=utf-8' },
          '<!DOCTYPE html><html><head><title>' + pathname + '</title></head>' +
          '<body><h1>' + pathname + '</h1><ul>' + html + '</ul></body></html>');
        return;
      }
    }
  } catch (e) {
    send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
    return;
  }

  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
    return;
  }
  if (!stat.isFile()) {
    send(res, 404, { 'Content-Type': 'text/plain' }, 'not found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || DEFAULT_MIME,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
  };
  if (req.method === 'HEAD') {
    send(res, 200, headers);
    return;
  }
  res.writeHead(200, headers);
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(handler);

function shutdown() {
  server.close(() => process.exit(0));
  // Force-kill after a short grace period.
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.on('error', err => {
  console.error('[server] listen error:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('[server] epg-scraper dev server');
  console.log('[server]   URL:    http://' + HOST + ':' + PORT);
  console.log('[server]   root:   ' + DOCROOT);
});
