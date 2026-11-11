/**
 * @fileoverview Phase 15: UDP LAN discovery end to end (real sockets on loopback) plus the pure
 * datagram helpers.
 */
import * as dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DISCOVERY_MAGIC,
  encodeDiscoveryAnnounce,
  encodeDiscoveryProbe,
  getBroadcastAddresses,
  isDiscoveryProbe,
  parseDiscoveryAnnounce,
} from '@cn-whiteboard/common';
import {
  startIsolatedServer,
  closeIsolatedServer,
} from '../packages/server/tests/helpers/isolated-server.js';
import { DiscoveryResponder } from '../packages/server/src/discovery.js';
import { parseConfig } from '../packages/server/src/config.js';
import { scanForServers } from '../packages/client/electron/discovery.js';

describe('discovery datagrams', () => {
  it('round-trips a probe and an announcement', () => {
    expect(isDiscoveryProbe(encodeDiscoveryProbe())).toBe(true);
    const info = { name: 'lab-pc', port: 4000, rooms: 2, appVersion: '0.1.0' };
    expect(parseDiscoveryAnnounce(encodeDiscoveryAnnounce(info))).toMatchObject(info);
  });

  it('rejects garbage, wrong magic, oversize and out-of-range data', () => {
    expect(isDiscoveryProbe(Buffer.from('hello'))).toBe(false);
    expect(isDiscoveryProbe(Buffer.from(JSON.stringify({ magic: 'X', v: 1, type: 'PROBE' })))).toBe(
      false,
    );
    expect(isDiscoveryProbe(Buffer.alloc(0))).toBe(false);
    expect(isDiscoveryProbe(Buffer.alloc(2000, 65))).toBe(false);
    const bad = {
      magic: DISCOVERY_MAGIC,
      v: 1,
      type: 'ANNOUNCE',
      name: 'x',
      port: 99999,
      rooms: 0,
    };
    expect(parseDiscoveryAnnounce(Buffer.from(JSON.stringify(bad)))).toBeNull();
    // a probe is not an announcement
    expect(parseDiscoveryAnnounce(encodeDiscoveryProbe())).toBeNull();
  });

  it('derives directed broadcast addresses and ignores loopback/IPv6', () => {
    const addrs = getBroadcastAddresses({
      eth0: [
        { family: 'IPv4', address: '192.168.1.37', netmask: '255.255.255.0', internal: false },
        { family: 'IPv6', address: 'fe80::1', netmask: 'ffff::', internal: false },
      ],
      wlan0: [{ family: 'IPv4', address: '10.1.2.3', netmask: '255.255.0.0', internal: false }],
      lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
    });
    expect(addrs.sort()).toEqual(['10.1.255.255', '192.168.1.255']);
  });
});

describe('discovery over UDP', () => {
  const responders: DiscoveryResponder[] = [];
  afterEach(async () => {
    await Promise.all(responders.splice(0).map((r) => r.stop()));
  });

  async function start(tcpPort: number, rooms: number, name: string) {
    const r = new DiscoveryResponder({ port: 0, tcpPort, getRoomCount: () => rooms, name });
    responders.push(r);
    expect(await r.start()).toBe(true);
    return r;
  }

  it('finds a server by probing and reports its TCP port and room count', async () => {
    const r = await start(4321, 3, 'lab-server');
    const found = await scanForServers({ port: r.port!, targets: ['127.0.0.1'], timeoutMs: 300 });
    expect(found).toEqual([{ host: '127.0.0.1', port: 4321, name: 'lab-server', rooms: 3 }]);
  });

  it('returns an empty list (not an error) when nothing answers', async () => {
    const found = await scanForServers({ port: 9, targets: ['127.0.0.1'], timeoutMs: 150 });
    expect(found).toEqual([]);
  });

  it('ignores non-probe datagrams and rate limits a flooding sender', async () => {
    const r = await start(4000, 0, 'quiet');
    const sock = dgram.createSocket('udp4');
    let replies = 0;
    sock.on('message', () => replies++);
    await new Promise<void>((res) => sock.bind(0, res));
    const send = (b: Buffer) => sock.send(b, r.port!, '127.0.0.1');
    send(Buffer.from('not a probe'));
    for (let i = 0; i < 30; i++) send(encodeDiscoveryProbe());
    await new Promise((res) => setTimeout(res, 300));
    sock.close();
    expect(replies).toBeGreaterThan(0);
    expect(replies).toBeLessThanOrEqual(5);
  });

  it('survives its port being taken: start() reports false instead of throwing', async () => {
    const blocker = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    await new Promise<void>((res) => blocker.bind(0, '0.0.0.0', res));
    const taken = blocker.address().port;
    const r = new DiscoveryResponder({ port: taken, tcpPort: 1, getRoomCount: () => 0 });
    expect(await r.start()).toBe(false);
    blocker.close();
  });

  it('is configured from the command line', () => {
    const argv = (...a: string[]) => ['node', 'x', ...a];
    expect(parseConfig(argv()).discoveryPort).toBe(45454);
    expect(parseConfig(argv('--discovery-port', '5000')).discoveryPort).toBe(5000);
    expect(parseConfig(argv('--no-discovery')).discoveryPort).toBeUndefined();
  });
});

describe('discovery wired into the server', () => {
  it('advertises the real TCP port and live room count, and stops on close', async () => {
    const { server, port } = await startIsolatedServer({
      host: '127.0.0.1',
      port: 0,
      discoveryPort: 0,
    });
    await new Promise((r) => setTimeout(r, 100));
    const udp = server.discoveryBoundPort!;
    expect(udp).toBeGreaterThan(0);

    const found = await scanForServers({ port: udp, targets: ['127.0.0.1'], timeoutMs: 300 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ port, rooms: 0 });

    await closeIsolatedServer(server);
    expect(server.discoveryBoundPort).toBeNull();
  });
});
