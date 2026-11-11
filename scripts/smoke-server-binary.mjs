#!/usr/bin/env node
/**
 * Smoke test for a packaged server executable: start it, connect over TCP, complete the HELLO
 * handshake, and answer a LAN discovery probe. Run in CI after packaging on every OS.
 *
 * Usage: node scripts/smoke-server-binary.mjs <path-to-executable>
 */
import { spawn } from 'node:child_process';
import * as dgram from 'node:dgram';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootPkg = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../package.json'), 'utf8'),
);
const APP_VERSION = typeof rootPkg.version === 'string' ? rootPkg.version : '1.0.0';

const exe = process.argv[2];
if (!exe) {
  console.error('Usage: smoke-server-binary.mjs <executable>');
  process.exit(2);
}

const free = (type) =>
  new Promise((resolve) => {
    if (type === 'udp') {
      const s = dgram.createSocket('udp4');
      s.bind(0, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    } else {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    }
  });

const tcpPort = await free('tcp');
const udpPort = await free('udp');
const dataDir = mkdtempSync(join(tmpdir(), 'wb-smoke-'));
const child = spawn(
  exe,
  [
    '--host',
    '127.0.0.1',
    '--port',
    String(tcpPort),
    '--discovery-port',
    String(udpPort),
    '--data-dir',
    dataDir,
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));

const fail = (msg) => {
  console.error(`SMOKE FAILED: ${msg}\n--- server output ---\n${log}`);
  child.kill();
  process.exit(1);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for the TCP port to accept connections.
let socket;
for (let i = 0; i < 100 && !socket; i++) {
  socket = await new Promise((resolve) => {
    const s = net.createConnection({ host: '127.0.0.1', port: tcpPort }, () => resolve(s));
    s.on('error', () => resolve(null));
  });
  if (!socket) await sleep(100);
}
if (!socket) fail('server never started listening');

// HELLO -> AUTH_OK (4-byte big-endian length prefix + JSON envelope).
const body = Buffer.from(
  JSON.stringify({
    v: 1,
    type: 'HELLO',
    msg_id: randomUUID(),
    seq: 0,
    ts: Date.now(),
    room: '',
    user_id: '',
    payload: { clientVersion: APP_VERSION, suggestedUsername: 'smoke' },
  }),
);
const header = Buffer.alloc(4);
header.writeUInt32BE(body.length);
socket.write(Buffer.concat([header, body]));
const reply = await new Promise((resolve) => {
  let buf = Buffer.alloc(0);
  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
      resolve(JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString('utf8')));
    }
  });
  setTimeout(() => resolve(null), 5000);
});
socket.destroy();
if (reply?.type !== 'AUTH_OK') fail(`expected AUTH_OK, got ${JSON.stringify(reply)}`);

// UDP discovery probe -> ANNOUNCE with our TCP port.
const udp = dgram.createSocket('udp4');
const announce = await new Promise((resolve) => {
  udp.on('message', (m) => resolve(JSON.parse(m.toString())));
  udp.send(JSON.stringify({ magic: 'CN-WHITEBOARD', v: 1, type: 'PROBE' }), udpPort, '127.0.0.1');
  setTimeout(() => resolve(null), 3000);
});
udp.close();
if (announce?.type !== 'ANNOUNCE' || announce.port !== tcpPort) {
  fail(`bad discovery reply: ${JSON.stringify(announce)}`);
}

child.kill();
await Promise.race([
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once('close', resolve);
  }),
  sleep(2000).then(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }),
]);
rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
console.log(`SMOKE OK: ${exe} handshakes over TCP and answers discovery`);
process.exit(0);
