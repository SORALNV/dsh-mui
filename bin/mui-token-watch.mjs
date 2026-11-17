#!/usr/bin/env node
// mui-token-watch — capture a dsh web token from a log file into the MUI state.
// Spawned detached by `mui tui`; exits after writing or on timeout.

import { readFile, writeFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const logFile = arg('--log', '');
const port = arg('--port', '3219');
const cwd = arg('--cwd', process.cwd());
const STATE = join(homedir(), '.dsh', 'mui-daemon.json');

const deadline = Date.now() + 90_000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const text = await readFile(logFile, 'utf8');
    const m = text.match(/dsh web: (?:https?:\/\/\S*?)token=([!-~]+)/);
    if (m) {
      await writeFile(
        STATE,
        JSON.stringify(
          {
            pid: null, // 実体はフォアグラウンドのTUI; killはポート探査で行う
            port: Number(port),
            profile: 'mui',
            origin: `http://127.0.0.1:${port}`,
            token: m[1],
            cwd,
            mode: 'tui',
            startedAt: new Date().toISOString(),
            logFile,
          },
          null,
          2,
        ) + '\n',
      );
      process.exit(0);
    }
  } catch {
    /* log not written yet */
  }
}
await rm(STATE, { force: true });
process.exit(1);
