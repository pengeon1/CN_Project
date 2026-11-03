/**
 * @fileoverview Main process TCP client manager.
 * Orchestrates raw TCP socket communication with the central whiteboard server.
 * Never exposes raw sockets or Node networking to the renderer process.
 */

import * as net from 'node:net';
import type { BrowserWindow } from 'electron';
import {
  createEnvelope,
  encodeFrame,
  FrameDecoder,
  type MessageEnvelope,
  MessageType,
  type RoomStatePayload,
} from '@cn-whiteboard/common';
import type { ConnectOptions, ConnectionStatusEvent } from '../src/types/ipc.js';

export class MainTcpClient {
  private socket: net.Socket | null = null;
  private decoder: FrameDecoder = new FrameDecoder();
  private window: BrowserWindow;
  private pingTimer: NodeJS.Timeout | null = null;
  private currentOptions: ConnectOptions | null = null;
  private sessionId: string | null = null;
  private userId: string | null = null;
  private roomCode: string | null = null;

  constructor(window: BrowserWindow) {
    this.window = window;
  }

  private notifyStatus(status: ConnectionStatusEvent): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('tcp:status', status);
    }
  }

  private notifyMessage(envelope: MessageEnvelope): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send('tcp:message', envelope);
    }
  }

  /**
   * Connects to the TCP server and automatically runs the HELLO handshake
   * followed by CREATE_ROOM or JOIN_ROOM based on user options.
   */
  public async connect(options: ConnectOptions): Promise<{ success: boolean; error?: string }> {
    this.disconnect();
    this.currentOptions = options;
    this.notifyStatus({ status: 'connecting' });

    return new Promise((resolve) => {
      let resolved = false;

      const finish = (result: { success: boolean; error?: string }) => {
        if (!resolved) {
          resolved = true;
          resolve(result);
        }
      };

      try {
        this.socket = net.createConnection({ host: options.host, port: options.port }, () => {
          this.socket?.setNoDelay(true);

          // Step 1: Transmit HELLO handshake
          const helloEnvelope = createEnvelope(MessageType.HELLO, {
            clientVersion: '0.1.0',
            suggestedUsername: options.username,
          });
          this.send(helloEnvelope);
        });

        this.socket.on('data', (chunk: Buffer) => {
          try {
            const envelopes = this.decoder.feed(chunk);
            for (const envelope of envelopes) {
              this.handleIncomingEnvelope(envelope, finish);
            }
          } catch (err) {
            console.error('[Main TCP] Frame decode error:', err);
          }
        });

        this.socket.on('error', (err: Error) => {
          console.warn('[Main TCP] Socket error:', err.message);
          this.notifyStatus({ status: 'error', error: err.message });
          finish({ success: false, error: err.message });
        });

        this.socket.on('close', () => {
          this.cleanup();
          this.notifyStatus({ status: 'disconnected' });
          finish({ success: false, error: 'Connection closed' });
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        finish({ success: false, error: errorMsg });
      }
    });
  }

  private handleIncomingEnvelope(
    envelope: MessageEnvelope,
    onConnectFinish: (result: { success: boolean; error?: string }) => void,
  ): void {
    // Forward every message to renderer
    this.notifyMessage(envelope);

    switch (envelope.type) {
      case MessageType.AUTH_OK: {
        const payload = envelope.payload as { sessionId: string; userId: string };
        this.sessionId = payload.sessionId;
        this.userId = payload.userId;

        // Step 2: Proceed to host or join room
        if (this.currentOptions) {
          if (this.currentOptions.action === 'create') {
            const createEnvelopeMsg = createEnvelope(
              MessageType.CREATE_ROOM,
              {
                roomName: this.currentOptions.roomName || `${this.currentOptions.username}'s Board`,
                username: this.currentOptions.username,
                password: this.currentOptions.password,
              },
              { user_id: this.userId },
            );
            this.send(createEnvelopeMsg);
          } else {
            const joinEnvelopeMsg = createEnvelope(
              MessageType.JOIN_ROOM,
              {
                roomCode: this.currentOptions.roomCode || '',
                username: this.currentOptions.username,
                password: this.currentOptions.password,
                sessionToken: this.sessionId,
              },
              { user_id: this.userId, room: this.currentOptions.roomCode || '' },
            );
            this.send(joinEnvelopeMsg);
          }
        }
        break;
      }

      case MessageType.ROOM_STATE: {
        const payload = envelope.payload as RoomStatePayload;
        this.roomCode = payload.roomCode;

        this.startHeartbeat();
        this.notifyStatus({
          status: 'connected',
          roomCode: this.roomCode,
          userId: this.userId ?? undefined,
          sessionId: this.sessionId ?? undefined,
        });

        onConnectFinish({ success: true });
        break;
      }

      case MessageType.ERROR: {
        const payload = envelope.payload as { code: string; message: string };
        if (payload.code === 'JOIN_FAILED') {
          onConnectFinish({ success: false, error: payload.message });
        }
        break;
      }
    }
  }

  private startHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);

    this.pingTimer = setInterval(() => {
      if (this.socket && !this.socket.destroyed) {
        const pingMsg = createEnvelope(
          MessageType.PING,
          { nonce: Math.floor(Math.random() * 100000) },
          { user_id: this.userId ?? '', room: this.roomCode ?? '' },
        );
        this.send(pingMsg);
      }
    }, 5000);
  }

  /**
   * Transmits a framed MessageEnvelope over the TCP socket.
   */
  public send(envelope: MessageEnvelope): boolean {
    if (!this.socket || this.socket.destroyed) {
      return false;
    }
    const buffer = encodeFrame(envelope);
    return this.socket.write(buffer);
  }

  private cleanup(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.decoder.reset();
  }

  public disconnect(): void {
    this.cleanup();
    if (this.socket && !this.socket.destroyed) {
      this.socket.destroy();
    }
    this.socket = null;
  }
}
