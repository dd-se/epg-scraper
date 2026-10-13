# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
package is private and never published; releases are version bumps plus tags.

## [1.0.0] — unreleased

### Changed

- **BREAKING — channel ids are now this project's own format.** Turkish
  guides emit ASCII ids with every Turkish diacritic folded to its Latin
  letter and no separators, keeping their case: `TRT.ÇOCUK.tr` → `TRTCOCUK.tr`,
  `CNN.TÜRK.tr` → `CNNTURK.tr`, `beIN.SPORTS.1.tr` → `beINSPORTS1.tr`,
  `KANAL.D.tr` → `KANALD.tr`. Only the `.tr` suffix carries a dot. Every
  downstream guide (per-provider, merged, sports, hurriyet+TRT) changes its
  channel ids in the same release, so channel lists and recordings that
  reference the old dotted ids must be updated. Swedish (`tvnu`) ids are
  unchanged — they keep their source-tagged spelling (`[SVT1HD].SVT1.HD.se`).
- Three ids that had drifted away from their channel's current name now follow
  it, so a viewer who joins the guide and the playlist by id finds one channel:
  `FOX.tr` → `NOWTV.tr` (the FOX rebrand, spelled `NOW` by every source but
  mynet), `SSport.tr`/`SSport2.tr` → `SSPORT1.tr`/`SSPORT2.tr`, and
  `EUROSPORT1HD.tr`/`EUROSPORT2TRHD.tr` → `EUROSPORT1.tr`/`EUROSPORT2.tr`. The
  playlist catalog's dead `FOX` entry is dropped in the same change — no source
  publishes a `FOX` row any more.
- Playlist (`--m3u`) `tvg-id`s are unchanged (`trt1.tr`, `cnnturk.tr`, …); the
  playlist namespace stays separate from the guide ids.

### Added

- `foldChannelId()` and `isCanonicalChannelId()` in `src/slug.js`, plus the
  one folding seam in `createGuideResult()` so provider ids, alias targets and
  `programme.channel` references always agree.
- The writer refuses a non-canonical channel id instead of emitting it.
- `test/channel-id.test.mjs`: the folding rule and its idempotence, the Swedish
  passthrough, the seam and the writer's refusal, plus a catalog-wide check
  that every curated id is canonical and that no two fold onto the same string.

### Removed

- The epgshare01 reference snapshots and their machinery
  (`test/reference.test.mjs`, `test/fixtures/epgshare01/`,
  `scripts/update-reference-ids.js`, `npm run update:reference`,
  `REFERENCE_SNAPSHOTS`, and each catalog entry's `referenceCountry`). Channel
  ids are curated in the provider maps and guarded by the new format tests
  instead, which also removes the suite's weekly network re-download.

### Fixed

- A programme naming a channel in a pre-fold spelling now resolves to the
  emitted id instead of being dropped as `unknown-channel`.
- A `.tr` domain passed to `foldChannelId()` is no longer rewritten.