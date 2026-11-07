/**
 * @fileoverview Room state container, participant coordinator, sequence sequencing,
 * whiteboard object store, and operation serial queue implementation.
 */

import {
  type ChatMessage,
  COMPACT_RETAIN_OPS,
  createEnvelope,
  generateUuid,
  MAX_CHAT_HISTORY_SIZE,
  MAX_OPS_LOG_SIZE,
  MAX_RESYNC_OPS_WINDOW,
  type MessageEnvelope,
  MessageType,
  type Participant,
  PARTICIPANT_COLORS,
  type Point,
  type ResyncResponsePayload,
  Role,
  type RoomSnapshot,
  type SequencedOperation,
  type StrokeObject,
  type WhiteboardObject,
} from '@cn-whiteboard/common';
import { Logger } from './logger.js';
import type { ClientSession } from './session.js';

export interface RoomParticipantEntry {
  session: ClientSession;
  participant: Participant;
}

/**
 * Represents an active whiteboard room on the server.
 */
export class Room {
  public readonly code: string;
  public readonly name: string;
  public readonly createdAt: number;
  public hostUserId: string;
  public locked: boolean = false;
  public passwordHash: string | null = null;

  /**
   * Monotonically increasing sequence counter for all sequenced actions in this room.
   */
  public seq: number = 0;

  /**
   * Sequence number up to which operations have been trimmed/compacted.
   */
  public baseSeq: number = 0;

  /**
   * Maximum operations allowed in the log before auto-compaction triggers.
   */
  public maxOpsLogSize: number = MAX_OPS_LOG_SIZE;

  /**
   * Number of recent operations retained when compaction is triggered.
   */
  public compactRetainOps: number = COMPACT_RETAIN_OPS;

  /**
   * Maximum messages retained in the chronological chat history log.
   */
  public maxChatHistorySize: number = MAX_CHAT_HISTORY_SIZE;

  private operationsLog: SequencedOperation[] = [];
  private chatHistory: ChatMessage[] = [];
  private participants: Map<string, RoomParticipantEntry> = new Map();
  private objects: Map<string, WhiteboardObject> = new Map();
  private processedOpIds: Set<string> = new Set();
  private colorIndex: number = 0;
  private serialQueue: Promise<void> = Promise.resolve();
  private logger: Logger;

  constructor(code: string, name: string, hostUserId: string, passwordHash?: string | null) {
    this.code = code;
    this.name = name;
    this.hostUserId = hostUserId;
    this.passwordHash = passwordHash ?? null;
    this.createdAt = Date.now();
    this.logger = new Logger(`Room ${code}`);
  }

  /**
   * The lowest sequence number currently retained in the ordered operations log.
   */
  public get oldestSeq(): number {
    if (this.operationsLog.length > 0) {
      return this.operationsLog[0]!.seq;
    }
    return this.baseSeq;
  }

  /**
   * Returns the count of operations currently retained in the log.
   */
  public get operationsCount(): number {
    return this.operationsLog.length;
  }

  /**
   * Appends an accepted mutating operation to the ordered operations log.
   * Triggers compaction if the log exceeds maxOpsLogSize.
   */
  public recordOperation(op: SequencedOperation): void {
    this.operationsLog.push(op);
    if (this.operationsLog.length > this.maxOpsLogSize) {
      this.compactLog();
    }
  }

  /**
   * Compacts the operations log by pruning older operations, retaining only `retainCount` recent ops.
   * Materialized whiteboard state is unaffected since `this.objects` already reflects all applied ops.
   */
  public compactLog(retainCount: number = this.compactRetainOps): {
    prunedCount: number;
    remainingCount: number;
  } {
    if (this.operationsLog.length <= retainCount) {
      return { prunedCount: 0, remainingCount: this.operationsLog.length };
    }

    const pruneCount = this.operationsLog.length - retainCount;
    const pruned = this.operationsLog.splice(0, pruneCount);
    const lastPruned = pruned[pruned.length - 1];
    if (lastPruned) {
      this.baseSeq = lastPruned.seq;
    }

    this.logger.debug(
      `Compacted ops log for room ${this.code}: pruned ${pruned.length} ops. Oldest retained seq: ${this.oldestSeq}, baseSeq: ${this.baseSeq}`,
    );

    return { prunedCount: pruned.length, remainingCount: this.operationsLog.length };
  }

  /**
   * Appends an accepted chat message to the room's chronological history.
   * Enforces maxChatHistorySize bounded queue.
   */
  public recordChatMessage(message: ChatMessage): void {
    this.chatHistory.push(message);
    if (this.chatHistory.length > this.maxChatHistorySize) {
      this.chatHistory.splice(0, this.chatHistory.length - this.maxChatHistorySize);
    }
  }

  /**
   * Records an automated system notification (e.g. participant joined or left).
   */
  public recordSystemMessage(text: string): ChatMessage {
    const systemMsg: ChatMessage = {
      id: generateUuid(),
      userId: '00000000-0000-0000-0000-000000000000',
      username: 'System',
      color: '#64748B',
      text,
      ts: Date.now(),
      isSystem: true,
    };
    this.recordChatMessage(systemMsg);
    return systemMsg;
  }

  /**
   * Returns a copy of the chronological chat history retained in the room.
   */
  public getChatHistory(): ChatMessage[] {
    return [...this.chatHistory];
  }

  /**
   * Serializes operations through a promise chain so state mutations occur strictly in FIFO order.
   * Prevents race conditions across the Node.js event loop.
   */
  public enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.serialQueue = this.serialQueue
        .then(async () => {
          const result = await task();
          resolve(result);
        })
        .catch((err) => {
          this.logger.error('Error executing queued room task:', err);
          reject(err);
        });
    });
  }

  /**
   * Increments and returns the next monotonic sequence number for this room.
   */
  public nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /**
   * Checks whether an operation with op_id has already been processed (idempotency check).
   */
  public hasProcessedOp(opId: string): boolean {
    return this.processedOpIds.has(opId);
  }

  /**
   * Records an op_id as processed, bounding the retention set to the most recent 10,000 ops.
   */
  public markOpProcessed(opId: string): void {
    if (this.processedOpIds.size > 10000) {
      const first = this.processedOpIds.values().next().value;
      if (first) this.processedOpIds.delete(first);
    }
    this.processedOpIds.add(opId);
  }

  /**
   * Creates a new StrokeObject and registers it into the room's canvas state and operations log.
   */
  public applyStrokeBegin(
    opId: string,
    strokeId: string,
    authorId: string,
    color: string,
    width: number,
    startPoint: Point,
  ): StrokeObject {
    if (this.hasProcessedOp(opId)) {
      const existing = this.objects.get(strokeId);
      if (existing && existing.type === 'stroke') {
        return existing;
      }
    }
    this.markOpProcessed(opId);
    const seq = this.nextSeq();
    const stroke: StrokeObject = {
      id: strokeId,
      authorId,
      seq,
      zIndex: this.objects.size + 1,
      updatedAt: Date.now(),
      type: 'stroke',
      color,
      width,
      points: [startPoint],
      isComplete: false,
    };
    this.objects.set(strokeId, stroke);
    this.recordOperation({
      op_id: opId,
      seq,
      userId: authorId,
      type: MessageType.STROKE_BEGIN,
      payload: {
        op_id: opId,
        strokeId,
        color,
        width,
        startPoint,
      },
      ts: stroke.updatedAt,
    });
    return stroke;
  }

  /**
   * Appends batched points to an active freehand stroke and records the operation.
   */
  public applyStrokePoints(opId: string, strokeId: string, points: Point[]): StrokeObject | null {
    if (this.hasProcessedOp(opId)) {
      const existing = this.objects.get(strokeId);
      return existing && existing.type === 'stroke' ? existing : null;
    }
    this.markOpProcessed(opId);
    const obj = this.objects.get(strokeId);
    if (!obj || obj.type !== 'stroke') {
      return null;
    }
    const seq = this.nextSeq();
    obj.seq = seq;
    obj.updatedAt = Date.now();
    obj.points.push(...points);

    this.recordOperation({
      op_id: opId,
      seq,
      userId: obj.authorId,
      type: MessageType.STROKE_POINTS,
      payload: {
        op_id: opId,
        strokeId,
        points,
      },
      ts: obj.updatedAt,
    });

    return obj;
  }

  /**
   * Finalizes a freehand stroke, marks it complete, and records the operation.
   */
  public applyStrokeEnd(opId: string, strokeId: string, finalPoint?: Point): StrokeObject | null {
    if (this.hasProcessedOp(opId)) {
      const existing = this.objects.get(strokeId);
      return existing && existing.type === 'stroke' ? existing : null;
    }
    this.markOpProcessed(opId);
    const obj = this.objects.get(strokeId);
    if (!obj || obj.type !== 'stroke') {
      return null;
    }
    const seq = this.nextSeq();
    obj.seq = seq;
    obj.updatedAt = Date.now();
    if (finalPoint) {
      obj.points.push(finalPoint);
    }
    obj.isComplete = true;

    this.recordOperation({
      op_id: opId,
      seq,
      userId: obj.authorId,
      type: MessageType.STROKE_END,
      payload: {
        op_id: opId,
        strokeId,
        finalPoint,
      },
      ts: obj.updatedAt,
    });

    return obj;
  }

  public getObject(id: string): WhiteboardObject | undefined {
    return this.objects.get(id);
  }

  /**
   * Erases specified whiteboard objects by ID and records the ERASE operation.
   * Ensures idempotency: if opId was already processed, returns existing state without incrementing seq.
   */
  public eraseObjects(
    opId: string,
    objectIds: string[],
    userId: string = '',
  ): { seq: number; erasedIds: string[] } {
    if (this.hasProcessedOp(opId)) {
      return { seq: this.seq, erasedIds: [] };
    }
    this.markOpProcessed(opId);
    const erasedIds: string[] = [];
    for (const id of objectIds) {
      if (this.objects.has(id)) {
        this.objects.delete(id);
        erasedIds.push(id);
      }
    }
    const seq = this.nextSeq();

    this.recordOperation({
      op_id: opId,
      seq,
      userId,
      type: MessageType.ERASE,
      payload: {
        op_id: opId,
        objectIds,
      },
      ts: Date.now(),
    });

    return { seq, erasedIds };
  }

  /**
   * Clears all objects from the whiteboard canvas and records the CLEAR_CANVAS operation.
   * Ensures idempotency: if opId was already processed, returns existing seq without duplicate mutations.
   */
  public clearCanvas(opId: string, userId: string = ''): { seq: number } {
    if (this.hasProcessedOp(opId)) {
      return { seq: this.seq };
    }
    this.markOpProcessed(opId);
    this.objects.clear();
    const seq = this.nextSeq();

    this.recordOperation({
      op_id: opId,
      seq,
      userId: userId || this.hostUserId,
      type: MessageType.CLEAR_CANVAS,
      payload: {
        op_id: opId,
      },
      ts: Date.now(),
    });

    this.recordSystemMessage('Whiteboard canvas was cleared by the room host.');

    return { seq };
  }

  /**
   * Returns all recorded operations with a sequence number strictly greater than sinceSeq.
   */
  public getOperationsSince(sinceSeq: number): SequencedOperation[] {
    return this.operationsLog.filter((op) => op.seq > sinceSeq);
  }

  /**
   * Generates resync data for a client requesting missed operations since lastSeq.
   * If the client gap is within the retained operations window and <= MAX_RESYNC_OPS_WINDOW,
   * supplies the incremental operations.
   * If the gap exceeds the window or falls before the oldest retained sequence number,
   * supplies a complete materialized RoomSnapshot.
   */
  public getResyncData(lastSeq: number): ResyncResponsePayload {
    if (lastSeq >= this.seq) {
      return {
        from_seq: lastSeq,
        to_seq: this.seq,
        operations: [],
      };
    }

    const gap = this.seq - lastSeq;
    // If client requested a sequence number older than what compaction retained (baseSeq > 0 && lastSeq < baseSeq)
    // or if the gap exceeds MAX_RESYNC_OPS_WINDOW, supply the full materialized snapshot.
    if ((this.baseSeq > 0 && lastSeq < this.baseSeq) || gap > MAX_RESYNC_OPS_WINDOW) {
      return {
        from_seq: 0,
        to_seq: this.seq,
        fullSnapshot: this.getSnapshot(),
      };
    }

    const operations = this.getOperationsSince(lastSeq);
    return {
      from_seq: lastSeq + 1,
      to_seq: this.seq,
      operations,
    };
  }

  /**
   * Selects an accent color for a new participant from the predefined palette.
   */
  private pickColor(): string {
    const color = PARTICIPANT_COLORS[this.colorIndex % PARTICIPANT_COLORS.length]!;
    this.colorIndex += 1;
    return color;
  }

  /**
   * Registers a connected client as a room participant.
   */
  public addParticipant(session: ClientSession, username: string, role?: Role): Participant {
    const assignedRole = role ?? (this.participants.size === 0 ? Role.HOST : Role.EDITOR);
    const assignedColor = session.color ?? this.pickColor();

    const participant: Participant = {
      id: session.userId,
      username,
      role: assignedRole,
      color: assignedColor,
      joinedAt: Date.now(),
    };

    session.username = username;
    session.role = assignedRole;
    session.color = assignedColor;
    session.roomCode = this.code;

    // Broadcast PARTICIPANT_JOINED to existing peers
    const joinedSeq = this.nextSeq();
    const joinedEnvelope = createEnvelope(
      MessageType.PARTICIPANT_JOINED,
      { participant },
      {
        room: this.code,
        user_id: session.userId,
        seq: joinedSeq,
      },
    );

    this.broadcast(joinedEnvelope);

    this.participants.set(session.userId, { session, participant });
    this.recordSystemMessage(`${username} joined the whiteboard.`);
    this.logger.info(
      `Participant joined: ${username} (${session.userId}) as ${assignedRole}. Total: ${this.participants.size}`,
    );

    return participant;
  }

  /**
   * Removes a participant from the room and broadcasts PARTICIPANT_LEFT.
   */
  public removeParticipant(userId: string, reason?: string): Participant | null {
    const entry = this.participants.get(userId);
    if (!entry) return null;

    this.participants.delete(userId);
    entry.session.roomCode = null;

    const leftSeq = this.nextSeq();
    const leftEnvelope = createEnvelope(
      MessageType.PARTICIPANT_LEFT,
      {
        userId,
        username: entry.participant.username,
        reason,
      },
      {
        room: this.code,
        user_id: userId,
        seq: leftSeq,
      },
    );

    this.broadcast(leftEnvelope);
    this.recordSystemMessage(
      `${entry.participant.username} left the session.${reason ? ` (${reason})` : ''}`,
    );
    this.logger.info(
      `Participant left: ${entry.participant.username} (${userId}). Total remaining: ${this.participants.size}`,
    );

    // If the host departed, promote the oldest active participant to HOST
    if (this.hostUserId === userId && this.participants.size > 0) {
      const nextHostEntry = Array.from(this.participants.values())[0]!;
      nextHostEntry.participant.role = Role.HOST;
      nextHostEntry.session.role = Role.HOST;
      this.hostUserId = nextHostEntry.participant.id;

      const promoSeq = this.nextSeq();
      const promoEnvelope = createEnvelope(
        MessageType.PERMISSION_CHANGE,
        {
          targetUserId: nextHostEntry.participant.id,
          newRole: Role.HOST,
        },
        {
          room: this.code,
          user_id: this.hostUserId,
          seq: promoSeq,
        },
      );
      this.broadcast(promoEnvelope);
      this.logger.info(`Transferred room host ownership to: ${nextHostEntry.participant.username}`);
    }

    return entry.participant;
  }

  /**
   * Retrieves participant details by user ID.
   */
  public getParticipant(userId: string): Participant | undefined {
    return this.participants.get(userId)?.participant;
  }

  /**
   * Retrieves the client session for a given user ID.
   */
  public getSession(userId: string): ClientSession | undefined {
    return this.participants.get(userId)?.session;
  }

  /**
   * Returns a snapshot array of all active participants.
   */
  public getParticipants(): Participant[] {
    return Array.from(this.participants.values()).map((e) => e.participant);
  }

  /**
   * Returns the count of connected participants.
   */
  public get participantCount(): number {
    return this.participants.size;
  }

  /**
   * Broadcasts a MessageEnvelope to all participants in this room.
   *
   * @param envelope The MessageEnvelope to distribute.
   * @param excludeUserId Optional user ID to exclude from broadcast (e.g. sender of an optimistic action).
   */
  public broadcast(envelope: MessageEnvelope, excludeUserId?: string): void {
    for (const [userId, entry] of this.participants.entries()) {
      if (excludeUserId && userId === excludeUserId) {
        continue;
      }
      entry.session.send(envelope);
    }
  }

  /**
   * Generates a complete snapshot of the room state for late-join synchronization or export.
   */
  public getSnapshot(): RoomSnapshot {
    const objectsRecord: Record<string, WhiteboardObject> = {};
    for (const [id, obj] of this.objects.entries()) {
      objectsRecord[id] = obj;
    }

    return {
      roomCode: this.code,
      roomName: this.name,
      seq: this.seq,
      objects: objectsRecord,
      participants: this.getParticipants(),
      chatHistory: this.getChatHistory(),
      locked: this.locked,
      createdAt: this.createdAt,
    };
  }
}
