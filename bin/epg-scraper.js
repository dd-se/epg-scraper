#!/usr/bin/env node
// Thin wrapper around src/cli.js — all logic lives there so it stays testable.

import { runCli } from '../src/cli.js';

process.exitCode = await runCli();
