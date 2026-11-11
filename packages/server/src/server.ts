/**
 * @fileoverview Central TCP server orchestrator.
 * Manages raw socket listeners, client sessions, message dispatching,
 * heartbeat monitoring, and clean teardowns.
 *
 * Reliability responsibilities handled here:
 * - Liveness: silent sessions are dropped after a timeout; the room and the participant's
 *   identity survive so the client can reconnect and resume.
 * - Idempotency: a retried client operation is acknowledged (ACK carrying the seq it originally
 *   received) instead of being applied or broadcast a second time.
 * - Rejections are correlated to the offending message (`details.target_msg_id`) so a client can
 *   stop retrying an operation the server will never accept.
 * - Resume: a participant that reconnects with its session token and the last seq it applied is
 *   caught up with just the missed operations, or with a full snapshot if they are out of range.
 */

import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  canMutateCanvas,
  type ChatMessage,
  type ChatMessagePayload,
  type ClearCanvasPayload,
  createEnvelope,
  type CursorMovePayload,
  type ErasePayload,
  type PresentationPayload,
  type VersionListPayload,
  type VersionRestorePayload,
  type VersionSavePayload,
  type ImageAddPayload,
  type ImageChunkPayload,
  IMAGE_CHUNK_BYTES,
  type ImageRequestPayload,
  type ObjectDeletePayload,
  type ObjectUpdatePayload,
  type ShapeAddPayload,
  generateUuid,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  isHost,
  type MessageEnvelope,
  MessageType,
  type ParticipantRenamedPayload,
  type PermissionChangePayload,
  PROTOCOL_VERSION,
  Role,
  type ResyncRequestPayload,
  type SaveStatePayload,
  type LoadStatePayload,
  type StrokeBeginPayload,
  type StrokeEndPayload,
  type StrokePointsPayload,
  validatePayload,
} from '@cn-whiteboard/common';
import { DiscoveryResponder } from './discovery.js';
import { Logger } from './logger.js';
import { RoomManager } from './room-manager.js';
import type { Room } from './room.js';
import { RoomPersistence } from './room-persistence.js';
import { ClientSession } from './session.js';

export interface ServerOptions {
  host: string;
  port: number;
  dataDir?: string;
  /**
   * Interval between liveness sweeps. Defaults to HEARTBEAT_INTERVAL_MS (5s).
   */
  heartbeatIntervalMs?: number;
  /**
   * Silence after which a client is dropped. Defaults to HEARTBEAT_TIMEOUT_MS (15s).
   */
  heartbeatTimeoutMs?: number;
  /**
   * UDP port for LAN discovery. Omit (undefined) to disable discovery entirely, which is the
   * default so embedded/test servers never open a UDP socket; the CLI enables it.
   */
  discoveryPort?: number;
}

export class WhiteboardServer {
  public readonly host: string;
  public readonly port: number;
  public readonly roomManager: RoomManager;

  private server: net.Server;
  private sessions: Map<string, ClientSession> = new Map();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly persistence: RoomPersistence;
  private hasRestoredRooms = false;
  private logger = new Logger('TCPServer');
  private isClosing = false;
  private discovery: DiscoveryResponder | null = null;
  private readonly discoveryPort: number | undefined;

  constructor(options: ServerOptions) {
    this.host = options.host;
    this.port = options.port;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.discoveryPort = options.discoveryPort;
    this.persistence = new RoomPersistence(options.dataDir ?? path.resolve(process.cwd(), 'data'));
    this.roomManager = new RoomManager((room) => this.persistence.scheduleSave(room));
    this.server = net.createServer((socket) => this.handleNewConnection(socket));
  }

  /** UDP port the discovery responder is bound to, or null when discovery is off. */
  public get discoveryBoundPort(): number | null {
    return this.discovery?.port ?? null;
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

  /**
   * Number of currently registered client connections.
   */
  public get sessionCount(): number {
    return this.sessions.size;
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
        const isValidationError = err instanceof Error && err.name === 'ZodError';
        if (isValidationError) {
          this.logger.warn(`Rejected invalid [${envelope.type}] from ${session.userId}`);
        } else {
          this.logger.error(
            `Error handling message [${envelope.type}] from ${session.userId}:`,
            err,
          );
        }
        this.sendError(
          session,
          isValidationError ? 'INVALID_PAYLOAD' : 'INTERNAL_ERROR',
          err instanceof Error ? err.message : 'Unknown internal error',
          envelope,
          session.roomCode ?? '',
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

  /**
   * Sends an ERROR frame. When the error is a response to a specific client message, its id is
   * attached as `details.target_msg_id` so the client can correlate (and stop retrying) it.
   */
  private sendError(
    session: ClientSession,
    code: string,
    message: string,
    inResponseTo?: MessageEnvelope,
    room: string = '',
  ): void {
    session.send(
      createEnvelope(
        MessageType.ERROR,
        {
          code,
          message,
          details: inResponseTo ? { target_msg_id: inResponseTo.msg_id } : undefined,
        },
        { msg_id: generateUuid(), room, user_id: session.userId },
      ),
    );
  }

  /**
   * Sends an ACK frame for a client message.
   */
  private sendAck(
    session: ClientSession,
    targetMsgId: string,
    status: 'ok' | 'rejected',
    seq?: number,
    error?: string,
  ): void {
    session.send(
      createEnvelope(
        MessageType.ACK,
        { target_msg_id: targetMsgId, status, seq, error },
        { msg_id: generateUuid(), room: session.roomCode ?? '', user_id: session.userId },
      ),
    );
  }

  /**
   * Resolves the room the session is in, or answers NOT_IN_ROOM.
   */
  private requireRoom(
    session: ClientSession,
    envelope: MessageEnvelope,
    message: string,
  ): Room | null {
    if (!session.roomCode) {
      this.sendError(session, 'NOT_IN_ROOM', message, envelope);
      return null;
    }
    return this.roomManager.getRoom(session.roomCode) ?? null;
  }

  /**
   * Answers FORBIDDEN unless `allowed` holds.
   */
  private authorize(
    session: ClientSession,
    envelope: MessageEnvelope,
    room: Room,
    allowed: boolean,
    message: string,
  ): boolean {
    if (!allowed) {
      this.sendError(session, 'FORBIDDEN', message, envelope, room.code);
    }
    return allowed;
  }

  private authorizeCanvasMutation(
    session: ClientSession,
    envelope: MessageEnvelope,
    room: Room,
  ): boolean {
    if (!canMutateCanvas(session.role)) {
      return this.authorize(session, envelope, room, false, 'Viewer role cannot mutate the canvas');
    }
    if (room.locked && !isHost(session.role)) {
      return this.authorize(session, envelope, room, false, 'The host has locked the room');
    }
    return true;
  }

  /**
   * Idempotency guard for client operations. If `opId` was already applied, the sender is told
   * (ACK with the seq the operation originally received) and the caller must not apply or
   * broadcast it again. This is what makes client retries and duplicated frames harmless.
   *
   * @returns true if the operation was a duplicate and has been acknowledged.
   */
  private acknowledgeDuplicate(
    session: ClientSession,
    envelope: MessageEnvelope,
    room: Room,
    opId: string,
  ): boolean {
    const priorSeq = room.getProcessedOpSeq(opId);
    if (priorSeq === undefined) return false;
    this.logger.debug(`Duplicate op ${opId} from ${session.userId}; acknowledged seq ${priorSeq}`);
    this.sendAck(session, envelope.msg_id, 'ok', priorSeq);
    return true;
  }

  private async handleClientMessage(
    session: ClientSession,
    envelope: MessageEnvelope,
  ): Promise<void> {
    switch (envelope.type) {
      case MessageType.HELLO: {
        const payload = validatePayload<{
          clientVersion: string;
          suggestedUsername?: string;
          sessionToken?: string;
        }>(MessageType.HELLO, envelope.payload);

        if (payload.suggestedUsername) {
          session.username = payload.suggestedUsername;
        }

        if (payload.sessionToken) {
          session.sessionId = payload.sessionToken;
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
        const pingRoom = session.roomCode ? this.roomManager.getRoom(session.roomCode) : undefined;
        session.send(
          createEnvelope(
            MessageType.PONG,
            {
              nonce: payload.nonce,
              serverTs: Date.now(),
              // Lets the client detect a missing tail of the event stream (see protocol.md).
              roomSeq: pingRoom?.seq,
            },
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
          allowNameChanges?: boolean;
        }>(MessageType.CREATE_ROOM, envelope.payload);

        const room = await this.roomManager.createRoom(
          session,
          payload.roomName,
          payload.username,
          payload.password,
          payload.allowNameChanges,
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
          sessionToken?: string;
          lastSeq?: number;
        }>(MessageType.JOIN_ROOM, envelope.payload);

        try {
          const { room, resumed } = await this.roomManager.joinRoom(
            session,
            payload.roomCode,
            payload.username,
            payload.password,
            payload.sessionToken,
          );

          // Resuming participant that knows where it left off: send only what it missed.
          if (resumed && payload.lastSeq !== undefined && payload.lastSeq <= room.seq) {
            const resync = room.getResyncData(payload.lastSeq);
            if (!resync.fullSnapshot) {
              session.send(
                createEnvelope(MessageType.RESYNC_RESPONSE, resync, {
                  msg_id: generateUuid(),
                  room: room.code,
                  user_id: session.userId,
                  seq: room.seq,
                }),
              );
              break;
            }
          }

          // Otherwise (new participant, or too far behind) transmit the full ROOM_STATE
          const snapshot = room.getSnapshot();
          session.send(
            createEnvelope(MessageType.ROOM_STATE, snapshot, {
              room: room.code,
              user_id: session.userId,
              seq: room.seq,
            }),
          );
        } catch (joinError) {
          this.sendError(
            session,
            'JOIN_FAILED',
            joinError instanceof Error ? joinError.message : 'Failed to join room',
            envelope,
            payload.roomCode,
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
        const room = this.requireRoom(
          session,
          envelope,
          'You must join a room to view participant list',
        );
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

      case MessageType.UPDATE_USERNAME: {
        const room = this.requireRoom(
          session,
          envelope,
          'You must join a room to change your name',
        );
        if (!room) return;
        if (!room.allowNameChanges) {
          this.sendError(
            session,
            'NAME_CHANGE_DISABLED',
            'The host has disabled participant name changes for this room',
            envelope,
            room.code,
          );
          return;
        }
        const payload = validatePayload<{ username: string }>(
          MessageType.UPDATE_USERNAME,
          envelope.payload,
        );
        const username = payload.username.trim();
        await room.enqueue(() => {
          if (!room.renameParticipant(session.userId, username)) return;
          const renamedPayload: ParticipantRenamedPayload = {
            userId: session.userId,
            username,
          };
          const event = room.recordEvent(
            MessageType.PARTICIPANT_RENAMED,
            renamedPayload,
            session.userId,
          );
          room.broadcast(
            createEnvelope(MessageType.PARTICIPANT_RENAMED, renamedPayload, {
              msg_id: envelope.msg_id,
              seq: event.seq,
              room: room.code,
              user_id: session.userId,
              ts: event.ts,
            }),
          );
        });
        break;
      }

      case MessageType.PERMISSION_CHANGE: {
        const room = this.requireRoom(session, envelope, 'You must join a room to manage it');
        if (!room) return;
        if (
          !this.authorize(
            session,
            envelope,
            room,
            isHost(session.role),
            'Only the host can manage the room',
          )
        ) {
          return;
        }

        const payload = validatePayload<PermissionChangePayload>(
          MessageType.PERMISSION_CHANGE,
          envelope.payload,
        );

        await room.enqueue(() => {
          if (
            !this.authorize(
              session,
              envelope,
              room,
              isHost(session.role),
              'Only the host can manage the room',
            )
          ) {
            return;
          }

          if (payload.lockRoom !== undefined) {
            room.locked = payload.lockRoom;
          } else if (payload.targetUserId) {
            const target = room.getParticipant(payload.targetUserId);
            if (!target) {
              this.sendError(
                session,
                'INVALID_PERMISSION_CHANGE',
                'Participant is no longer in the room',
                envelope,
                room.code,
              );
              return;
            }
            if (payload.targetUserId === session.userId || target.role === Role.HOST) {
              this.sendError(
                session,
                'INVALID_PERMISSION_CHANGE',
                'The host cannot change or remove their own role',
                envelope,
                room.code,
              );
              return;
            }

            if (payload.kick) {
              const reason = payload.reason ?? 'Removed by host';
              const permissionEvent = room.recordEvent(
                MessageType.PERMISSION_CHANGE,
                { ...payload, reason },
                session.userId,
              );
              room.broadcast(
                createEnvelope(
                  MessageType.PERMISSION_CHANGE,
                  { ...payload, reason },
                  {
                    msg_id: envelope.msg_id,
                    seq: permissionEvent.seq,
                    room: room.code,
                    user_id: session.userId,
                    ts: permissionEvent.ts,
                  },
                ),
              );
              if (!room.kickParticipant(payload.targetUserId, reason)) {
                this.sendError(
                  session,
                  'INVALID_PERMISSION_CHANGE',
                  'Participant is no longer in the room',
                  envelope,
                  room.code,
                );
              }
              return;
            }

            if (
              !payload.newRole ||
              payload.newRole === Role.HOST ||
              !room.setParticipantRole(payload.targetUserId, payload.newRole)
            ) {
              this.sendError(
                session,
                'INVALID_PERMISSION_CHANGE',
                'The requested role change is not allowed',
                envelope,
                room.code,
              );
              return;
            }
          }

          const permissionEvent = room.recordEvent(
            MessageType.PERMISSION_CHANGE,
            payload,
            session.userId,
          );
          room.broadcast(
            createEnvelope(MessageType.PERMISSION_CHANGE, payload, {
              msg_id: envelope.msg_id,
              seq: permissionEvent.seq,
              room: room.code,
              user_id: session.userId,
              ts: permissionEvent.ts,
            }),
          );
        });
        break;
      }

      case MessageType.STROKE_BEGIN: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) {
          return;
        }

        const payload = validatePayload<StrokeBeginPayload>(
          MessageType.STROKE_BEGIN,
          envelope.payload,
        );

        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;

          const stroke = room.applyStrokeBegin(
            payload.op_id,
            payload.strokeId,
            session.userId,
            payload.color,
            payload.width,
            payload.startPoint,
          );
          const seq = room.getProcessedOpSeq(payload.op_id);
          if (seq === undefined) {
            this.sendAck(
              session,
              envelope.msg_id,
              'rejected',
              undefined,
              'Stroke id already in use',
            );
            return;
          }

          room.broadcast(
            createEnvelope(MessageType.STROKE_BEGIN, payload, {
              msg_id: envelope.msg_id,
              seq,
              room: room.code,
              user_id: session.userId,
              ts: stroke.updatedAt,
            }),
          );
        });
        break;
      }

      case MessageType.STROKE_POINTS: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) {
          return;
        }

        const payload = validatePayload<StrokePointsPayload>(
          MessageType.STROKE_POINTS,
          envelope.payload,
        );

        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;

          const stroke = room.applyStrokePoints(payload.op_id, payload.strokeId, payload.points);
          const seq = room.getProcessedOpSeq(payload.op_id);
          if (!stroke || seq === undefined) {
            this.sendAck(
              session,
              envelope.msg_id,
              'rejected',
              undefined,
              'Unknown or already completed stroke',
            );
            return;
          }

          // The authoritative index of the first point lets receivers apply the batch idempotently.
          const startIndex = stroke.points.length - payload.points.length;
          room.broadcast(
            createEnvelope(
              MessageType.STROKE_POINTS,
              { ...payload, startIndex },
              {
                msg_id: envelope.msg_id,
                seq,
                room: room.code,
                user_id: session.userId,
                ts: stroke.updatedAt,
              },
            ),
          );
        });
        break;
      }

      case MessageType.STROKE_END: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) {
          return;
        }

        const payload = validatePayload<StrokeEndPayload>(MessageType.STROKE_END, envelope.payload);

        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;

          const stroke = room.applyStrokeEnd(payload.op_id, payload.strokeId, payload.finalPoint);
          const seq = room.getProcessedOpSeq(payload.op_id);
          if (!stroke || seq === undefined) {
            this.sendAck(
              session,
              envelope.msg_id,
              'rejected',
              undefined,
              'Unknown or already completed stroke',
            );
            return;
          }

          room.broadcast(
            createEnvelope(
              MessageType.STROKE_END,
              {
                ...payload,
                startIndex: payload.finalPoint ? stroke.points.length - 1 : undefined,
              },
              {
                msg_id: envelope.msg_id,
                seq,
                room: room.code,
                user_id: session.userId,
                ts: stroke.updatedAt,
              },
            ),
          );
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

      case MessageType.IMAGE_UPLOAD: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) return;

        const payload = validatePayload<ImageChunkPayload>(
          MessageType.IMAGE_UPLOAD,
          envelope.payload,
        );
        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          const result = room.receiveImageChunk(session.userId, payload);
          if (typeof result === 'object') {
            room.dropPendingUploads(session.userId);
            this.sendError(session, 'IMAGE_REJECTED', result.error, envelope, room.code);
          }
        });
        break;
      }

      case MessageType.IMAGE_ADD: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) return;

        const payload = validatePayload<ImageAddPayload>(MessageType.IMAGE_ADD, envelope.payload);
        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;

          const stored = room.applyImageAdd(payload.op_id, payload.object, session.userId);
          if (!stored) {
            this.sendAck(session, envelope.msg_id, 'rejected', undefined, 'Image upload missing');
            return;
          }
          room.broadcast(
            createEnvelope(
              MessageType.IMAGE_ADD,
              { op_id: payload.op_id, object: stored },
              {
                msg_id: envelope.msg_id,
                seq: stored.seq,
                room: room.code,
                user_id: session.userId,
                ts: stored.updatedAt,
              },
            ),
          );
        });
        break;
      }

      case MessageType.IMAGE_REQUEST: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        const payload = validatePayload<ImageRequestPayload>(
          MessageType.IMAGE_REQUEST,
          envelope.payload,
        );
        // Everyone in the room (viewers included) may fetch bytes; they only see what is on the board.
        const asset = room.getAsset(payload.assetId);
        if (!asset) {
          this.sendError(session, 'IMAGE_NOT_FOUND', 'Image is not available', envelope, room.code);
          break;
        }
        const size = Math.ceil(IMAGE_CHUNK_BYTES / 3) * 4; // base64 chars per chunk, multiple of 4
        const total = Math.max(1, Math.ceil(asset.data.length / size));
        for (let index = 0; index < total; index++) {
          session.send(
            createEnvelope(
              MessageType.IMAGE_DATA,
              {
                assetId: payload.assetId,
                mime: asset.mime,
                index,
                total,
                data: asset.data.slice(index * size, (index + 1) * size),
              },
              { room: room.code, user_id: session.userId },
            ),
          );
        }
        break;
      }

      case MessageType.PRESENTATION: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (
          !this.authorize(
            session,
            envelope,
            room,
            isHost(session.role),
            'Only the host can present',
          )
        ) {
          return;
        }
        const payload = validatePayload<PresentationPayload>(
          MessageType.PRESENTATION,
          envelope.payload,
        );
        // Ephemeral and latest-wins: stored for late joiners, relayed unsequenced to everyone else.
        room.presentation = payload.active ? payload : { active: false };
        room.broadcast(
          createEnvelope(MessageType.PRESENTATION, room.presentation, {
            msg_id: envelope.msg_id,
            seq: 0,
            room: room.code,
            user_id: session.userId,
            ts: Date.now(),
          }),
          session.userId,
        );
        break;
      }

      case MessageType.VERSION_SAVE:
      case MessageType.VERSION_LIST:
      case MessageType.VERSION_RESTORE: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (
          !this.authorize(
            session,
            envelope,
            room,
            isHost(session.role),
            'Only the host can manage version history',
          )
        ) {
          return;
        }
        const payload = validatePayload<
          VersionSavePayload | VersionListPayload | VersionRestorePayload
        >(envelope.type, envelope.payload);

        await room.enqueue(() => {
          const sendList = () =>
            session.send(
              createEnvelope(
                MessageType.VERSION_LIST,
                { versions: room.listVersions() },
                { msg_id: envelope.msg_id, room: room.code, user_id: session.userId },
              ),
            );

          if (envelope.type === MessageType.VERSION_SAVE) {
            room.addVersion((payload as VersionSavePayload).name, session.userId, false);
          } else if (envelope.type === MessageType.VERSION_RESTORE) {
            const restored = room.restoreVersion((payload as VersionRestorePayload).versionId);
            if (!restored) {
              this.sendError(
                session,
                'VERSION_NOT_FOUND',
                'That version no longer exists',
                envelope,
                room.code,
              );
              return;
            }
            room.recordEvent(
              MessageType.VERSION_RESTORE,
              { versionId: restored.id },
              session.userId,
            );
            room.recordSystemMessage(`The host restored the board to "${restored.name}".`);
            room.broadcastSnapshot();
          }
          sendList();
        });
        break;
      }

      case MessageType.SHAPE_ADD: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) return;

        const payload = validatePayload<ShapeAddPayload>(MessageType.SHAPE_ADD, envelope.payload);

        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;

          const stored = room.applyShapeAdd(payload.op_id, payload.object, session.userId);
          if (!stored) {
            this.sendAck(
              session,
              envelope.msg_id,
              'rejected',
              undefined,
              'Object id already in use',
            );
            return;
          }
          room.broadcast(
            createEnvelope(
              MessageType.SHAPE_ADD,
              { op_id: payload.op_id, object: stored },
              {
                msg_id: envelope.msg_id,
                seq: stored.seq,
                room: room.code,
                user_id: session.userId,
                ts: stored.updatedAt,
              },
            ),
          );
        });
        break;
      }

      case MessageType.OBJECT_UPDATE: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) return;

        const payload = validatePayload<ObjectUpdatePayload>(
          MessageType.OBJECT_UPDATE,
          envelope.payload,
        );

        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;

          const updated = room.applyObjectUpdate(
            payload.op_id,
            payload.id,
            payload.changes,
            session.userId,
          );
          if (!updated) {
            this.sendAck(
              session,
              envelope.msg_id,
              'rejected',
              undefined,
              'Object no longer exists',
            );
            return;
          }
          room.broadcast(
            createEnvelope(MessageType.OBJECT_UPDATE, payload, {
              msg_id: envelope.msg_id,
              seq: updated.seq,
              room: room.code,
              user_id: session.userId,
              ts: updated.updatedAt,
            }),
          );
        });
        break;
      }

      case MessageType.OBJECT_DELETE: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) return;

        const payload = validatePayload<ObjectDeletePayload>(
          MessageType.OBJECT_DELETE,
          envelope.payload,
        );

        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;

          const seq = room.applyObjectDelete(payload.op_id, payload.id, session.userId);
          if (seq === null) {
            this.sendAck(
              session,
              envelope.msg_id,
              'rejected',
              undefined,
              'Object no longer exists',
            );
            return;
          }
          room.broadcast(
            createEnvelope(MessageType.OBJECT_DELETE, payload, {
              msg_id: envelope.msg_id,
              seq,
              room: room.code,
              user_id: session.userId,
              ts: Date.now(),
            }),
          );
        });
        break;
      }

      case MessageType.ERASE: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) {
          return;
        }

        const payload = validatePayload<ErasePayload>(MessageType.ERASE, envelope.payload);

        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;

          const { seq } = room.eraseObjects(payload.op_id, payload.objectIds, session.userId);
          room.broadcast(
            createEnvelope(
              MessageType.ERASE,
              { op_id: payload.op_id, objectIds: payload.objectIds },
              {
                msg_id: envelope.msg_id,
                seq,
                room: room.code,
                user_id: session.userId,
                ts: Date.now(),
              },
            ),
          );
        });
        break;
      }

      case MessageType.CLEAR_CANVAS: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;

        // ONLY HOST can clear the canvas!
        if (
          !this.authorize(
            session,
            envelope,
            room,
            isHost(session.role),
            'Only the room host can clear the canvas',
          )
        ) {
          return;
        }

        const payload = validatePayload<ClearCanvasPayload>(
          MessageType.CLEAR_CANVAS,
          envelope.payload,
        );

        await room.enqueue(() => {
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;

          const { seq } = room.clearCanvas(payload.op_id, session.userId);
          room.broadcast(
            createEnvelope(MessageType.CLEAR_CANVAS, payload, {
              msg_id: envelope.msg_id,
              seq,
              room: room.code,
              user_id: session.userId,
              ts: Date.now(),
            }),
          );
        });
        break;
      }

      case MessageType.UNDO: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) {
          return;
        }

        const payload = validatePayload<{ op_id: string; target_op_id: string }>(
          MessageType.UNDO,
          envelope.payload,
        );

        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;
          const result = room.applyUndo(payload.op_id, payload.target_op_id, session.userId);
          if (!result.accepted || !result.payload || result.seq === undefined) {
            this.sendError(
              session,
              'UNDO_FAILED',
              result.message ?? 'Undo rejected',
              envelope,
              room.code,
            );
            return;
          }

          room.broadcast(
            createEnvelope(MessageType.UNDO, result.payload, {
              msg_id: envelope.msg_id,
              seq: result.seq,
              room: room.code,
              user_id: session.userId,
              ts: Date.now(),
            }),
          );
        });
        break;
      }

      case MessageType.REDO: {
        const room = this.requireRoom(session, envelope, 'You must join a room first');
        if (!room) return;
        if (!this.authorizeCanvasMutation(session, envelope, room)) {
          return;
        }

        const payload = validatePayload<{ op_id: string; target_op_id: string }>(
          MessageType.REDO,
          envelope.payload,
        );

        await room.enqueue(() => {
          if (!this.authorizeCanvasMutation(session, envelope, room)) return;
          if (this.acknowledgeDuplicate(session, envelope, room, payload.op_id)) return;
          const result = room.applyRedo(payload.op_id, payload.target_op_id, session.userId);
          if (!result.accepted || !result.payload || result.seq === undefined) {
            this.sendError(
              session,
              'REDO_FAILED',
              result.message ?? 'Redo rejected',
              envelope,
              room.code,
            );
            return;
          }

          room.broadcast(
            createEnvelope(MessageType.REDO, result.payload, {
              msg_id: envelope.msg_id,
              seq: result.seq,
              room: room.code,
              user_id: session.userId,
              ts: Date.now(),
            }),
          );
        });
        break;
      }

      case MessageType.RESYNC_REQUEST: {
        const room = this.requireRoom(
          session,
          envelope,
          'You must join a room first to request resync',
        );
        if (!room) return;

        const payload = validatePayload<ResyncRequestPayload>(
          MessageType.RESYNC_REQUEST,
          envelope.payload,
        );

        await room.enqueue(() => {
          const resyncData = room.getResyncData(payload.last_seq);
          session.send(
            createEnvelope(MessageType.RESYNC_RESPONSE, resyncData, {
              msg_id: generateUuid(),
              room: room.code,
              user_id: session.userId,
              seq: room.seq,
            }),
          );
        });
        break;
      }

      case MessageType.CHAT_MESSAGE: {
        const room = this.requireRoom(
          session,
          envelope,
          'You must join a room first to send chat messages',
        );
        if (!room) return;

        const payload = validatePayload<ChatMessagePayload>(
          MessageType.CHAT_MESSAGE,
          envelope.payload,
        );

        await room.enqueue(() => {
          const chatMsgId = payload.id || generateUuid();
          if (this.acknowledgeDuplicate(session, envelope, room, chatMsgId)) return;

          const chatTs = Date.now();
          const messageRecord: ChatMessage = {
            id: chatMsgId,
            userId: session.userId,
            username: session.username || payload.username || 'User',
            color: session.color || payload.color || '#3B82F6',
            text: payload.text,
            ts: chatTs,
            isSystem: payload.isSystem ?? false,
          };
          const broadcastPayload = {
            id: messageRecord.id,
            text: messageRecord.text,
            username: messageRecord.username,
            color: messageRecord.color,
            ts: messageRecord.ts,
            isSystem: messageRecord.isSystem,
          };

          // Chat messages are sequenced and logged like drawing operations so a client that
          // misses one recovers it through resync.
          const { seq } = room.recordEvent(
            MessageType.CHAT_MESSAGE,
            broadcastPayload,
            session.userId,
            chatMsgId,
            chatTs,
          );
          room.recordChatMessage(messageRecord);

          room.broadcast(
            createEnvelope(MessageType.CHAT_MESSAGE, broadcastPayload, {
              msg_id: envelope.msg_id,
              seq,
              room: room.code,
              user_id: session.userId,
              ts: chatTs,
            }),
          );
        });
        break;
      }

      case MessageType.CHAT_HISTORY: {
        const room = this.requireRoom(
          session,
          envelope,
          'You must join a room first to request chat history',
        );
        if (!room) return;

        session.send(
          createEnvelope(
            MessageType.CHAT_HISTORY,
            { messages: room.getChatHistory() },
            {
              msg_id: generateUuid(),
              room: room.code,
              user_id: session.userId,
              seq: room.seq,
              ts: Date.now(),
            },
          ),
        );
        break;
      }

      case MessageType.SAVE_STATE: {
        const room = this.requireRoom(session, envelope, 'You must join a room before saving');
        if (!room) return;
        if (
          !this.authorize(session, envelope, room, isHost(session.role), 'Only the host can save')
        ) {
          return;
        }

        validatePayload<SaveStatePayload>(MessageType.SAVE_STATE, envelope.payload);
        const result = await room.enqueue(() => this.persistence.saveRoom(room));
        session.send(
          createEnvelope(MessageType.SAVE_STATE, result, {
            msg_id: envelope.msg_id,
            room: room.code,
            user_id: session.userId,
            seq: room.seq,
          }),
        );
        break;
      }

      case MessageType.LOAD_STATE: {
        const room = this.requireRoom(session, envelope, 'You must join a room before loading');
        if (!room) return;
        if (
          !this.authorize(session, envelope, room, isHost(session.role), 'Only the host can load')
        ) {
          return;
        }

        validatePayload<LoadStatePayload>(MessageType.LOAD_STATE, envelope.payload);
        const saved = await this.persistence.loadRoom(room.code);
        if (!saved) {
          this.sendError(
            session,
            'SAVE_NOT_FOUND',
            'No saved state exists for this room yet',
            envelope,
            room.code,
          );
          return;
        }

        await room.enqueue(() => {
          room.restorePersistedState(saved.state, { preserveSequence: true });
          room.recordEvent(MessageType.LOAD_STATE, {}, session.userId);
          room.broadcastSnapshot();
          session.send(
            createEnvelope(
              MessageType.LOAD_STATE,
              { loadedAt: Date.now(), filename: path.basename(saved.filename) },
              {
                msg_id: envelope.msg_id,
                room: room.code,
                user_id: session.userId,
                seq: room.seq,
              },
            ),
          );
        });
        break;
      }

      default: {
        this.logger.debug(`Unhandled message type: ${envelope.type}`);
        break;
      }
    }
  }

  /**
   * Periodically drops sessions that have been silent for longer than the heartbeat timeout.
   * Dropping a session removes the participant from the live roster (peers get PARTICIPANT_LEFT)
   * but keeps the room and the participant's identity, so the client can reconnect and resume.
   */
  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of this.sessions.entries()) {
        if (now - session.lastSeenAt > this.heartbeatTimeoutMs) {
          this.logger.warn(
            `Session ${sessionId} silent for >${this.heartbeatTimeoutMs / 1000}s. Terminating connection.`,
          );
          session.destroy('Heartbeat timeout (silence)');
        }
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Starts the TCP server listening on the configured network interface and port.
   */
  public async listen(): Promise<{ port: number; host: string }> {
    if (!this.hasRestoredRooms) {
      const savedRooms = await this.persistence.loadAll();
      this.roomManager.restoreRooms(savedRooms.map(({ state }) => state));
      this.hasRestoredRooms = true;
    }

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

        if (this.discoveryPort !== undefined) {
          this.discovery = new DiscoveryResponder({
            port: this.discoveryPort,
            tcpPort: boundPort,
            getRoomCount: () => this.roomManager.activeRoomCount,
          });
          void this.discovery.start();
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
    await this.discovery?.stop();
    this.discovery = null;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    for (const session of this.sessions.values()) {
      session.destroy('Server shutting down');
    }
    this.sessions.clear();

    await new Promise<void>((resolve) => {
      this.server.close(() => {
        this.logger.info('Server closed cleanly');
        resolve();
      });
    });
    await this.persistence.flush();
  }
}
