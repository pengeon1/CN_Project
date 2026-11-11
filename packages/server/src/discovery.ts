/**
 * @fileoverview UDP discovery responder (Phase 15). Answers LAN probes with the server's name and
 * TCP port so clients can list servers without typing an IP address.
 */

import * as dgram from 'node:dgram';
import * as os from 'node:os';
import {
  APP_VERSION,
  encodeDiscoveryAnnounce,
  isDiscoveryProbe,
  type DiscoveryAnnounce,
} from '@cn-whiteboard/common';
import { Logger } from './logger.js';

export interface DiscoveryOptions {
  /** UDP port to listen on (0 picks a free one, used by tests). */
  port: number;
  /** TCP port advertised to clients. */
  tcpPort: number;
  /** Supplies the live room count for each announcement. */
  getRoomCount: () => number;
  name?: string;
}

/** Replies allowed per source address per second; stops the responder being used as a reflector. */
const MAX_REPLIES_PER_SECOND = 5;

/**
 * Listens for discovery probes and answers each sender directly (unicast).
 * Failing to bind is never fatal: the TCP server works fine without discovery.
 */
export class DiscoveryResponder {
  private socket: dgram.Socket | null = null;
  private logger = new Logger('Discovery');
  private recent = new Map<string, number[]>();

  constructor(private readonly options: DiscoveryOptions) {}

  /** The bound UDP port, or null when not running. */
  public get port(): number | null {
    return this.socket ? this.socket.address().port : null;
  }

  /** @returns true when listening, false when binding failed (logged, not thrown). */
  public start(): Promise<boolean> {
    return new Promise((resolve) => {
      // reuseAddr lets several servers on one machine (or a quick restart) share the port.
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      socket.on('message', (msg, rinfo) => this.onMessage(socket, msg, rinfo));
      const onBindError = (err: Error) => {
        this.logger.warn(`LAN discovery disabled: ${err.message}`);
        try {
          socket.close();
        } catch {
          // already closed
        }
        this.socket = null;
        resolve(false);
      };
      socket.once('error', onBindError);
      socket.bind(this.options.port, () => {
        socket.removeListener('error', onBindError);
        this.socket = socket;
        // Late errors (e.g. interface going away) must not crash the process.
        socket.on('error', (err) => this.logger.warn(`Discovery socket error: ${err.message}`));
        this.logger.info(`LAN discovery listening on udp/${socket.address().port}`);
        resolve(true);
      });
    });
  }

  public stop(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return Promise.resolve();
    return new Promise((resolve) => socket.close(() => resolve()));
  }

  private allowed(address: string): boolean {
    const now = Date.now();
    const times = (this.recent.get(address) ?? []).filter((t) => now - t < 1000);
    if (times.length >= MAX_REPLIES_PER_SECOND) {
      this.recent.set(address, times);
      return false;
    }
    times.push(now);
    this.recent.set(address, times);
    if (this.recent.size > 1000) this.recent.clear(); // bound memory under address spraying
    return true;
  }

  private onMessage(socket: dgram.Socket, msg: Buffer, rinfo: dgram.RemoteInfo): void {
    if (!isDiscoveryProbe(msg) || !this.allowed(rinfo.address)) return;
    const info: Omit<DiscoveryAnnounce, 'magic' | 'v' | 'type'> = {
      name: (this.options.name ?? os.hostname()).slice(0, 64) || 'whiteboard',
      port: this.options.tcpPort,
      rooms: this.options.getRoomCount(),
      appVersion: APP_VERSION,
    };
    socket.send(encodeDiscoveryAnnounce(info), rinfo.port, rinfo.address);
  }
}
