// Well-formedness of the XMLTV writer's output, verified with a real XML
// parser (saxes — strict, dependency-free).  The adversarial suite proves the
// writer escapes hostile scraped content; this suite proves the *result* is
// actually parseable XML that round-trips back to the original text.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, mkdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SaxesParser } from 'saxes';
import { generateXmltv, writeXmltv } from '../src/xmltv.js';
import { parseDayPage, wallToIso, mapChannelId } from '../src/providers/hurriyet.js';

// Parse XML with saxes in strict mode.  Any well-formedness violation fires
// an 'error' event; we record it and fail the test.
function parseXml(xml) {
  const parser = new SaxesParser();
  const errors = [];
  const titles = [];
  const channelIds = [];
  const stack = [];
  let programmeCount = 0;
  parser.on('error', (e) => errors.push(e.message));
  parser.on('opentag', (tag) => {
    stack.push(tag.name);
    if (tag.name === 'channel') channelIds.push(tag.attributes.id);
    if (tag.name === 'programme') programmeCount++;
  });
  parser.on('closetag', () => stack.pop());
  parser.on('text', (t) => {
    const text = typeof t === 'string' ? t : t.text;
    if (stack[stack.length - 1] === 'title') titles.push(text);
  });
  try {
    parser.write(xml);
    parser.close();
  } catch (e) {
    errors.push(e.message);
  }
  return { errors, titles, channelIds, programmeCount };
}

const programme = (channel, start, title, extra = {}) => ({
  channel,
  start,
  stop: `2026-09-07T${String(Number(start.slice(11, 13)) + 1).padStart(2, '0')}:00:00+03:00`,
  title,
  ...extra,
});

describe('xmltv output: well-formed against saxes', () => {
  it('round-trips hostile titles without corruption or escape bugs', () => {
    const titles = [
      '</title><script>alert(1)</script>',
      '" onmouseover="alert(1)',
      'A & B < C > D "E"',
      'x]]>y',
      '&amp;amp; literal ampersands: ATV & Friends',
      'Küçük Ağa İzle — Türkçe ü ö ç ş ğ',
      '📺 Emoji & Symbols ©®',
      '   leading and trailing spaces   ',
    ];
    const channels = [{ id: 'X" onclick="evil()', name: 'A&B <b>' }];
    const programmes = titles.map((title, i) =>
      programme('X" onclick="evil()', `2026-09-07T${String(i).padStart(2, '0')}:00:00+03:00`, title)
    );
    const xml = generateXmltv({ channels, programmes });
    const parsed = parseXml(xml);

    expect(parsed.errors).toEqual([]);
    // The evil channel id survives the attribute round-trip.
    expect(parsed.channelIds).toEqual(['X" onclick="evil()']);
    expect(parsed.programmeCount).toBe(titles.length);
    // Every title parses back to exactly the text that went in.
    expect(parsed.titles).toEqual(titles);
  });

  it('strips XML-illegal characters so the output always parses', () => {
    const titles = [
      'a\u0000b\u0007c', // C0 controls
      'lone \uD800 surrogate \uDFFF',
      'nonchar U+FFFE\uFFFEnonchar',
    ];
    const programmes = titles.map((title, i) =>
      programme('X.tr', `2026-09-07T0${i}:00:00+03:00`, title)
    );
    const xml = generateXmltv({ channels: [{ id: 'X.tr', name: 'X' }], programmes });
    const parsed = parseXml(xml);

    expect(parsed.errors).toEqual([]);
    // The C0/surrogate/noncharacter bytes are gone from the serialized XML.
    expect(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/.test(xml)).toBe(false);
    // And the parsed text is the sanitized form, still valid.
    // The literal ASCII "U+FFFE" text survives; the actual U+FFFE char is stripped.
    expect(parsed.titles).toEqual(['abc', 'lone  surrogate ', 'nonchar U+FFFEnonchar']);
  });

  it('parses a real fixture-derived guide (Turkish channels, genres, icons)', () => {
    const fixturePath = fileURLToPath(new URL('./fixtures/hurriyet/day-pazartesi.html', import.meta.url));
    const { channels, slots } = parseDayPage(readFileSync(fixturePath, 'utf8'));

    const guideChannels = channels.map((c) => ({
      id: mapChannelId(c.name),
      name: c.name,
      icon: c.icon,
      url: c.url,
    }));
    const programmes = slots
      .filter((s) => channels[s.channelIndex])
      .map((s) => ({
        channel: mapChannelId(channels[s.channelIndex].name),
        start: wallToIso(2026, 9, 7, s.startMin),
        stop: wallToIso(2026, 9, 7, s.endMin),
        title: s.title,
        category: s.category,
      }));

    // The writer dedupes exact (channel, start, stop) slots (the real page
    // carries some overlapping repeats), so expect the deduped count.
    const seen = new Set();
    const deduped = programmes.filter((p) => {
      const key = [p.channel, p.start, p.stop].join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const xml = generateXmltv({ channels: guideChannels, programmes, generatorInfoName: 'test' });
    const parsed = parseXml(xml);

    expect(parsed.errors).toEqual([]);
    expect(parsed.channelIds).toHaveLength(guideChannels.length);
    expect(parsed.programmeCount).toBe(deduped.length);
    // Every parsed title matches a decoded source title exactly (no mojibake).
    const expected = new Set(programmes.map((p) => p.title));
    expect(parsed.titles.every((t) => expected.has(t))).toBe(true);
  });

  it('writes and re-parses gzipped and plain files end to end', async () => {
    const tmpDir = path.join(
      process.env.TMPDIR || '/tmp',
      `epg-xmltv-parse-${process.pid}-${Math.random().toString(36).slice(2)}`
    );
    mkdirSync(tmpDir, { recursive: true });
    const channels = [{ id: 'ATV.tr', name: 'ATV' }];
    const programmes = [
      {
        channel: 'ATV.tr',
        start: '2026-09-07T06:00:00+03:00',
        stop: '2026-09-07T07:00:00+03:00',
        title: 'ATV & Friends <live> "özel"',
      },
    ];

    const plainPath = path.join(tmpDir, 'plain.xml');
    await writeXmltv({ channels, programmes, outputPath: plainPath, gzip: false });
    expect(parseXml(readFileSync(plainPath, 'utf8')).errors).toEqual([]);

    const gzPath = path.join(tmpDir, 'guide.xml.gz');
    await writeXmltv({ channels, programmes, outputPath: gzPath, gzip: true });
    const gzXml = gunzipSync(readFileSync(gzPath)).toString('utf8');
    const parsed = parseXml(gzXml);
    expect(parsed.errors).toEqual([]);
    expect(parsed.titles).toEqual(['ATV & Friends <live> "özel"']);
  });
});