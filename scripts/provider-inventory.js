import { spawnSync } from 'node:child_process';
import {
  COMMAND_PROFILES,
  PROVIDER_CATALOG,
  ciSportsProviders,
  curatedChannelIds,
  dailyCiMatrix,
  liveSportsProviders,
  profileInputFiles,
} from '../src/provider-catalog.js';

const matrix = { include: dailyCiMatrix() };
// Guide files the CI merge jobs feed to `--merge --from`, in precedence order.
const withDir = (files) => files.map((file) => `guides/${file}`);
const sportsInputs = withDir(profileInputFiles(COMMAND_PROFILES.sports));
const trtInputs = withDir(profileInputFiles(COMMAND_PROFILES.hurriyetTrt));
const unionSize = (entries) =>
  new Set(entries.flatMap((entry) => curatedChannelIds(entry))).size;
const mergeProfiles = Object.fromEntries(
  Object.entries(COMMAND_PROFILES).map(([name, profile]) => [name, profileInputFiles(profile)])
);

const runIndex = process.argv.indexOf('--run');
if (runIndex !== -1) {
  const profileName = process.argv[runIndex + 1];
  const profile = COMMAND_PROFILES[profileName];
  if (!profile) throw new Error(`Unknown provider profile: ${profileName || '<missing>'}`);
  const args = [
    'bin/epg-scraper.js',
    '--provider',
    profile.providerIds.join(','),
    '--merge',
    // Only profiles that actually carry an alias map pass one; the flag needs
    // a real file, and most profile pairs already agree on channel ids.
    ...(profile.aliasMap ? ['--alias-map', profile.aliasMap] : []),
    ...(profile.exclusiveChannels ? ['--exclusive-channels'] : []),
    ...(profile.args || []),
    '--out',
    profile.output,
  ];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status == null ? 1 : result.status;
} else if (process.argv.includes('--github-output')) {
  console.log(`matrix=${JSON.stringify(matrix)}`);
  console.log(`sports_inputs=${JSON.stringify(sportsInputs)}`);
  console.log(`trt_inputs=${JSON.stringify(trtInputs)}`);
  console.log(`trt_output=${COMMAND_PROFILES.hurriyetTrt.output}`);
} else {
  console.log(
    JSON.stringify(
      {
        providers: PROVIDER_CATALOG.map((entry) => entry.id),
        matrix,
        mergeProfiles,
        counts: {
          providers: PROVIDER_CATALOG.length,
          dailyCi: matrix.include.length,
          liveSportsChannels: unionSize(liveSportsProviders()),
          ciSportsChannels: unionSize(ciSportsProviders()),
        },
      },
      null,
      2
    )
  );
}
