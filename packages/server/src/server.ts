/**
 * @fileoverview Central TCP server orchestrator.
 * Manages raw socket listeners, client sessions, message dispatching,
 * heartbeat monitoring, and clean teardowns.
 */

import * as net from 'node:net';
import * as os from 'node:os';
import {
  canMutateCanvas,
  createEnvelope,
  type CursorMovePayload,
  generateUuid,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  type MessageEnvelope,
  MessageType,
  PROTOCOL_VERSION,
  type StrokeBeginPayload,
  type StrokeEndPayload,
  type StrokePointsPayload,
  validatePayload,
} from '@cn-whiteboard/common';
import { Logger } from './logger.js';
import { RoomManager } from './room-manager.js';
import { ClientSession } from './session.js';

export interface ServerOptions {
  host: string;
  port: number;
  dataDir?: string;
}

export class WhiteboardServer {
  public readonly host: string;
  public readonly port: number;
  public readonly roomManager: RoomManager;

  private server: net.Server;
  private sessions: Map<string, ClientSession> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private logger = new Logger('TCPServer');
  private isClosing = false;

  constructor(options: ServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.roomManager = new RoomManager();
    this.server = net.createServer((socket) => this.handleNewConnection(socket));
  }

  /**
   * Retrieves all non-internal IPv4 LAN addresses on the local host.
   */
  public static getLanAddresses(): string[] {
    const interfaces = os.networkInterfaces();
    const addresses: string[] = [];

    for (const key of Object.keys(interfaces)) {
      const netDetails = interfaces[key];
      if (!netDetails) continue;

      for (const detail of netDetails) {
        if (detail.family === 'IPv4' && !detail.internal) {
          addresses.push(detail.address);
        }
      }
    }

    return addresses;
  }

  private handleNewConnection(socket: net.Socket): void {
    if (this.isClosing) {
      socket.destroy();
      return;
    }

    const sessionId = generateUuid();
    const initialUserId = generateUuid();
    const session = new ClientSession(sessionId, initialUserId, socket);
    this.sessions.set(sessionId, session);

    this.logger.info(
      `Accepted client connection from ${session.remoteAddress} (Session: ${sessionId}, Total: ${this.sessions.size})`,
    );

    session.on('message', (envelope: MessageEnvelope) => {
      this.handleClientMessage(session, envelope).catch((err) => {
        this.logger.error(`Error handling message [${envelope.type}] from ${session.userId}:`, err);
        session.send(
          createEnvelope(
            MessageType.ERROR,
            {
              code: 'INTERNAL_ERROR',
              message: err instanceof Error ? err.message : 'Unknown internal error',
            },
            { msg_id: generateUuid(), room: session.roomCode ?? '', user_id: session.userId },
          ),
        );
      });
    });

    session.on('close', (reason) => {
      this.sessions.delete(sessionId);
      if (session.roomCode) {
        this.roomManager.leaveRoom(session, reason);
      }
      this.logger.info(`Session ${sessionId} closed (${this.sessions.size} remaining)`);
    });
  }

  private async handleClientMessage(
    session: ClientSession,
    envelope: MessageEnvelope,
  ): Promise<void> {
    switch (envelope.type) {
      case MessageType.HELLO: {
        const payload = validatePayload<{ clientVersion: string; suggestedUsername?: string }>(
          MessageType.HELLO,
          envelope.payload,
        );

        if (payload.suggestedUsername) {
          session.username = payload.suggestedUsername;
        }

        session.send(
          createEnvelope(
            MessageType.AUTH_OK,
            {
              sessionId: session.sessionId,
              userId: session.userId,
              protocolVersion: PROTOCOL_VERSION,
            },
            {
              msg_id: generateUuid(),
              room: '',
              user_id: session.userId,
            },
          ),
        );
        break;
      }

      case MessageType.PING: {
        const payload = validatePayload<{ nonce: number }>(MessageType.PING, envelope.payload);
        session.send(
          createEnvelope(
            MessageType.PONG,
            { nonce: payload.nonce, serverTs: Date.now() },
            {
              msg_id: generateUuid(),
              room: session.roomCode ?? '',
              user_id: session.userId,
            },
          ),
        );
        break;
      }

      case MessageType.CREATE_ROOM: {
        const payload = validatePayload<{
          roomName: string;
          username: string;
          password?: string;
        }>(MessageType.CREATE_ROOM, envelope.payload);

        const room = await this.roomManager.createRoom(
          session,
          payload.roomName,
          payload.username,
          payload.password,
        );

        // Send ROOM_STATE snapshot to the host
        const snapshot = room.getSnapshot();
        session.send(
          createEnvelope(MessageType.ROOM_STATE, snapshot, {
            room: room.code,
            user_id: session.userId,
            seq: room.seq,
          }),
        );
        break;
      }

      case MessageType.JOIN_ROOM: {
        const payload = validatePayload<{
          roomCode: string;
          username: string;
          password?: string;
        }>(MessageType.JOIN_ROOM, envelope.payload);

        try {
          const { room } = await this.roomManager.joinRoom(
            session,
            payload.roomCode,
            payload.username,
            payload.password,
          );

          // Transmit ROOM_STATE to joining client
          const snapshot = room.getSnapshot();
          session.send(
            createEnvelope(MessageType.ROOM_STATE, snapshot, {
              room: room.code,
              user_id: session.userId,
              seq: room.seq,
            }),
          );
        } catch (joinError) {
          session.send(
            createEnvelope(
              MessageType.ERROR,
              {
                code: 'JOIN_FAILED',
                message: joinError instanceof Error ? joinError.message : 'Failed to join room',
              },
              {
                room: payload.roomCode,
                user_id: session.userId,
              },
            ),
          );
        }
        break;
      }

      case MessageType.LEAVE_ROOM: {
        const payload = validatePayload<{ reason?: string }>(
          MessageType.LEAVE_ROOM,
          envelope.payload,
        );
        this.roomManager.leaveRoom(session, payload.reason);
        session.send(
          createEnvelope(
            MessageType.ACK,
            {
              target_msg_id: envelope.msg_id,
              status: 'ok',
            },
            { user_id: session.userId },
          ),
        );
        break;
      }

      case MessageType.PARTICIPANT_LIST: {
        if (!session.roomCode) {
          session.send(
            createEnvelope(
              MessageType.ERROR,
              { code: 'NOT_IN_ROOM', message: 'You must join a room to view participant list' },
              { user_id: session.userId },
            ),
          );
          return;
        }
        const room = this.roomManager.getRoom(session.roomCode);
        if (room) {
          session.send(
            createEnvelope(
              MessageType.PARTICIPANT_LIST,
              { participants: room.getParticipants() },
              { room: room.code, user_id: session.userId, seq: room.seq },
            ),
          );
        }
        break;
      }

      case MessageType.STROKE_BEGIN: {
        if (!session.roomCode) {
          session.send(
            createEnvelope(
              MessageType.ERROR,
              { code: 'NOT_IN_ROOM', message: 'You must join a room first' },
              { user_id: session.userId },
            ),
          );
          return;
        }
        const room = this.roomManager.getRoom(session.roomCode);
        if (!room) return;

        if (!canMutateCanvas(session.role)) {
          session.send(
            createEnvelope(
              MessageType.ERROR,
              { code: 'FORBIDDEN', message: 'Viewer role cannot mutate canvas' },
              { room: room.code, user_id: session.userId },
            ),
          );
          return;
        }

        const payload = validatePayload<StrokeBeginPayload>(
          MessageType.STROKE_BEGIN,
          envelope.payload,
        );

        await room.enqueue(async () => {
          const stroke = room.applyStrokeBegin(
            payload.op_id,
            payload.strokeId,
            session.userId,
            payload.color,
            payload.width,
            payload.startPoint,
          );
          const broadcastEnvelope = createEnvelope(MessageType.STROKE_BEGIN, payload, {
            msg_id: envelope.msg_id,
            seq: stroke.seq,
            room: room.code,
            user_id: session.userId,
            ts: stroke.updatedAt,
          });
          room.broadcast(broadcastEnvelope);
        });
        break;
      }

      case MessageType.STROKE_POINTS: {
        if (!session.roomCode) return;
        const room = this.roomManager.getRoom(session.roomCode);
        if (!room || !canMutateCanvas(session.role)) return;

        const payload = validatePayload<StrokePointsPayload>(
          MessageType.STROKE_POINTS,
          envelope.payload,
        );

        await room.enqueue(async () => {
          const stroke = room.applyStrokePoints(payload.op_id, payload.strokeId, payload.points);
          if (!stroke) return;

          const broadcastEnvelope = createEnvelope(MessageType.STROKE_POINTS, payload, {
            msg_id: envelope.msg_id,
            seq: stroke.seq,
            room: room.code,
            user_id: session.userId,
            ts: stroke.updatedAt,
          });
          room.broadcast(broadcastEnvelope);
        });
        break;
      }

      case MessageType.STROKE_END: {
        if (!session.roomCode) return;
        const room = this.roomManager.getRoom(session.roomCode);
        if (!room || !canMutateCanvas(session.role)) return;

        const payload = validatePayload<StrokeEndPayload>(MessageType.STROKE_END, envelope.payload);

        await room.enqueue(async () => {
          const stroke = room.applyStrokeEnd(payload.op_id, payload.strokeId, payload.finalPoint);
          if (!stroke) return;

          const broadcastEnvelope = createEnvelope(MessageType.STROKE_END, payload, {
            msg_id: envelope.msg_id,
            seq: stroke.seq,
            room: room.code,
            user_id: session.userId,
            ts: stroke.updatedAt,
          });
          room.broadcast(broadcastEnvelope);
        });
        break;
      }

      case MessageType.CURSOR_MOVE: {
        if (session.roomCode) {
          const room = this.roomManager.getRoom(session.roomCode);
          if (room) {
            const payload = validatePayload<CursorMovePayload>(
              MessageType.CURSOR_MOVE,
              envelope.payload,
            );
            const cursorEnvelope = createEnvelope(MessageType.CURSOR_MOVE, payload, {
              msg_id: envelope.msg_id,
              seq: 0,
              room: room.code,
              user_id: session.userId,
              ts: Date.now(),
            });
            // Ephemeral broadcast to peers, skipping sender
            room.broadcast(cursorEnvelope, session.userId);
          }
        }
        break;
      }

      default: {
        this.logger.debug(`Unhandled message type: ${envelope.type}`);
        break;
      }
    }
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of this.sessions.entries()) {
        if (now - session.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
          this.logger.warn(
            `Session ${sessionId} silent for >${HEARTBEAT_TIMEOUT_MS / 1000}s. Terminating connection.`,
          );
          session.destroy('Heartbeat timeout (silence)');
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Starts the TCP server listening on the configured network interface and port.
   */
  public async listen(): Promise<{ port: number; host: string }> {
    return new Promise((resolve, reject) => {
      this.server.on('error', (err) => reject(err));

      this.server.listen(this.port, this.host, () => {
        const address = this.server.address() as net.AddressInfo;
        const boundPort = address.port;
        const boundHost = address.address;

        this.startHeartbeat();

        this.logger.info(`Server bound and listening on ${boundHost}:${boundPort}`);
        const lanIps = WhiteboardServer.getLanAddresses();
        if (lanIps.length > 0) {
          this.logger.info('Accessible across your Local Area Network via:');
          for (const ip of lanIps) {
            this.logger.info(`  -> tcp://${ip}:${boundPort}`);
          }
        }

        resolve({ port: boundPort, host: boundHost });
      });
    });
  }

  /**
   * Gracefully terminates the server, drops client sockets, and releases ports.
   */
  public async close(): Promise<void> {
    this.isClosing = true;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const session of this.sessions.values()) {
      session.destroy('Server shutting down');
    }
    this.sessions.clear();

    return new Promise((resolve) => {
      this.server.close(() => {
        this.logger.info('Server closed cleanly');
        resolve();
      });
    });
  }
}
