/**
 * @fileoverview Main process TCP client manager.
 * Orchestrates raw TCP socket communication with the central whiteboard server.
 * Never exposes raw sockets or Node networking to the renderer process.
 *
 * This class is also the client's reliability layer. Everything the renderer receives from it is
 * an exactly-once, strictly in-order stream of room events, even if the network duplicates,
 * delays or loses frames, or the connection drops and comes back:
 *
 * - Ordering: sequenced events are applied in `seq` order. Early arrivals are buffered, duplicates
 *   are dropped.
 * - Gap recovery: if a gap does not close within `gapWaitMs`, a RESYNC_REQUEST fetches the missing
 *   operations (or a snapshot). The heartbeat PONG carries the room's seq, so even a lost *tail*
 *   of events is detected.
 * - Delivery: operations the user performs are kept in an outbox until the server echoes or
 *   acknowledges them, and are retransmitted after a reconnect. The server de-duplicates on
 *   `op_id`, so retransmission is safe.
 * - Liveness: periodic PING/PONG; sustained silence is treated as a dead connection.
 * - Reconnect: exponential backoff with jitter, the session token restores the participant's
 *   identity, and the last applied seq lets the server send only what was missed.
 */

import * as net from 'node:net';
import {
  createEnvelope,
  encodeFrame,
  FrameDecoder,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  isReliableClientOp,
  isSequencedType,
  type MessageEnvelope,
  MessageType,
  reliableOpKey,
  type ResyncResponsePayload,
  type RoomStatePayload,
  type SequencedOperation,
} from '@cn-whiteboard/common';
import type { ConnectOptions, ConnectionStatusEvent } from '../src/types/ipc.js';

/**
 * Where the client delivers its output. In the app this forwards to the renderer window;
 * tests supply their own sink.
 */
export interface TcpClientSink {
  status(event: ConnectionStatusEvent): void;
  message(envelope: MessageEnvelope): void;
}

/**
 * Tunable timings (milliseconds). Defaults suit a LAN; tests shrink them.
 */
export interface TcpClientTimings {
  /** Interval between PING heartbeats. */
  heartbeatIntervalMs: number;
  /** Silence from the server after which the connection is considered dead. */
  heartbeatTimeoutMs: number;
  /** First reconnect delay; doubles on every failed attempt. */
  reconnectBaseMs: number;
  /** Upper bound for the reconnect delay. */
  reconnectMaxMs: number;
  /** How long a sequence gap may stay open before a resync is requested. */
  gapWaitMs: number;
  /** How long to wait for a RESYNC_RESPONSE before asking again. */
  resyncTimeoutMs: number;
  /** Maximum time to wait for the initial connect + join to complete. */
  connectTimeoutMs: number;
}

export const DEFAULT_TCP_CLIENT_TIMINGS: TcpClientTimings = {
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
  reconnectBaseMs: 500,
  reconnectMaxMs: 5000,
  gapWaitMs: 250,
  resyncTimeoutMs: 2000,
  connectTimeoutMs: 8000,
};

/**
 * Counters that make the reliability layer observable (used by tests and diagnostics).
 */
export interface TcpClientStats {
  /** Reconnect attempts scheduled. */
  reconnectAttempts: number;
  /** RESYNC_REQUESTs sent because of a gap. */
  resyncRequests: number;
  /** Reconnects completed with only the missed operations. */
  incrementalResumes: number;
  /** Reconnects or resyncs completed with a full snapshot. */
  snapshotResumes: number;
  /** Sequenced events dropped because they were already applied or buffered. */
  duplicatesDropped: number;
  /** Sequenced events that arrived ahead of a gap and had to wait. */
  outOfOrderBuffered: number;
  /** Outbox operations written again after a reconnect. */
  retransmitted: number;
}

type Phase = 'idle' | 'connecting' | 'joined' | 'reconnecting';

/** Upper bound on un-acknowledged operations kept for retransmission. */
const MAX_PENDING_OPS = 20_000;
/** Upper bound on early-arrival events held back while a gap is open. */
const MAX_REORDER_BUFFER = 5_000;

export class MainTcpClient {
  public readonly stats: TcpClientStats = {
    reconnectAttempts: 0,
    resyncRequests: 0,
    incrementalResumes: 0,
    snapshotResumes: 0,
    duplicatesDropped: 0,
    outOfOrderBuffered: 0,
    retransmitted: 0,
  };

  private readonly sink: TcpClientSink;
  private readonly timings: TcpClientTimings;

  // Connection state
  private socket: net.Socket | null = null;
  /** Incremented whenever the socket is replaced; events of older sockets are ignored. */
  private socketGen = 0;
  private decoder: FrameDecoder = new FrameDecoder();
  private phase: Phase = 'idle';
  private options: ConnectOptions | null = null;
  private sessionId: string | null = null;
  private userId: string | null = null;
  private roomCode: string | null = null;
  private authHandled = false;
  private awaitingRejoin = false;
  private isManualDisconnect = false;
  private lastReceivedAt = 0;
  private reconnectAttempt = 0;
  private connectResolver: ((result: { success: boolean; error?: string }) => void) | null = null;

  // Timers
  private pingTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  /** Bounds a single reconnect attempt (connect + handshake + rejoin). */
  private rejoinTimer: NodeJS.Timeout | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private gapTimer: NodeJS.Timeout | null = null;
  private resyncTimer: NodeJS.Timeout | null = null;

  // Ordered, exactly-once delivery of sequenced events
  /** Highest contiguous seq delivered to the sink; null until a snapshot establishes a baseline. */
  private lastSeq: number | null = null;
  /** Highest room seq the server is known to have reached (from PONGs and received events). */
  private tailSeq = 0;
  private reorder: Map<number, MessageEnvelope> = new Map();
  private resyncInFlight = false;

  // Outbox of operations awaiting acknowledgement, in send order
  private pending: Map<string, MessageEnvelope> = new Map();
  private pendingMsgIds: Map<string, string> = new Map();

  constructor(sink: TcpClientSink, timings: Partial<TcpClientTimings> = {}) {
    this.sink = sink;
    this.timings = { ...DEFAULT_TCP_CLIENT_TIMINGS, ...timings };
  }

  /** The room this client is in (or is trying to get back into), if any. */
  public getRoomCode(): string | null {
    return this.roomCode;
  }

  /** Number of operations sent but not yet acknowledged by the server. */
  public getPendingCount(): number {
    return this.pending.size;
  }

  /** Highest contiguous seq delivered so far, or null before the first snapshot. */
  public getLastSeq(): number | null {
    return this.lastSeq;
  }

  // ==========================================================================
  // Connecting
  // ==========================================================================

  /**
   * Connects to the TCP server and automatically runs the HELLO handshake
   * followed by CREATE_ROOM or JOIN_ROOM based on user options.
   */
  public connect(options: ConnectOptions): Promise<{ success: boolean; error?: string }> {
    this.disconnect();
    this.isManualDisconnect = false;
    this.options = options;
    this.phase = 'connecting';
    this.sink.status({ status: 'connecting' });

    return new Promise((resolve) => {
      this.connectResolver = resolve;
      this.connectTimer = setTimeout(() => {
        this.failInitialConnect('Connection timed out');
      }, this.timings.connectTimeoutMs);
      this.openSocket();
    });
  }

  private settleInitialConnect(result: { success: boolean; error?: string }): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    const resolve = this.connectResolver;
    this.connectResolver = null;
    resolve?.(result);
  }

  private failInitialConnect(error: string): void {
    if (!this.connectResolver) return;
    this.teardownSocket();
    this.phase = 'idle';
    this.sink.status({ status: 'error', error });
    this.settleInitialConnect({ success: false, error });
  }

  private openSocket(): void {
    const options = this.options;
    if (!options) return;

    const gen = ++this.socketGen;
    this.authHandled = false;
    this.decoder = new FrameDecoder();

    let socket: net.Socket;
    try {
      socket = net.createConnection({ host: options.host, port: options.port });
    } catch (err) {
      this.onSocketFailure(err instanceof Error ? err.message : String(err));
      return;
    }
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 10_000);

    // A reconnect attempt must not be able to hang forever (a black-holed SYN, or a server that
    // accepts the connection but never answers): give up on it and schedule the next attempt.
    if (this.phase === 'reconnecting') {
      this.clearRejoinTimer();
      this.rejoinTimer = setTimeout(() => {
        this.rejoinTimer = null;
        if (gen === this.socketGen && this.phase === 'reconnecting') {
          this.beginReconnect('Reconnect attempt timed out');
        }
      }, this.timings.connectTimeoutMs);
    }

    socket.on('connect', () => {
      if (gen !== this.socketGen) return;
      this.lastReceivedAt = Date.now();
      this.write(
        createEnvelope(MessageType.HELLO, {
          clientVersion: '0.1.0',
          suggestedUsername: options.username,
          sessionToken: this.sessionId ?? undefined,
        }),
      );
    });

    socket.on('data', (chunk: Buffer) => {
      if (gen !== this.socketGen) return;
      this.lastReceivedAt = Date.now();

      let envelopes: MessageEnvelope[];
      try {
        envelopes = this.decoder.feed(chunk);
      } catch (err) {
        console.error('[Main TCP] Frame decode error:', err);
        this.onSocketFailure('Protocol framing error');
        return;
      }
      for (const envelope of envelopes) {
        if (gen !== this.socketGen) return;
        this.handleEnvelope(envelope);
      }
    });

    // Listeners stay attached for the lifetime of the socket (even after it is replaced) so a
    // late 'error' on an abandoned socket can never become an unhandled exception.
    socket.on('error', (err: Error) => {
      if (gen !== this.socketGen) return;
      console.warn('[Main TCP] Socket error:', err.message);
      this.onSocketFailure(err.message);
    });

    socket.on('close', () => {
      if (gen !== this.socketGen) return;
      this.onSocketFailure('Connection closed');
    });
  }

  /**
   * Single entry point for "the current connection is no longer usable".
   */
  private onSocketFailure(reason: string): void {
    if (this.isManualDisconnect) return;
    if (!this.roomCode) {
      // Never made it into a room: report the failure to the caller of connect().
      this.failInitialConnect(reason);
      return;
    }
    this.beginReconnect(reason);
  }

  // ==========================================================================
  // Reconnecting
  // ==========================================================================

  private beginReconnect(reason: string): void {
    if (this.isManualDisconnect || !this.options || !this.roomCode) return;

    this.teardownSocket();
    this.clearReliabilityTimers();
    this.awaitingRejoin = false;
    this.phase = 'reconnecting';

    // Exponential backoff with +/-20% jitter so a room full of clients does not stampede the server.
    const base = Math.min(
      this.timings.reconnectBaseMs * 2 ** this.reconnectAttempt,
      this.timings.reconnectMaxMs,
    );
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    this.reconnectAttempt += 1;
    this.stats.reconnectAttempts += 1;

    this.sink.status({
      status: 'reconnecting',
      roomCode: this.roomCode,
      error: reason,
      attempt: this.reconnectAttempt,
      retryInMs: delay,
    });

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.phase === 'reconnecting' && !this.isManualDisconnect) {
        this.openSocket();
      }
    }, delay);
  }

  /**
   * Gives up on resuming the session (e.g. the room no longer exists).
   */
  private abandonSession(reason: string): void {
    this.teardownSocket();
    this.clearReliabilityTimers();
    this.resetSessionState();
    this.phase = 'idle';
    this.sink.status({ status: 'error', error: `Could not rejoin the session: ${reason}` });
  }

  // ==========================================================================
  // Incoming messages
  // ==========================================================================

  private handleEnvelope(envelope: MessageEnvelope): void {
    switch (envelope.type) {
      case MessageType.AUTH_OK:
        this.sink.message(envelope);
        this.onAuthOk(envelope);
        return;
      case MessageType.ROOM_STATE:
        this.onRoomState(envelope);
        return;
      case MessageType.RESYNC_RESPONSE:
        this.onResyncResponse(envelope);
        return;
      case MessageType.PONG:
        this.sink.message(envelope);
        this.onPong(envelope);
        return;
      case MessageType.ACK:
        this.sink.message(envelope);
        this.onAck(envelope);
        return;
      case MessageType.ERROR:
        this.onError(envelope);
        return;
      default:
        break;
    }

    if (isSequencedType(envelope.type) && envelope.seq > 0) {
      this.receiveSequenced(envelope);
      return;
    }

    // Unsequenced traffic (cursors, participant list, chat history...) is passed straight through.
    this.sink.message(envelope);
  }

  private onAuthOk(envelope: MessageEnvelope): void {
    // A duplicated AUTH_OK must not trigger a second CREATE_ROOM / JOIN_ROOM.
    if (this.authHandled) return;
    this.authHandled = true;

    const payload = envelope.payload as { sessionId: string; userId: string };
    this.sessionId = payload.sessionId;
    this.userId = payload.userId;

    const options = this.options;
    if (!options) return;
    const password = options.password || undefined;

    if (this.roomCode) {
      // Reconnect: resume the same participant and tell the server how far we got.
      this.awaitingRejoin = true;
      this.write(
        createEnvelope(
          MessageType.JOIN_ROOM,
          {
            roomCode: this.roomCode,
            username: options.username,
            password,
            sessionToken: this.sessionId,
            lastSeq: this.lastSeq ?? undefined,
          },
          { user_id: this.userId, room: this.roomCode },
        ),
      );
    } else if (options.action === 'create') {
      this.write(
        createEnvelope(
          MessageType.CREATE_ROOM,
          {
            roomName: options.roomName || `${options.username}'s Board`,
            username: options.username,
            password,
          },
          { user_id: this.userId },
        ),
      );
    } else {
      this.write(
        createEnvelope(
          MessageType.JOIN_ROOM,
          {
            roomCode: options.roomCode || '',
            username: options.username,
            password,
            sessionToken: this.sessionId,
          },
          { user_id: this.userId, room: options.roomCode || '' },
        ),
      );
    }
  }

  private onRoomState(envelope: MessageEnvelope): void {
    const payload = envelope.payload as RoomStatePayload;
    const expected = this.connectResolver !== null || this.awaitingRejoin;

    // A stale or duplicated snapshot must never rewind a client that is already ahead of it.
    if (!expected && this.lastSeq !== null && payload.seq <= this.lastSeq) {
      this.stats.duplicatesDropped += 1;
      return;
    }

    this.roomCode = payload.roomCode;
    if (envelope.user_id) this.userId = envelope.user_id;
    if (this.awaitingRejoin) this.stats.snapshotResumes += 1;

    // The renderer replaces its state with the snapshot, then receives any events that arrived
    // ahead of it, in order.
    this.sink.message(envelope);
    this.establishBaseline(payload.seq);
    this.completeJoin();
  }

  private onResyncResponse(envelope: MessageEnvelope): void {
    const payload = envelope.payload as ResyncResponsePayload;
    if (envelope.user_id) this.userId = envelope.user_id;

    const rejoin = this.awaitingRejoin;
    this.resyncInFlight = false;
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }

    if (payload.fullSnapshot) {
      // Too far behind for an incremental catch-up: adopt the snapshot.
      if (this.lastSeq === null || payload.fullSnapshot.seq > this.lastSeq) {
        this.stats.snapshotResumes += 1;
        this.sink.message(envelope);
        this.establishBaseline(payload.fullSnapshot.seq);
      }
    } else {
      if (rejoin) this.stats.incrementalResumes += 1;
      const operations = [...(payload.operations ?? [])].sort((a, b) => a.seq - b.seq);
      for (const op of operations) {
        this.receiveSequenced(this.operationToEnvelope(op));
      }
      this.tailSeq = Math.max(this.tailSeq, payload.to_seq);
      this.afterDrain();
    }

    if (rejoin) this.completeJoin();
  }

  private operationToEnvelope(op: SequencedOperation): MessageEnvelope {
    return createEnvelope(op.type, op.payload, {
      msg_id: op.op_id,
      seq: op.seq,
      ts: op.ts,
      user_id: op.userId,
      room: this.roomCode ?? '',
    });
  }

  private onPong(envelope: MessageEnvelope): void {
    const payload = envelope.payload as { roomSeq?: number };
    if (typeof payload.roomSeq === 'number') {
      this.tailSeq = Math.max(this.tailSeq, payload.roomSeq);
      this.afterDrain();
    }
  }

  private onAck(envelope: MessageEnvelope): void {
    const payload = envelope.payload as { target_msg_id?: string };
    if (payload.target_msg_id) {
      this.releasePendingByMsgId(payload.target_msg_id);
    }
  }

  private onError(envelope: MessageEnvelope): void {
    const payload = envelope.payload as {
      code: string;
      message: string;
      details?: { target_msg_id?: string };
    };

    // A rejected operation will never be accepted: stop retransmitting it.
    const target = payload.details?.target_msg_id;
    if (target) this.releasePendingByMsgId(target);

    this.sink.message(envelope);

    if (payload.code === 'JOIN_FAILED') {
      if (this.connectResolver) {
        this.failInitialConnect(payload.message);
      } else if (this.awaitingRejoin) {
        this.abandonSession(payload.message);
      }
    }
  }

  // ==========================================================================
  // Ordered, exactly-once delivery
  // ==========================================================================

  private receiveSequenced(envelope: MessageEnvelope): void {
    // An echo (or replay) of our own operation doubles as its acknowledgement.
    this.releasePending(envelope);

    if (this.lastSeq === null) {
      // No baseline yet (event raced ahead of the initial snapshot): hold it until one arrives.
      this.reorder.set(envelope.seq, envelope);
      return;
    }

    if (envelope.seq <= this.lastSeq || this.reorder.has(envelope.seq)) {
      this.stats.duplicatesDropped += 1;
      return;
    }

    if (envelope.seq > this.lastSeq + 1) {
      this.stats.outOfOrderBuffered += 1;
    }
    this.tailSeq = Math.max(this.tailSeq, envelope.seq);
    this.reorder.set(envelope.seq, envelope);

    if (this.reorder.size > MAX_REORDER_BUFFER) {
      // Pathological: stop buffering and fetch the range again instead.
      this.reorder.clear();
      this.requestResync();
      return;
    }
    this.drain();
  }

  /**
   * Adopts `seq` as the new baseline (after a snapshot), discarding anything it already contains.
   */
  private establishBaseline(seq: number): void {
    this.lastSeq = seq;
    this.tailSeq = Math.max(this.tailSeq, seq);
    this.drain();
  }

  /**
   * Delivers every buffered event that is next in line.
   */
  private drain(): void {
    if (this.lastSeq === null) return;

    let next = this.reorder.get(this.lastSeq + 1);
    while (next) {
      this.reorder.delete(next.seq);
      this.lastSeq = next.seq;
      this.sink.message(next);
      next = this.reorder.get(this.lastSeq + 1);
    }

    for (const buffered of this.reorder.keys()) {
      if (buffered <= this.lastSeq) this.reorder.delete(buffered);
    }
    this.afterDrain();
  }

  private isBehind(): boolean {
    return this.lastSeq !== null && (this.reorder.size > 0 || this.tailSeq > this.lastSeq);
  }

  private afterDrain(): void {
    if (this.isBehind()) {
      this.scheduleGapCheck();
    } else {
      this.clearGapTimer();
    }
  }

  /**
   * Gives a gap `gapWaitMs` to close by itself (a delayed frame may still be on its way) before
   * going to the server for the missing range.
   */
  private scheduleGapCheck(): void {
    if (this.gapTimer || this.resyncInFlight || this.phase !== 'joined') return;
    this.gapTimer = setTimeout(() => {
      this.gapTimer = null;
      if (this.isBehind()) this.requestResync();
    }, this.timings.gapWaitMs);
  }

  private requestResync(): void {
    if (
      this.resyncInFlight ||
      this.phase !== 'joined' ||
      this.lastSeq === null ||
      this.roomCode === null
    ) {
      return;
    }

    this.resyncInFlight = true;
    this.stats.resyncRequests += 1;
    this.write(
      createEnvelope(
        MessageType.RESYNC_REQUEST,
        { last_seq: this.lastSeq },
        { user_id: this.userId ?? '', room: this.roomCode },
      ),
    );

    // If the response never arrives, ask again.
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = null;
      this.resyncInFlight = false;
      if (this.isBehind()) this.requestResync();
    }, this.timings.resyncTimeoutMs);
  }

  private clearGapTimer(): void {
    if (this.gapTimer) {
      clearTimeout(this.gapTimer);
      this.gapTimer = null;
    }
  }

  private clearReliabilityTimers(): void {
    this.clearGapTimer();
    if (this.resyncTimer) {
      clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
    this.resyncInFlight = false;
  }

  // ==========================================================================
  // Joining & the outbox
  // ==========================================================================

  /**
   * Called once the server has admitted us to the room (initial join or successful rejoin).
   */
  private completeJoin(): void {
    this.clearRejoinTimer();
    const wasInitial = this.connectResolver !== null;
    const wasRejoin = this.awaitingRejoin;
    this.awaitingRejoin = false;
    this.phase = 'joined';
    this.reconnectAttempt = 0;

    if (wasInitial || wasRejoin) {
      this.startHeartbeat();
      this.sink.status({
        status: 'connected',
        roomCode: this.roomCode ?? undefined,
        userId: this.userId ?? undefined,
        sessionId: this.sessionId ?? undefined,
      });
      if (wasInitial) this.settleInitialConnect({ success: true });
      this.flushPending();
    }
    this.afterDrain();
  }

  private addPending(envelope: MessageEnvelope): void {
    const key = reliableOpKey(envelope);
    this.pending.set(key, envelope);
    this.pendingMsgIds.set(envelope.msg_id, key);
  }

  private releaseByKey(key: string): void {
    const envelope = this.pending.get(key);
    if (!envelope) return;
    this.pending.delete(key);
    this.pendingMsgIds.delete(envelope.msg_id);
  }

  private releasePendingByMsgId(msgId: string): void {
    const key = this.pendingMsgIds.get(msgId);
    if (key !== undefined) this.releaseByKey(key);
  }

  private releasePending(envelope: MessageEnvelope): void {
    if (this.pending.size === 0) return;
    this.releaseByKey(reliableOpKey(envelope));
    this.releasePendingByMsgId(envelope.msg_id);
  }

  /**
   * Re-sends every un-acknowledged operation, oldest first. Safe because the server ignores
   * operations it has already applied (and acknowledges them again).
   */
  private flushPending(): void {
    for (const envelope of this.pending.values()) {
      if (!this.write(envelope)) break;
      this.stats.retransmitted += 1;
    }
  }

  // ==========================================================================
  // Heartbeat
  // ==========================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket || socket.destroyed) return;

      if (Date.now() - this.lastReceivedAt > this.timings.heartbeatTimeoutMs) {
        console.warn(
          `[Main TCP] No data from server for >${this.timings.heartbeatTimeoutMs}ms. Reconnecting.`,
        );
        this.beginReconnect('Server heartbeat timeout');
        return;
      }

      this.write(
        createEnvelope(
          MessageType.PING,
          { nonce: Math.floor(Math.random() * 100000) },
          { user_id: this.userId ?? '', room: this.roomCode ?? '' },
        ),
      );
    }, this.timings.heartbeatIntervalMs);
  }

  private clearRejoinTimer(): void {
    if (this.rejoinTimer) {
      clearTimeout(this.rejoinTimer);
      this.rejoinTimer = null;
    }
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ==========================================================================
  // Sending
  // ==========================================================================

  /**
   * Transmits a framed MessageEnvelope over the TCP socket.
   *
   * Operations that change shared state (strokes, erasures, chat, ...) are accepted even while
   * the connection is down: they are kept in the outbox and delivered after reconnecting.
   * Everything else (cursors, heartbeats...) is only sent while connected.
   *
   * @returns true if the message was sent or queued for delivery.
   */
  public send(envelope: MessageEnvelope): boolean {
    if (isReliableClientOp(envelope.type)) {
      if (this.pending.size >= MAX_PENDING_OPS) {
        console.warn('[Main TCP] Outbox is full; dropping new operation.');
        return false;
      }
      this.addPending(envelope);
      if (this.phase === 'joined') this.write(envelope);
      return true;
    }
    if (this.phase !== 'joined') return false;
    return this.write(envelope);
  }

  /**
   * Writes a frame to the socket. Returns false if there is no writable socket.
   */
  private write(envelope: MessageEnvelope): boolean {
    const socket = this.socket;
    if (!socket || socket.destroyed || !socket.writable) return false;
    try {
      socket.write(encodeFrame(envelope));
      return true;
    } catch (err) {
      console.error('[Main TCP] Write failed:', err);
      return false;
    }
  }

  // ==========================================================================
  // Teardown
  // ==========================================================================

  /**
   * Destroys the current socket. Its listeners stay attached but are invalidated, so nothing it
   * emits afterwards has any effect.
   */
  private teardownSocket(): void {
    this.socketGen += 1;
    this.stopHeartbeat();
    this.clearRejoinTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
    this.decoder.reset();
  }

  /**
   * Forgets everything about the current room session (but keeps the session token so that a
   * later connect() can still resume the same identity).
   */
  private resetSessionState(): void {
    this.roomCode = null;
    this.lastSeq = null;
    this.tailSeq = 0;
    this.reorder.clear();
    this.pending.clear();
    this.pendingMsgIds.clear();
    this.awaitingRejoin = false;
    this.reconnectAttempt = 0;
  }

  public disconnect(): void {
    this.isManualDisconnect = true;
    this.teardownSocket();
    this.clearReliabilityTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.resetSessionState();
    this.phase = 'idle';
    if (this.connectResolver) {
      this.settleInitialConnect({ success: false, error: 'Disconnected' });
    }
    this.sink.status({ status: 'disconnected' });
  }
}
