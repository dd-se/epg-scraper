# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
package is private and never published; releases are version bumps plus tags.

## [1.0.0] — unreleased

Channel ids change in every guide in this release, so a consumer keyed on an old
id needs updating. Swedish (`tvnu`) ids are unchanged.

### Changed

- **BREAKING — Turkish channel ids are now this project's own format.** Uppercase
  ASCII, every Turkish diacritic folded to its Latin letter, no separators:
  `TRT.ÇOCUK.tr` → `TRTCOCUK.tr`, `beIN.SPORTS.1.tr` → `BEINSPORTS1.tr`,
  `KANAL.D.tr` → `KANALD.tr`. Only the `.tr` suffix carries a dot.
  `foldChannelId()` upper-cases, so an id arriving from a third-party guide lands
  on the same spelling as a curated one.
- **Casing never decides channel identity.** `channelIdMatchKey()` in
  `src/slug.js` is what the alias map, `--compare` and `--merge` match ids
  through, so `KANALD.tr` and `kanald.tr` are one channel: a merge unions them
  once, keeps the spelling of the provider that introduced it and rewrites the
  other side's programmes onto it, and a compare reports one shared channel
  rather than an only-a plus an only-b. `--alias-map` keys match
  case-insensitively, and curated ids stay all-caps (`SSPORT1.tr`,
  `SSPORT2.tr`) instead of following a playlist's mixed case.
- Six ids drop a redundant `HD` qualifier, and channel display names drop it
  too: `ANEWSHD.tr` → `ANEWS.tr`, `TRTAVAZHD.tr` → `TRTAVAZ.tr`,
  `TRTWORLDHD.tr` → `TRTWORLD.tr`, `SINEMATVHD.tr` → `SINEMATV.tr`,
  `DAVINCILEARNINGHD.tr` → `DAVINCILEARNING.tr`, `beINSPORTSHABERHD.tr` →
  `BEINSPORTSHABER.tr`, in every guide that carries them (hurriyet, mynet, trt,
  tvplus). HD is a delivery variant, not the channel's identity — the rule that
  already produced `EUROSPORT1.tr` and `NICKELODEON.tr`. Providers normalize the
  label where they build their result (`A NEWS HD` → `A NEWS`,
  `stripQualityQualifier()` in `src/providers/shared.js`), so name and id agree;
  the guide-result seam stores the name it is handed.
- Three ids that had drifted from their channel's current name now follow it, so
  a viewer joining the guide and the playlist by id finds one channel: `FOX.tr` →
  `NOWTV.tr` (the FOX rebrand, spelled `NOW` by every source but mynet),
  `SSport.tr`/`SSport2.tr` → `SSPORT1.tr`/`SSPORT2.tr`, and
  `EUROSPORT1HD.tr`/`EUROSPORT2TRHD.tr` → `EUROSPORT1.tr`/`EUROSPORT2.tr`. The
  playlist catalog's dead `FOX` entry goes with it — no source publishes a `FOX`
  row any more.
- mynet curates four channels it served only through the generic slug, so their
  ids change: `MNKAGO.tr` → `MINIKAGO.tr`, `NICKELODEONSD.tr` →
  `NICKELODEON.tr` (dropping the `SD` qualifier, like every other qualifier).
  `BABYTV.tr` and `DISCOVERYCHANNEL.tr` are unchanged, and now curated rather
  than accidental.
- **The shipped alias map is gone; the providers agree by curation.** mynet pins
  `FB TV` to `FENERBAHCETV.tr` (tvplus's id) and `TV2` to `TEVE2.tr` (hurriyet's,
  for a pair publishing byte-identical schedules), so no merge needs id
  reconciliation and `aliases.mynet-sports.json` is deleted — one of its two
  entries pointed at an id no guide ever published, which renamed a channel in
  the mynet+sports merge instead of reconciling it. `--alias-map` remains the
  tool for reconciling a third-party guide; no shipped guide uses it.
- **TV+ curates 76 channels instead of 16.** A live `ChannelList` probe (172
  channels, 155 with programme data, 17 movie-collection VOD rails) was compared
  slot-by-slot against the hürriyet guide: 26 shared channels, titles agreeing
  89–100% on 24 of them, the residual being the overnight carry-over tvplus
  returns and hürriyet leaves as a repeats block. TV+ is trusted as a guide, so
  the table keeps every channel it serves that hürriyet or mynet also curates —
  the provider now stands alone for that lineup — plus Viasat History, which
  closes the playlist catalog's `HISTORY.tr` gap, and `TRTEBA.tr`, which only
  this platform carries. Each id is one another provider already publishes
  (`NOWTV.tr`, `FENERBAHCETV.tr`, `SOZCUTV.tr`, `TABIISPOR.tr`, …), never a new
  spelling. Five rows exist only because the platform spells a channel
  differently from our guides (`24 HD` for `24TV.tr`, `NICKELODEON` for mynet's
  `NICKELODEON SD`); a coverage fixture pins the table to every channel another
  published guide serves, so a table edit cannot silently drop one again.
- The sports coverage count drops from 38 to **33** distinct sports feeds: the
  old figure counted TV+'s ATV, TRT 1, TV8, TV8,5 and A2 as sports, which they
  never were. Those channels stay in TV+'s own guide.
- The playlist catalog's no-guide list drops from eleven channels to seven: Baby
  TV, Discovery Channel, Minika Go and Nickelodeon are all served by mynet
  (`minika.go.tr`, `nickelodeon.tr` once curated). They were found by comparing
  provider channel lists by name rather than by id, because three of them reach
  the guide through the generic-slug fallback and one is spelled with a Turkish
  dotted capital.
- Playlist (`--m3u`) `tvg-id`s are unchanged (`trt1.tr`, `cnnturk.tr`, …); the
  playlist namespace stays separate from the guide ids.
- tvplus's default politeness delay is 500 ms (was 400): it is one
  `PlayBillList` request per curated channel per day.

### Added

- `--sports-only` (`--merge` only) keeps each provider's curated sports subset,
  so a sports-profile provider that also curates general-interest channels
  cannot widen a sports feed. `npm run merge:sports` and the CI sports merge job
  both carry it.
- `foldChannelId()` and `isCanonicalChannelId()` in `src/slug.js`, plus the one
  folding seam in `createGuideResult()`, so provider ids, alias targets and
  `programme.channel` references always agree.
- `channelIdMatchKey()` in `src/slug.js`: the case-insensitive key aliases,
  compare and merge match ids through.
- The writer refuses a non-canonical channel id instead of emitting it.
- `test/channel-id.test.mjs`: the folding rule and its idempotence, the Swedish
  passthrough, the seam and the writer's refusal, plus a catalog-wide check that
  every curated id is canonical and that no two fold onto the same match key.

### Removed

- The epgshare01 reference snapshots and their machinery
  (`test/reference.test.mjs`, `test/fixtures/epgshare01/`,
  `scripts/update-reference-ids.js`, `npm run update:reference`,
  `REFERENCE_SNAPSHOTS`, and each catalog entry's `referenceCountry`). Channel
  ids are curated in the provider maps and guarded by the format tests instead,
  which also drops the suite's weekly network re-download.

### Fixed

- A programme naming a channel in a pre-fold spelling now resolves to the
  emitted id instead of being dropped as `unknown-channel`.
- The playlist catalog's `History` pattern never matched anything: every source
  spells the channel `Viasat History`, which is why tvplus serving it closed the
  gap and the pattern did not. The pattern is `Viasat History`, so the channel
  reaches playlists.
- `channelIdFromName` dropped every Turkish diacritic instead of folding it, so
  an unmapped channel shipped a letter short — `DİYANET TV` as `DYANETTV.tr`,
  `SÖZCÜ TV` as `SZCTV.tr`. Folding first makes the fallback agree with
  `foldChannelId`.
