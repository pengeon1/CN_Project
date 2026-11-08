/**
 * @fileoverview Lossy TCP proxy: a test harness that sits between whiteboard clients and the
 * server and misbehaves on purpose.
 *
 * The proxy understands the wire format, so it can treat each protocol frame as a unit and:
 * - delay frames by a random amount,
 * - duplicate frames (the copy may arrive later than the original),
 * - reorder frames (swap a frame with the one after it),
 * - drop frames,
 * and it can cut every connection, refuse new ones (a network outage), or sever only the client
 * side of a connection while leaving the server side open (a half-open connection that the server
 * has not noticed yet).
 *
 * Fault model. Real TCP never loses, duplicates or reorders bytes *within* a connection, so the
 * faults are scoped to what can actually go wrong:
 * - Faults apply to data-plane frames (drawing, chat, participant events, cursors). Control-plane
 *   frames (handshake, join, snapshots, resync, heartbeat, acks, errors) pass through untouched.
 * - Server -> client faults include drops and reordering: they model a relay or a bug that loses
 *   events, which the client must detect and repair.
 * - Client -> server direction defaults to FIFO delivery with delays and duplicates only. Losing
 *   or reordering a client frame *without* breaking the connection cannot happen on TCP; what can
 *   happen is that a connection dies with frames in flight, which `cutAll`/`setOnline(false)`
 *   models.
 *
 * Randomness comes from a seeded PRNG so a failing run can be reproduced.
 */

import * as net from 'node:net';
import {
  encodeFrame,
  FrameDecoder,
  type MessageEnvelope,
  MessageType,
} from '@cn-whiteboard/common';

export type Direction = 'toClient' | 'toServer';

export interface DirectionFaults {
  /** Probability that a data-plane frame is silently lost. */
  dropRate: number;
  /** Probability that a data-plane frame is delivered twice. */
  duplicateRate: number;
  /** Probability that a data-plane frame swaps places with the frame after it. */
  reorderRate: number;
  /** Delay applied to each data-plane frame, uniformly between these bounds. */
  minDelayMs: number;
  maxDelayMs: number;
  /** When true, delays never let a frame overtake an earlier one (FIFO, like TCP). */
  ordered: boolean;
  /** Frame types the faults apply to; everything else passes through immediately. */
  types: ReadonlySet<MessageType>;
}

export interface DirectionStats {
  forwarded: number;
  dropped: number;
  duplicated: number;
  reordered: number;
}

export const DATA_PLANE_TYPES: ReadonlySet<MessageType> = new Set<MessageType>([
  MessageType.PARTICIPANT_JOINED,
  MessageType.PARTICIPANT_LEFT,
  MessageType.PERMISSION_CHANGE,
  MessageType.STROKE_BEGIN,
  MessageType.STROKE_POINTS,
  MessageType.STROKE_END,
  MessageType.ERASE,
  MessageType.CLEAR_CANVAS,
  MessageType.CHAT_MESSAGE,
  MessageType.CURSOR_MOVE,
]);

function noFaults(ordered: boolean): DirectionFaults {
  return {
    dropRate: 0,
    duplicateRate: 0,
    reorderRate: 0,
    minDelayMs: 0,
    maxDelayMs: 0,
    ordered,
    types: DATA_PLANE_TYPES,
  };
}

function emptyStats(): DirectionStats {
  return { forwarded: 0, dropped: 0, duplicated: 0, reordered: 0 };
}

/** Small, fast, seedable PRNG (mulberry32). */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface DirectionState {
  decoder: FrameDecoder;
  /** Earliest time the next frame may be released while preserving order. */
  lastRelease: number;
  /** A frame being held back so that the next one can overtake it. */
  held: MessageEnvelope | null;
  heldTimer: NodeJS.Timeout | null;
  /**
   * FIFO of frames waiting for their release time (ordered mode only). A single timer drains it
   * strictly head-first, so frames can never overtake one another.
   */
  queue: Array<{ at: number; envelope: MessageEnvelope }>;
  queueTimer: NodeJS.Timeout | null;
}

interface Pair {
  client: net.Socket;
  upstream: net.Socket;
  /** True once the client side was cut on purpose while the upstream stays open. */
  severed: boolean;
  toClient: DirectionState;
  toServer: DirectionState;
}

export class LossyProxy {
  public readonly stats: Record<Direction, DirectionStats> = {
    toClient: emptyStats(),
    toServer: emptyStats(),
  };

  private readonly faults: Record<Direction, DirectionFaults> = {
    toClient: noFaults(false),
    toServer: noFaults(true),
  };

  private readonly server: net.Server;
  private readonly pairs: Set<Pair> = new Set();
  private readonly timers: Set<NodeJS.Timeout> = new Set();
  private readonly random: () => number;
  private online = true;
  private listeningPort = 0;

  private constructor(
    private readonly target: { host: string; port: number },
    seed: number,
  ) {
    this.random = createRandom(seed);
    this.server = net.createServer((socket) => this.onClientConnection(socket));
  }

  /**
   * Starts a proxy on an ephemeral local port that relays to `target`.
   */
  public static async start(
    target: { host: string; port: number },
    seed = 20260108,
  ): Promise<LossyProxy> {
    const proxy = new LossyProxy(target, seed);
    await new Promise<void>((resolve) => proxy.server.listen(0, '127.0.0.1', resolve));
    proxy.listeningPort = (proxy.server.address() as net.AddressInfo).port;
    return proxy;
  }

  public get port(): number {
    return this.listeningPort;
  }

  /**
   * Changes the faults applied in one direction. Unspecified fields keep their current value.
   */
  public setFaults(direction: Direction, faults: Partial<DirectionFaults>): void {
    this.faults[direction] = { ...this.faults[direction], ...faults };
  }

  /**
   * Removes all faults (both directions). Connections stay up.
   */
  public clearFaults(): void {
    this.faults.toClient = noFaults(false);
    this.faults.toServer = noFaults(true);
  }

  /**
   * Simulates a network outage (false) or its end (true). Going offline cuts every connection
   * (frames in flight are lost) and makes the proxy drop new connections on arrival.
   */
  public setOnline(online: boolean): void {
    this.online = online;
    if (!online) this.cutAll();
  }

  /**
   * Cuts every connection on both sides.
   */
  public cutAll(): void {
    for (const pair of this.pairs) {
      pair.client.destroy();
      pair.upstream.destroy();
    }
  }

  /**
   * Cuts only the client side of every connection. The server side stays open and silent, so the
   * server still believes those clients are connected (a half-open connection).
   */
  public severClients(): void {
    for (const pair of this.pairs) {
      pair.severed = true;
      pair.client.destroy();
    }
  }

  public async close(): Promise<void> {
    this.online = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const pair of this.pairs) {
      this.clearHeld(pair.toClient);
      this.clearHeld(pair.toServer);
      this.clearQueue(pair.toClient);
      this.clearQueue(pair.toServer);
      pair.client.destroy();
      pair.upstream.destroy();
    }
    this.pairs.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  // ------------------------------------------------------------------------------------------

  private newDirectionState(): DirectionState {
    return {
      decoder: new FrameDecoder(),
      lastRelease: 0,
      held: null,
      heldTimer: null,
      queue: [],
      queueTimer: null,
    };
  }

  private onClientConnection(client: net.Socket): void {
    if (!this.online) {
      client.destroy();
      return;
    }

    const upstream = net.createConnection({ host: this.target.host, port: this.target.port });
    const pair: Pair = {
      client,
      upstream,
      severed: false,
      toClient: this.newDirectionState(),
      toServer: this.newDirectionState(),
    };
    this.pairs.add(pair);

    // Do not read from the client until the upstream is ready, so nothing is lost.
    client.pause();
    upstream.once('connect', () => client.resume());

    client.on('data', (chunk) => this.pump(pair, 'toServer', chunk));
    upstream.on('data', (chunk) => this.pump(pair, 'toClient', chunk));

    // Errors are expected (we cause them); they just end the pair.
    client.on('error', () => undefined);
    upstream.on('error', () => undefined);

    client.on('close', () => {
      if (!pair.severed) upstream.destroy();
    });
    upstream.on('close', () => {
      client.destroy();
      this.clearHeld(pair.toClient);
      this.clearHeld(pair.toServer);
      this.clearQueue(pair.toClient);
      this.clearQueue(pair.toServer);
      this.pairs.delete(pair);
    });
  }

  private clearHeld(state: DirectionState): void {
    if (state.heldTimer) {
      clearTimeout(state.heldTimer);
      state.heldTimer = null;
    }
    state.held = null;
  }

  private clearQueue(state: DirectionState): void {
    if (state.queueTimer) {
      clearTimeout(state.queueTimer);
      state.queueTimer = null;
    }
    state.queue = [];
  }

  /**
   * Adds a frame to the FIFO of an ordered direction. Frames leave the queue strictly in the
   * order they entered it, each no earlier than its own release time.
   *
   * (Independent per-frame timers are not good enough here: two timers that fall due in the same
   * millisecond can fire in either order, which would let a frame overtake another. Real TCP
   * never does that, and the protocol relies on it.)
   */
  private enqueueOrdered(
    pair: Pair,
    direction: Direction,
    envelope: MessageEnvelope,
    releaseAt: number,
  ): void {
    const state = pair[direction];
    state.queue.push({ at: releaseAt, envelope });
    if (!state.queueTimer) {
      this.armQueue(pair, direction);
    }
  }

  private armQueue(pair: Pair, direction: Direction): void {
    const state = pair[direction];
    const head = state.queue[0];
    if (!head) return;

    state.queueTimer = setTimeout(
      () => {
        state.queueTimer = null;
        const now = Date.now();
        while (state.queue.length > 0 && state.queue[0]!.at <= now) {
          const item = state.queue.shift()!;
          this.emit(pair, direction, item.envelope);
        }
        if (state.queue.length > 0) {
          this.armQueue(pair, direction);
        }
      },
      Math.max(0, head.at - Date.now()),
    );
  }

  private later(delayMs: number, action: () => void): void {
    const timer = setTimeout(
      () => {
        this.timers.delete(timer);
        action();
      },
      Math.max(0, delayMs),
    );
    this.timers.add(timer);
  }

  private pump(pair: Pair, direction: Direction, chunk: Buffer): void {
    let envelopes: MessageEnvelope[];
    try {
      envelopes = pair[direction].decoder.feed(chunk);
    } catch {
      pair.client.destroy();
      pair.upstream.destroy();
      return;
    }
    for (const envelope of envelopes) {
      this.forward(pair, direction, envelope);
    }
  }

  private emit(pair: Pair, direction: Direction, envelope: MessageEnvelope): void {
    const destination = direction === 'toClient' ? pair.client : pair.upstream;
    if (destination.destroyed || !destination.writable) return;
    destination.write(encodeFrame(envelope));
    this.stats[direction].forwarded += 1;
  }

  private forward(pair: Pair, direction: Direction, envelope: MessageEnvelope): void {
    const faults = this.faults[direction];
    const state = pair[direction];

    // Control-plane traffic is never tampered with.
    if (!faults.types.has(envelope.type)) {
      this.emit(pair, direction, envelope);
      return;
    }

    if (this.random() < faults.dropRate) {
      this.stats[direction].dropped += 1;
      return;
    }

    // A frame is being held back: let this one overtake it.
    if (state.held) {
      const held = state.held;
      this.clearHeld(state);
      this.stats[direction].reordered += 1;
      this.schedule(pair, direction, envelope, true);
      this.schedule(pair, direction, held, false);
      return;
    }

    if (this.random() < faults.reorderRate) {
      state.held = envelope;
      // Never hold a frame forever: release it if nothing follows.
      state.heldTimer = setTimeout(() => {
        state.heldTimer = null;
        const held = state.held;
        state.held = null;
        if (held) this.schedule(pair, direction, held, false);
      }, 60);
      return;
    }

    this.schedule(pair, direction, envelope, true);
  }

  private schedule(
    pair: Pair,
    direction: Direction,
    envelope: MessageEnvelope,
    allowDuplicate: boolean,
  ): void {
    const faults = this.faults[direction];
    const state = pair[direction];

    const delay =
      faults.minDelayMs + this.random() * Math.max(0, faults.maxDelayMs - faults.minDelayMs);
    let releaseAt = Date.now() + delay;

    if (faults.ordered) {
      // FIFO: a frame is never released before the one ahead of it.
      releaseAt = Math.max(releaseAt, state.lastRelease);
      state.lastRelease = releaseAt;
      this.enqueueOrdered(pair, direction, envelope, releaseAt);

      if (allowDuplicate && this.random() < faults.duplicateRate) {
        this.stats[direction].duplicated += 1;
        // The copy follows its original (after up to 30ms) without letting later frames overtake.
        const copyAt = releaseAt + this.random() * 30;
        state.lastRelease = copyAt;
        this.enqueueOrdered(pair, direction, envelope, copyAt);
      }
      return;
    }

    // Unordered: every frame travels on its own timer, so frames may overtake each other.
    const wait = releaseAt - Date.now();
    this.later(wait, () => this.emit(pair, direction, envelope));

    if (allowDuplicate && this.random() < faults.duplicateRate) {
      this.stats[direction].duplicated += 1;
      // The duplicate trails the original by up to 30ms (so it can also arrive "late").
      this.later(wait + this.random() * 30, () => this.emit(pair, direction, envelope));
    }
  }
}
