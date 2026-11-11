/**
 * @fileoverview LAN server scanner (Phase 15), run in the Electron main process (the renderer has
 * no sockets). Broadcasts a UDP probe on every interface and collects the unicast replies.
 */

import * as dgram from 'node:dgram';
import * as os from 'node:os';
import {
  DISCOVERY_PORT,
  DISCOVERY_SCAN_MS,
  encodeDiscoveryProbe,
  getBroadcastAddresses,
  parseDiscoveryAnnounce,
} from '@cn-whiteboard/common';
import type { DiscoveredServer } from '../src/types/ipc.js';

export interface ScanOptions {
  port?: number;
  timeoutMs?: number;
  /** Addresses to probe; defaults to the broadcast address of every interface plus loopback. */
  targets?: string[];
}

/**
 * Finds whiteboard servers that answer within `timeoutMs`. Never rejects: network trouble just
 * yields fewer (or no) results, and the dialog keeps manual IP entry as the fallback.
 */
export function scanForServers(options: ScanOptions = {}): Promise<DiscoveredServer[]> {
  const port = options.port ?? DISCOVERY_PORT;
  const timeoutMs = options.timeoutMs ?? DISCOVERY_SCAN_MS;
  const targets = options.targets ?? [
    '255.255.255.255',
    ...getBroadcastAddresses(os.networkInterfaces()),
    '127.0.0.1', // a server on this very machine
  ];

  return new Promise((resolve) => {
    // A server reachable on several addresses answers each probe, so key by name+port and prefer
    // a real LAN address over loopback (loopback is useless to other machines).
    const found = new Map<string, DiscoveredServer>();
    const socket = dgram.createSocket('udp4');
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve([...found.values()].sort((a, b) => a.name.localeCompare(b.name)));
    };

    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      const info = parseDiscoveryAnnounce(msg);
      if (!info) return;
      const key = `${info.name}:${info.port}`;
      const prior = found.get(key);
      if (prior && !prior.host.startsWith('127.')) return;
      found.set(key, { host: rinfo.address, port: info.port, name: info.name, rooms: info.rooms });
    });

    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        // some platforms refuse; directed sends to 127.0.0.1 still work
      }
      const probe = encodeDiscoveryProbe();
      for (const target of targets) {
        // Individual send failures (e.g. no route on one interface) must not abort the scan.
        socket.send(probe, port, target, () => undefined);
      }
      setTimeout(finish, timeoutMs);
    });
  });
}
