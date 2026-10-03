import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReleaseNotes } from '../scripts/build-release-notes.js';
import { writeXmltv } from '../src/xmltv.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epg-release-notes-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const guide = (id) => ({
  channels: [{ id, name: id }],
  programmes: [
    { channel: id, start: '2026-10-03T06:00:00+03:00', stop: '2026-10-03T07:00:00+03:00', title: 'Show' },
  ],
});

const write = (name, id) => writeXmltv({ ...guide(id), outputPath: join(dir, name), gzip: true });

const notes = () => buildReleaseNotes({ guidesDir: dir, guideDate: '2026-10-03' });

describe('release notes', () => {
  it('describes every merged guide from its own profile, not a guessed provider', async () => {
    await write('epg_trt_TR.xml.gz', 'TRT.HABER.tr');
    await write('epg_hurriyet_TR.xml.gz', 'ATV.tr');
    await write('epg_tvplus_TR.xml.gz', 'TRT.SPOR.tr');
    await write('epg_idmantv_TR.xml.gz', 'IDMAN.tr');
    await write('epg_hurriyet_trt_merged_TR.xml.gz', 'TRT.HABER.tr');
    await write('epg_sports_merged_TR.xml.gz', 'TRT.SPOR.tr');

    const body = await notes();

    // Both merged assets get their own section — a single slot used to mean the
    // second one silently vanished from the notes.
    expect(body).toContain('`epg_hurriyet_trt_merged_TR.xml.gz`</b> — merged guide `hurriyetTrt`');
    expect(body).toContain('`epg_sports_merged_TR.xml.gz`</b> — merged guide `sports`');

    // Each section names its profile's real inputs, and the exclusive profile
    // says why a channel comes from exactly one guide.
    expect(body).toContain(
      'Union of `epg_trt_TR.xml.gz` + `epg_hurriyet_TR.xml.gz` — the first guide wins conflicting slots.'
    );
    expect(body).toContain('so `epg_trt_TR.xml.gz`\'s channels are not interleaved with the rest');
    expect(body).toContain(
      'Union of `epg_tvplus_TR.xml.gz` + `epg_digiturkburada_TR.xml.gz` + `epg_sporekraniapi_TR.xml.gz` + `epg_tivibu_TR.xml.gz` + `epg_idmantv_TR.xml.gz`'
    );

    // The sports merge must not claim the trt+hurriyet merge as an input, and a
    // merged asset must never be labelled as a provider of its own.
    expect(body).not.toContain('provider `hurriyet_trt_merged`');
    expect(body).not.toContain('provider `sports_merged`');
    const sportsSection = body.slice(body.indexOf('`epg_sports_merged_TR.xml.gz`'));
    expect(sportsSection).not.toContain('epg_hurriyet_trt_merged');
  });

  it('lists provider guides with their channel lineups', async () => {
    await write('epg_trt_TR.xml.gz', 'TRT.HABER.tr');
    const body = await notes();
    expect(body).toContain('`epg_trt_TR.xml.gz`</b> — provider `trt`, 1 channels');
    expect(body).toContain('- TRT.HABER.tr (`TRT.HABER.tr`)');
  });

  it('degrades instead of crashing on unreadable and unknown files', async () => {
    await write('epg_trt_TR.xml.gz', 'TRT.HABER.tr');
    writeFileSync(join(dir, 'epg_broken_TR.xml.gz'), 'not a guide');
    writeFileSync(join(dir, 'epg_handmade_merged_TR.xml.gz'), 'not a guide');

    const body = await notes();
    expect(body).toContain('could not be read in CI');
    // A merged file no profile produced still gets a section, with the generic
    // wording rather than an invented source list.
    expect(body).toContain('`epg_handmade_merged_TR.xml.gz`</b> — merged guide, channel count unknown');
    expect(body).toContain('This merged guide could not be read in CI.');
  });

  it('produces a usable body when the guides directory does not exist', async () => {
    rmSync(dir, { recursive: true, force: true });
    const body = await buildReleaseNotes({ guidesDir: join(dir, 'gone'), guideDate: '2026-10-03' });
    expect(body).toContain('scraped 2026-10-03');
  });
});