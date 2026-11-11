/**
 * @fileoverview Phase 16: the packaged-executable entry point. Runs the real CLI entry (cli.ts)
 * the same way the executable does, to prove it starts unconditionally (no reliance on argv[1]
 * looking like "index.js", which is false inside a pkg executable).
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.ts');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** Runs cli.ts through node + the tsx loader, which works the same on Windows, macOS and Linux. */
function run(args: string[]) {
  return spawn(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function collect(
  child: ReturnType<typeof run>,
): Promise<{ out: string; code: number | null }> {
  let out = '';
  child.stdout?.on('data', (d) => (out += d));
  child.stderr?.on('data', (d) => (out += d));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  return { out, code };
}

describe('server CLI entry', () => {
  it('prints help and version, then exits without starting a server', async () => {
    const help = await collect(run(['--help']));
    expect(help.code).toBe(0);
    expect(help.out).toContain('--no-discovery');
    expect(help.out).toContain('--data-dir');
    const version = await collect(run(['--version']));
    expect(version.out.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('starts listening on the requested port and shuts down on SIGTERM', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-cli-'));
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((r) => probe.close(() => r()));

    const child = run([
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--no-discovery',
      '--data-dir',
      dir,
    ]);
    try {
      let connected = false;
      for (let i = 0; i < 50 && !connected; i++) {
        connected = await new Promise<boolean>((resolve) => {
          const s = net.createConnection({ host: '127.0.0.1', port }, () => {
            s.destroy();
            resolve(true);
          });
          s.on('error', () => resolve(false));
        });
        if (!connected) await new Promise((r) => setTimeout(r, 100));
      }
      expect(connected).toBe(true);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('close', r));
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 20000);
});
