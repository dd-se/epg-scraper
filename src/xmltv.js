// XMLTV writer emitting the exact shape of the epgshare01 TR reference file:
//
//   <tv generator-info-name="none" generator-info-url="none">
//     <channel id="KANAL.D.tr">
//       <display-name lang="tr">KANAL D</display-name>
//       <icon src="..."/>            (optional)
//       <url>http://...</url>        (optional)
//     </channel>
//     <programme start="20260907150000 +0300" stop="..." channel="KANAL.D.tr">
//       <title lang="tr">...</title>
//       <sub-title lang="tr">...</sub-title>   (optional)
//       <desc lang="tr">...</desc>             (optional)
//       <category lang="tr">...</category>     (optional)
//       <icon src="..."/>                      (optional)
//     </programme>
//
// All <programme> blocks are sorted by channel then start time, like the
// reference. Gzip output is streamed with Node's zlib.

import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { decodeEntities } from './entities.js';
import {
  isoToEpochMs,
  toXmltvTimestamp,
  fromXmltvTimestamp,
} from './time.js';
import { createGuideResult, normalizeLanguageTag, validateGuideResult } from './model.js';

export { isoToEpochMs, toXmltvTimestamp, fromXmltvTimestamp };

function esc(text) {
  const escaped = String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  // XML 1.0 forbids most C0 controls, lone surrogates and U+FFFE/U+FFFF;
  // hostile or corrupt pages can carry them.  Strip them instead of emitting
  // a guide that no XML consumer can parse — but never touch the halves of a
  // valid surrogate pair (astral characters like emoji), which are legal.
  return escaped.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/g,
    (ch, index) => {
      const code = ch.charCodeAt(0);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = escaped.charCodeAt(index + 1);
        return next >= 0xdc00 && next <= 0xdfff ? ch : ''; // valid pair: keep
      }
      if (code >= 0xdc00 && code <= 0xdfff) {
        const prev = escaped.charCodeAt(index - 1);
        return prev >= 0xd800 && prev <= 0xdbff ? ch : ''; // valid pair: keep
      }
      return '';
    }
  );
}

function element(tag, attrs = {}, children) {
  const attrText = Object.entries(attrs || {})
    .filter(([, value]) => value != null)
    .map(([name, value]) => ` ${name}="${esc(value)}"`)
    .join('');
  if (children == null) {
    return `<${tag}${attrText} />`;
  }
  return `<${tag}${attrText}>${esc(children)}</${tag}>`;
}

function programmeElement(programme, lang) {
  const lines = [
    `  <programme start="${toXmltvTimestamp(programme.start)}" stop="${toXmltvTimestamp(programme.stop)}" channel="${esc(programme.channel)}">`,
  ];
  lines.push(`    ${element('title', { lang }, programme.title)}`);
  if (programme.subTitle != null) {
    lines.push(`    ${element('sub-title', { lang }, programme.subTitle)}`);
  }
  if (programme.desc != null) listingElement('desc', programme.desc, lines, lang);
  if (programme.category != null) listingElement('category', programme.category, lines, lang);
  if (programme.icon != null) {
    lines.push(`    ${element('icon', { src: programme.icon }, null)}`);
  }
  lines.push('  </programme>');
  return lines.join('\n');
}

function listingElement(tag, value, lines, lang) {
  lines.push(`    ${element(tag, { lang }, value)}`);
}

function channelElement(channel, lang) {
  const lines = [`  <channel id="${esc(channel.id)}">`];
  lines.push(`    ${element('display-name', { lang }, channel.name)}`);
  if (channel.icon != null) {
    lines.push(`    ${element('icon', { src: channel.icon }, null)}`);
  }
  if (channel.url != null) {
    lines.push(`    ${element('url', {}, channel.url)}`);
  }
  lines.push('  </channel>');
  return lines.join('\n');
}

export function generateXmltv({
  channels,
  programmes,
  generatorInfoName = 'epg-scraper',
  lang,
  language: declaredLanguage,
}) {
  const language = validateGuideResult({
    channels,
    programmes,
    lang: declaredLanguage ?? lang ?? 'tr',
  });


  // Order by channel, then by start instant.  Comparing instants (not the ISO
  // strings) keeps the order chronological for providers whose timestamps
  // carry two offsets across a DST switch; the ISO string breaks ties so equal
  // instants keep a deterministic, byte-stable order.
  const byChannel = (a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0);
  const byStart = (a, b) => {
    const delta = isoToEpochMs(a.start) - isoToEpochMs(b.start);
    if (delta !== 0) return delta < 0 ? -1 : 1;
    return a.start < b.start ? -1 : a.start > b.start ? 1 : 0;
  };
  const sorted = [...programmes].sort((a, b) => byChannel(a, b) || byStart(a, b));
  // Real guide data contains overlapping/repeated slots (same channel, same
  // time range, sometimes different titles). Keep the first occurrence per
  // (channel, start, stop) — deterministic after the sort above — instead of
  // failing the whole run.
  const deduped = [];
  const seenSlot = new Set();
  for (const programme of sorted) {
    const key = `${programme.channel}|${programme.start}|${programme.stop}`;
    if (seenSlot.has(key)) continue;
    seenSlot.add(key);
    deduped.push(programme);
  }
  const head =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<tv generator-info-name="${esc(generatorInfoName)}" generator-info-url="none">\n`;
  const body =
    channels
      .map((channel) => channelElement(channel, language) + '\n')
      .join('') +
    deduped
      .map((programme) => programmeElement(programme, language) + '\n')
      .join('');
  return head + body + '</tv>\n';
}

export async function writeXmltv({
  channels,
  programmes,
  outputPath,
  gzip = true,
  generatorInfoName,
  lang,
  language,
}) {
  const xml = generateXmltv({
    channels,
    programmes,
    generatorInfoName,
    lang,
    language,
  });
  const nodeStream = Readable.from([xml]);
  const fs = await import('node:fs');
  const out = fs.createWriteStream(outputPath);
  if (gzip) {
    await pipeline(nodeStream, createGzip({ level: 9 }), out);
  } else {
    await pipeline(nodeStream, out);
  }
  return { bytes: Buffer.byteLength(xml), gzip };
}

// XMLTV reader — the inverse of the writer above, so already-scraped guides
// can be reused without hitting live servers again (CI merge reuses the
// per-provider artifacts).  Regex/string parsing only, like the providers:
// never eval scraped content.  Hostile input degrades to skipped entries,
// never a throw — the writer remains the final validator.

function attrValue(attrs, name) {
  // (^|\s) anchors the attribute name so a foreign attribute whose name merely
  // *ends* with ours (e.g. <channel data-id="EVIL">) cannot hijack the match:
  // without the anchor, /id\s*=/ happily matches inside "data-id=".
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs || '');
  return match ? decodeEntities(match[1]) : undefined;
}

function firstTagText(body, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`).exec(body || '');
  return match ? decodeEntities(match[1]).trim() : undefined;
}

function firstIconSrc(body) {
  const match = /<icon\s[^>]*src\s*=\s*"([^"]*)"[^>]*\/?>/.exec(body || '');
  return match ? decodeEntities(match[1]) : undefined;
}

function documentLanguage(source) {
  const match = /<(?:display-name|title)\b[^>]*\blang\s*=\s*(["'])([^"']*)\1/i.exec(source || '');
  return (match && normalizeLanguageTag(decodeEntities(match[2]))) || 'tr';
}

// Parse an XMLTV document string into the internal { channels, programmes }
// model.  Skips hostile/corrupt entries (bad timestamps, reversed slots,
// missing titles, dangling channel refs) instead of throwing.
export function parseXmltv(xml) {
  const source = xml == null ? '' : String(xml);
  const channels = [];
  const channelIds = new Set();
  const channelRe = /<channel\b([^>]*)>([\s\S]*?)<\/channel>/g;
  let channelMatch;
  while ((channelMatch = channelRe.exec(source)) !== null) {
    const id = attrValue(channelMatch[1], 'id');
    if (!id) continue;
    const body = channelMatch[2];
    const name = firstTagText(body, 'display-name') || id;
    const icon = firstIconSrc(body);
    const url = firstTagText(body, 'url') || undefined;
    if (channelIds.has(id)) continue;
    channelIds.add(id);
    channels.push({
      id,
      name,
      ...(icon != null && icon !== '' ? { icon } : {}),
      ...(url != null && url !== '' ? { url } : {}),
    });
  }

  const programmes = [];
  const programmeRe = /<programme\s([^>]*?)>([\s\S]*?)<\/programme>/g;
  let programmeMatch;
  while ((programmeMatch = programmeRe.exec(source)) !== null) {
    const attrs = programmeMatch[1];
    const body = programmeMatch[2];
    const channel = attrValue(attrs, 'channel');
    let start;
    let stop;
    try {
      start = fromXmltvTimestamp(attrValue(attrs, 'start'));
      stop = fromXmltvTimestamp(attrValue(attrs, 'stop'));
    } catch {
      continue; // malformed/impossible timestamp: skip, never throw
    }
    const title = firstTagText(body, 'title');
    if (!channel || !title) continue;
    if (!channelIds.has(channel)) continue; // dangling ref: skip
    // Reversed/zero-length slot: skip.  Compared as instants, since a
    // DST-observing guide can carry two offsets where string order is not
    // chronological.
    if (isoToEpochMs(stop) <= isoToEpochMs(start)) continue;
    const subTitle = firstTagText(body, 'sub-title');
    const desc = firstTagText(body, 'desc');
    const category = firstTagText(body, 'category');
    const icon = firstIconSrc(body);
    programmes.push({
      channel,
      start,
      stop,
      title,
      ...(subTitle ? { subTitle } : {}),
      ...(desc ? { desc } : {}),
      ...(category ? { category } : {}),
      ...(icon ? { icon } : {}),
    });
  }

  return createGuideResult({
    channels,
    programmes,
    days: 0,
    failures: 0,
    language: documentLanguage(source),
  });
}

// Read an XMLTV file (.xml or .xml.gz, detected by extension) into the
// internal model.  Rejects on missing/unreadable files; corrupt entries
// inside degrade to skips via parseXmltv.
export async function readXmltvFile(filePath) {
  const fs = await import('node:fs');
  const { gunzipSync } = await import('node:zlib');
  const raw = fs.readFileSync(filePath);
  const text = /[.]gz$/i.test(filePath) ? gunzipSync(raw).toString('utf8') : raw.toString('utf8');
  return parseXmltv(text);
}
