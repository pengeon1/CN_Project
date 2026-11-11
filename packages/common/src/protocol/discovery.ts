/**
 * @fileoverview LAN discovery datagram format (Phase 15).
 *
 * Discovery uses UDP because it needs one-to-many "is anyone there?" probes on the local
 * network, which TCP cannot do, and a lost datagram is harmless (the client just scans again).
 * Everything that matters (drawing, chat, state) still travels over TCP.
 *
 * Exchange: a client broadcasts a PROBE to the discovery port; each server answers the sender
 * directly (unicast) with an ANNOUNCE describing how to connect over TCP. Datagrams are tiny JSON,
 * magic-tagged so unrelated UDP traffic is ignored, and size-capped so they cannot be abused.
 * Announcements deliberately contain NO room codes: discovery only tells you a server exists;
 * you still need the room code (and password) to get in.
 */

import { z } from 'zod';

/** UDP port servers listen on for probes. Fixed so clients know where to broadcast. */
export const DISCOVERY_PORT = 45454;
export const DISCOVERY_MAGIC = 'CN-WHITEBOARD';
export const DISCOVERY_VERSION = 1;
/** Datagrams larger than this are dropped unparsed. */
export const MAX_DISCOVERY_DATAGRAM_BYTES = 512;
/** How long a client waits for replies during one scan. */
export const DISCOVERY_SCAN_MS = 1500;

const ProbeSchema = z.object({
  magic: z.literal(DISCOVERY_MAGIC),
  v: z.literal(DISCOVERY_VERSION),
  type: z.literal('PROBE'),
});

export const DiscoveryAnnounceSchema = z.object({
  magic: z.literal(DISCOVERY_MAGIC),
  v: z.literal(DISCOVERY_VERSION),
  type: z.literal('ANNOUNCE'),
  /** Human friendly server name (the machine's hostname). */
  name: z.string().min(1).max(64),
  /** TCP port the whiteboard server accepts connections on. */
  port: z.number().int().min(1).max(65535),
  /** Number of rooms currently held, so users can tell a busy server from an empty one. */
  rooms: z.number().int().nonnegative().max(1_000_000),
  appVersion: z.string().max(32),
});

export type DiscoveryAnnounce = z.infer<typeof DiscoveryAnnounceSchema>;

export function encodeDiscoveryProbe(): Buffer {
  return Buffer.from(
    JSON.stringify({ magic: DISCOVERY_MAGIC, v: DISCOVERY_VERSION, type: 'PROBE' }),
  );
}

export function encodeDiscoveryAnnounce(
  info: Omit<DiscoveryAnnounce, 'magic' | 'v' | 'type'>,
): Buffer {
  return Buffer.from(
    JSON.stringify({ magic: DISCOVERY_MAGIC, v: DISCOVERY_VERSION, type: 'ANNOUNCE', ...info }),
  );
}

function parseJson(data: Buffer): unknown {
  if (data.length === 0 || data.length > MAX_DISCOVERY_DATAGRAM_BYTES) return null;
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    return null;
  }
}

/** True only for a well-formed probe from a compatible client. */
export function isDiscoveryProbe(data: Buffer): boolean {
  return ProbeSchema.safeParse(parseJson(data)).success;
}

/** The announcement carried by `data`, or null for anything that is not a valid one. */
export function parseDiscoveryAnnounce(data: Buffer): DiscoveryAnnounce | null {
  const result = DiscoveryAnnounceSchema.safeParse(parseJson(data));
  return result.success ? result.data : null;
}

/** A network interface entry in the shape of `os.networkInterfaces()` (kept dependency free). */
export interface InterfaceInfo {
  family: string | number;
  address: string;
  netmask: string;
  internal: boolean;
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

function intToIp(n: number): string {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 255).join('.');
}

/**
 * Directed broadcast addresses of every external IPv4 interface (e.g. 192.168.1.255). Sending
 * to each is more reliable than the limited broadcast 255.255.255.255, which many OSes route out
 * of only one interface.
 */
export function getBroadcastAddresses(
  interfaces: Record<string, InterfaceInfo[] | undefined>,
): string[] {
  const out = new Set<string>();
  for (const entries of Object.values(interfaces)) {
    for (const e of entries ?? []) {
      if ((e.family !== 'IPv4' && e.family !== 4) || e.internal) continue;
      const ip = ipToInt(e.address);
      const mask = ipToInt(e.netmask);
      out.add(intToIp(((ip & mask) | (~mask >>> 0)) >>> 0));
    }
  }
  return [...out];
}
