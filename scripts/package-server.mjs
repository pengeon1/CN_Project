#!/usr/bin/env node
/**
 * Builds standalone server executables with @yao-pkg/pkg (Node 22 runtime embedded, no Node
 * install or internet needed on the target machine).
 *
 * Usage: node scripts/package-server.mjs [--all] [target ...]
 *   default: the targets that can be built natively on this OS
 *   --all  : win-x64, linux-x64, macos-arm64, macos-x64 (cross-compiles; macOS binaries built
 *            off a Mac are unsigned and may need re-signing, so CI builds each on its own OS)
 * Output: release/server/whiteboard-server-<os>-<arch>[.exe]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from '@yao-pkg/pkg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'packages/server/dist/whiteboard-server.cjs');
const outDir = join(root, 'release/server');

const NATIVE = { linux: ['linux-x64'], win32: ['win-x64'], darwin: ['macos-arm64', 'macos-x64'] };
const ALL = ['win-x64', 'linux-x64', 'macos-arm64', 'macos-x64'];

const args = process.argv.slice(2);
const targets = args.includes('--all')
  ? ALL
  : args.filter((a) => !a.startsWith('--')).length > 0
    ? args.filter((a) => !a.startsWith('--'))
    : (NATIVE[process.platform] ?? []);

if (targets.length === 0) {
  console.error(`No default targets for platform ${process.platform}; pass targets explicitly.`);
  process.exit(1);
}

// 1. Bundle the server (and @cn-whiteboard/common, zod) into one CommonJS file.
const build = spawnSync('npm', ['--workspace=@cn-whiteboard/server', 'run', 'build:cli'], {
  cwd: root,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (build.status !== 0) process.exit(build.status ?? 1);

// 2. Wrap it with the Node runtime, once per target.
mkdirSync(outDir, { recursive: true });
for (const target of targets) {
  const exe = target.startsWith('win') ? '.exe' : '';
  const out = join(outDir, `whiteboard-server-${target}${exe}`);
  console.log(`\n==> pkg ${target} -> ${out}`);
  await exec([bundle, '--targets', `node22-${target}`, '--output', out, '--compress', 'GZip']);
}
console.log('\nDone.');
