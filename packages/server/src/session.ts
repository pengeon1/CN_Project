/**
 * @fileoverview Manages an individual client TCP connection lifecycle,
 * backpressure mitigation, message framing, and outgoing queue buffering.
 */

import { EventEmitter } from 'node:events';
import type * as net from 'node:net';
import {
  encodeFrame,
  FrameDecoder,
  type MessageEnvelope,
  MessageType,
  type Role,
} from '@cn-whiteboard/common';
import { Logger } from './logger.js';

interface QueuedMessage {
  buffer: Buffer;
  isCursor: boolean;
}

const MAX_OUTGOING_QUEUE_SIZE = 500;
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;

/**
 * Represents a connected client over a raw TCP socket.
 */
export class ClientSession extends EventEmitter {
  public sessionId: string;
  public userId: string;
  public username: string | null = null;
  public role: Role | null = null;
  public color: string | null = null;
  public roomCode: string | null = null;
  public lastSeenAt: number;

  private socket: net.Socket;
  private decoder: FrameDecoder;
  private outgoingQueue: QueuedMessage[] = [];
  private isDraining = false;
  private isDestroyed = false;
  private logger: Logger;

  constructor(sessionId: string, userId: string, socket: net.Socket) {
    super();
    this.sessionId = sessionId;
    this.userId = userId;
    this.socket = socket;
    this.lastSeenAt = Date.now();
    this.decoder = new FrameDecoder();
    this.logger = new Logger(`Session ${sessionId.slice(0, 8)}`);

    // Disable Nagle's algorithm to deliver low-latency real-time canvas events
    this.socket.setNoDelay(true);

    // OS-level keepalive probes help surface half-open TCP connections (for example, a client
    // whose network vanished) in addition to the application-level heartbeat.
    this.socket.setKeepAlive(true, KEEPALIVE_INITIAL_DELAY_MS);

    this.setupSocketListeners();
  }

  public get remoteAddress(): string {
    return `${this.socket.remoteAddress ?? 'unknown'}:${this.socket.remotePort ?? 0}`;
  }

  public get remoteIp(): string {
    return this.socket.remoteAddress ?? 'unknown';
  }

  /**
   * True once the session has been torn down and can no longer send or receive.
   */
  public get isClosed(): boolean {
    return this.isDestroyed;
  }

  private setupSocketListeners(): void {
    this.socket.on('data', (chunk: Buffer) => {
      this.lastSeenAt = Date.now();
      try {
        const messages = this.decoder.feed(chunk);
        for (const message of messages) {
          this.emit('message', message);
        }
      } catch (err) {
        this.logger.warn(`Framing decode error from ${this.remoteAddress}:`, err);
        this.destroy('Framing or payload protocol violation');
      }
    });

    this.socket.on('drain', () => {
      this.isDraining = false;
      this.flushQueue();
    });

    this.socket.on('error', (err: Error) => {
      // A socket error (ECONNRESET, EPIPE, ETIMEDOUT...) means this connection is unusable.
      // Never re-emit it as an 'error' event: an EventEmitter with no 'error' listener throws,
      // which would crash the whole server because of a single misbehaving client.
      this.logger.warn(`Socket error on ${this.remoteAddress}: ${err.message}`);
      this.destroy(`Socket error: ${err.message}`);
    });

    this.socket.on('close', (hadError: boolean) => {
      if (!this.isDestroyed) {
        this.destroy(hadError ? 'Socket closed with error' : 'Socket connection closed');
      }
    });
  }

  /**
   * Encodes and sends a MessageEnvelope to the client over TCP.
   * Manages backpressure by buffering into a bounded queue if the kernel socket buffer is full.
   *
   * @param envelope The protocol MessageEnvelope to transmit.
   * @returns true if written directly or queued; false if dropped due to buffer overflow.
   */
  public send(envelope: MessageEnvelope): boolean {
    if (this.isDestroyed || this.socket.destroyed) {
      return false;
    }

    const buffer = encodeFrame(envelope);
    const isCursor = envelope.type === MessageType.CURSOR_MOVE;

    if (this.isDraining || this.outgoingQueue.length > 0) {
      return this.enqueue(buffer, isCursor);
    }

    // Direct write attempt
    const canContinue = this.socket.write(buffer);
    if (!canContinue) {
      this.isDraining = true;
    }
    return true;
  }

  private enqueue(buffer: Buffer, isCursor: boolean): boolean {
    // Check queue bounds to prevent slow-client memory leaks
    if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE_SIZE) {
      // Step 1: Drop ephemeral cursor messages first
      const beforeCount = this.outgoingQueue.length;
      this.outgoingQueue = this.outgoingQueue.filter((item) => !item.isCursor);
      const droppedCursors = beforeCount - this.outgoingQueue.length;

      if (droppedCursors > 0) {
        this.logger.debug(
          `Dropped ${droppedCursors} queued cursor messages to alleviate backpressure for client ${this.userId}`,
        );
      }

      // Step 2: If queue is still overflowing, drop the slow client so it does not stall other collaborators
      if (this.outgoingQueue.length >= MAX_OUTGOING_QUEUE_SIZE) {
        this.logger.warn(
          `Outgoing queue overflowed (${this.outgoingQueue.length} messages). Disconnecting slow client ${this.userId}`,
        );
        this.destroy('Outgoing socket queue buffer overflow');
        return false;
      }
    }

    this.outgoingQueue.push({ buffer, isCursor });
    return true;
  }

  private flushQueue(): void {
    while (this.outgoingQueue.length > 0) {
      const item = this.outgoingQueue[0];
      if (!item) break;

      const canContinue = this.socket.write(item.buffer);
      this.outgoingQueue.shift();

      if (!canContinue) {
        this.isDraining = true;
        break;
      }
    }
  }

  /**
   * Gracefully tears down the socket connection and releases internal resources.
   *
   * @param reason Diagnostic explanation for session termination.
   */
  public destroy(reason?: string): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    this.logger.info(
      `Session terminating for ${this.remoteAddress}. Reason: ${reason ?? 'normal'}`,
    );
    this.outgoingQueue = [];
    this.decoder.reset();

    if (!this.socket.destroyed) {
      this.socket.destroy();
    }

    this.emit('close', reason);
    this.removeAllListeners();
  }
}
