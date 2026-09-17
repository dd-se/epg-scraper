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

// Shared ISO 8601 matcher: date, optional seconds/fraction, optional offset.
const ISO_RE =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(?:\.([0-9]+))?(Z|[+-][0-9]{2}:?[0-9]{2})?$/;

// Split an ISO 8601 timestamp into its wall-clock parts + offset.  Returns
// undefined when the shape is not an ISO datetime at all.
function parseIso(iso) {
  const match = ISO_RE.exec(String(iso == null ? '' : iso));
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s = '00', frac, off] = match;
  return { y, mo, d, h, mi, s, frac, off };
}

// ISO 8601 (with an explicit offset) -> epoch ms, or undefined when the value
// is unparseable.  Ordering and the stop>start check compare *instants*
// through this: providers in DST zones emit two offsets in one guide
// (Europe/Stockholm +01:00/+02:00), where lexicographic string order is not
// chronological — "2026-10-25T02:15:00+01:00" precedes
// "2026-10-25T02:30:00+02:00" as text but is the later instant.
export function isoToEpochMs(iso) {
  const parts = parseIso(iso);
  if (!parts) return undefined;
  const { y, mo, d, h, mi, s, frac, off } = parts;
  const wallMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  let offsetMs = 0;
  if (off != null && off !== 'Z') {
    const normalized = off.replace(':', '');
    const sign = normalized.startsWith('-') ? -1 : 1;
    offsetMs =
      sign * (Number(normalized.slice(1, 3)) * 3600000 + Number(normalized.slice(3, 5)) * 60000);
  }
  // Sub-second precision is rejected elsewhere, but fold it in so a hostile
  // fractional value cannot silently shift an ordering decision.
  const fracMs = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
  return wallMs - offsetMs + fracMs;
}

// "2026-09-07T15:00:00+03:00" -> "20260907150000 +0300"
export function toXmltvTimestamp(iso) {
  const parsed = parseIso(iso);
  if (!parsed) {
    throw new Error(`Invalid ISO datetime: ${JSON.stringify(iso)}`);
  }
  const { y, mo, d, h, mi, s, frac, off } = parsed;
  if (frac) {
    throw new Error(`Fractional seconds are not representable in XMLTV: ${JSON.stringify(iso)}`);
  }
  // Wall-clock sanity: reject impossible values (Feb 30, hour 24, minute 60,
  // ...) that a lenient date parser would silently roll over into a
  // different instant.  Date.UTC normalizes, so a round-trip comparison
  // catches every overflow at once.
  const check = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
  );
  if (
    check.getUTCFullYear() !== Number(y) ||
    check.getUTCMonth() + 1 !== Number(mo) ||
    check.getUTCDate() !== Number(d) ||
    check.getUTCHours() !== Number(h) ||
    check.getUTCMinutes() !== Number(mi) ||
    check.getUTCSeconds() !== Number(s)
  ) {
    throw new Error(`Impossible datetime: ${JSON.stringify(iso)}`);
  }
  if (off != null && off !== 'Z') {
    const nums = off.replace(':', '');
    if (Number(nums.slice(1, 3)) > 23 || Number(nums.slice(3)) > 59) {
      throw new Error(`Invalid offset in datetime: ${JSON.stringify(iso)}`);
    }
  }
  const normalizedOffset = off == null || off === 'Z' ? '+0000' : off.replace(':', '');
  return `${y}${mo}${d}${h}${mi}${s} ${normalizedOffset}`;
}

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

// The `lang` attribute written on <display-name>/<title>/<sub-title>/<desc>/
// <category>.  It defaults to the reference guide's "tr"; a non-Turkish
// provider declares its own (tvnu: "sv") so Swedish titles are not labelled
// Turkish.  Anything that is not a plausible language tag degrades to "tr"
// rather than emitting a malformed attribute.
function normalizeLang(lang) {
  return typeof lang === 'string' && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang.trim())
    ? lang.trim()
    : 'tr';
}

export function generateXmltv({ channels, programmes, generatorInfoName = 'epg-scraper', lang = 'tr' }) {
  if (!Array.isArray(channels)) throw new Error('channels must be an array');
  if (!Array.isArray(programmes)) throw new Error('programmes must be an array');
  const language = normalizeLang(lang);

  const knownIds = new Set(channels.map((c) => c.id));
  for (const programme of programmes) {
    // A null entry (hostile provider result that slipped past merge/compare
    // filtering) must fail with a clear message, never a raw TypeError.
    if (!programme) {
      throw new Error('programmes must not contain null entries');
    }
    if (!knownIds.has(programme.channel)) {
      throw new Error(`Programme references unknown channel "${programme.channel}"`);
    }
    toXmltvTimestamp(programme.start);
    toXmltvTimestamp(programme.stop);
    // A programme whose stop does not follow its start (zero-length or
    // reversed) is corrupt data — cross-midnight mishandling and bad
    // provider math both produce it.  Refuse to emit it instead of writing
    // a guide no consumer can trust.  Compared as instants (not as strings)
    // because a DST-observing provider emits two offsets in one guide, where
    // string order is not chronological.
    const startMs = isoToEpochMs(programme.start);
    const stopMs = isoToEpochMs(programme.stop);
    if (startMs == null || stopMs == null || stopMs <= startMs) {
      throw new Error(
        `Programme "${programme.title}" on "${programme.channel}" has stop <= start ` +
          `(${programme.stop} <= ${programme.start})`
      );
    }
  }

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
  lang = 'tr',
}) {
  const xml = generateXmltv({ channels, programmes, generatorInfoName, lang });
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

// "20260907150000 +0300" -> "2026-09-07T15:00:00+03:00".  Throws on malformed
// or impossible input (validated with a Date.UTC round-trip, mirroring
// toXmltvTimestamp).
export function fromXmltvTimestamp(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-])(\d{2})(\d{2})$/.exec(
    String(value == null ? '' : value).trim()
  );
  if (!match) {
    throw new Error(`Invalid XMLTV timestamp: ${JSON.stringify(value)}`);
  }
  const [, y, mo, d, h, mi, s, sign, oh, om] = match;
  const check = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
  if (
    check.getUTCFullYear() !== Number(y) ||
    check.getUTCMonth() + 1 !== Number(mo) ||
    check.getUTCDate() !== Number(d) ||
    check.getUTCHours() !== Number(h) ||
    check.getUTCMinutes() !== Number(mi) ||
    check.getUTCSeconds() !== Number(s) ||
    Number(oh) > 23 ||
    Number(om) > 59
  ) {
    throw new Error(`Impossible XMLTV timestamp: ${JSON.stringify(value)}`);
  }
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${sign}${oh}:${om}`;
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

  return { channels, programmes };
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
