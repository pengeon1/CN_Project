/**
 * @fileoverview Room state container, participant coordinator, sequence sequencing,
 * whiteboard object store, and operation serial queue implementation.
 *
 * Reliability invariants maintained here:
 * - Every sequence number handed out by {@link Room.nextSeq} is paired with exactly one entry in
 *   the operations log (drawing ops, chat messages and participant events alike). The log is
 *   therefore gap-free and can answer any RESYNC_REQUEST that falls inside its window.
 * - Every client operation is idempotent on its `op_id`: a retried operation is recognised,
 *   not re-applied, and maps back to the seq it originally received.
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
 * Maximum number of processed op ids remembered for idempotency checks.
 */
const MAX_PROCESSED_OPS = 10_000;

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
  private disconnectedParticipants: Map<string, Participant> = new Map();
  private sessionTokenToUserId: Map<string, string> = new Map();
  private objects: Map<string, WhiteboardObject> = new Map();
  /**
   * op_id -> the seq the operation was assigned. Insertion-ordered so the oldest entry can be
   * evicted once {@link MAX_PROCESSED_OPS} is exceeded.
   */
  private processedOps: Map<string, number> = new Map();
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
   * Appends an accepted sequenced event to the ordered operations log.
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
   *
   * Callers must pair every call with an entry in the operations log (see {@link Room.commit}
   * and {@link Room.recordEvent}) so that the log never has holes.
   */
  public nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /**
   * Checks whether an operation with op_id has already been processed (idempotency check).
   */
  public hasProcessedOp(opId: string): boolean {
    return this.processedOps.has(opId);
  }

  /**
   * Returns the sequence number a previously processed operation was assigned, if any.
   * Used by the server to acknowledge a retried operation without re-broadcasting it.
   */
  public getProcessedOpSeq(opId: string): number | undefined {
    return this.processedOps.get(opId);
  }

  /**
   * Records an op_id as processed together with its assigned seq, bounding the retention window
   * to the most recent {@link MAX_PROCESSED_OPS} operations.
   */
  public markOpProcessed(opId: string, seq: number = this.seq): void {
    if (this.processedOps.size >= MAX_PROCESSED_OPS) {
      const oldest = this.processedOps.keys().next().value;
      if (oldest !== undefined) this.processedOps.delete(oldest);
    }
    this.processedOps.set(opId, seq);
  }

  /**
   * Assigns the next seq to an accepted operation, remembers its op_id and appends it to the log.
   *
   * @returns The sequence number assigned to the operation.
   */
  private commit(
    opId: string,
    userId: string,
    type: MessageEnvelope['type'],
    payload: unknown,
    ts: number,
  ): number {
    const seq = this.nextSeq();
    this.markOpProcessed(opId, seq);
    this.recordOperation({ op_id: opId, seq, userId, type, payload, ts });
    return seq;
  }

  /**
   * Sequences a non-drawing event (participant change, chat message...) and records it in the
   * operations log so that it is delivered by resync exactly like a drawing operation.
   *
   * @param opId Idempotency key; a fresh UUID for events that are not client operations.
   */
  public recordEvent(
    type: MessageEnvelope['type'],
    payload: unknown,
    userId: string,
    opId: string = generateUuid(),
    ts: number = Date.now(),
  ): { seq: number; ts: number } {
    const seq = this.commit(opId, userId, type, payload, ts);
    return { seq, ts };
  }

  /**
   * Creates a new StrokeObject and registers it into the room's canvas state and operations log.
   *
   * Idempotent: replaying the same op_id (or the same strokeId) returns the existing stroke
   * without consuming a new sequence number.
   */
  public applyStrokeBegin(
    opId: string,
    strokeId: string,
    authorId: string,
    color: string,
    width: number,
    startPoint: Point,
  ): StrokeObject {
    const priorSeq = this.processedOps.get(opId);
    const existing = this.objects.get(strokeId);

    if (existing && existing.type === 'stroke') {
      return existing;
    }

    if (priorSeq !== undefined) {
      // The op was applied before but its stroke has since been erased or cleared.
      // Report the original outcome without resurrecting the stroke.
      return {
        id: strokeId,
        authorId,
        seq: priorSeq,
        zIndex: 0,
        updatedAt: Date.now(),
        type: 'stroke',
        color,
        width,
        points: [startPoint],
        isComplete: true,
      };
    }

    const ts = Date.now();
    const stroke: StrokeObject = {
      id: strokeId,
      authorId,
      seq: 0,
      zIndex: this.objects.size + 1,
      updatedAt: ts,
      type: 'stroke',
      color,
      width,
      points: [startPoint],
      isComplete: false,
    };
    stroke.seq = this.commit(
      opId,
      authorId,
      MessageType.STROKE_BEGIN,
      { op_id: opId, strokeId, color, width, startPoint },
      ts,
    );
    this.objects.set(strokeId, stroke);
    return stroke;
  }

  /**
   * Appends batched points to an active freehand stroke and records the operation.
   * The recorded payload carries `startIndex`, the index of the first appended point, so that
   * receivers can apply the batch idempotently.
   *
   * @returns The updated stroke, or null if the stroke is unknown or already completed.
   */
  public applyStrokePoints(opId: string, strokeId: string, points: Point[]): StrokeObject | null {
    const obj = this.objects.get(strokeId);
    if (this.hasProcessedOp(opId)) {
      return obj && obj.type === 'stroke' ? obj : null;
    }
    if (!obj || obj.type !== 'stroke' || obj.isComplete) {
      return null;
    }

    const startIndex = obj.points.length;
    const ts = Date.now();
    obj.points.push(...points);
    obj.updatedAt = ts;
    obj.seq = this.commit(
      opId,
      obj.authorId,
      MessageType.STROKE_POINTS,
      { op_id: opId, strokeId, points, startIndex },
      ts,
    );

    return obj;
  }

  /**
   * Finalizes a freehand stroke, marks it complete, and records the operation.
   *
   * @returns The finalized stroke, or null if the stroke is unknown or already completed.
   */
  public applyStrokeEnd(opId: string, strokeId: string, finalPoint?: Point): StrokeObject | null {
    const obj = this.objects.get(strokeId);
    if (this.hasProcessedOp(opId)) {
      return obj && obj.type === 'stroke' ? obj : null;
    }
    if (!obj || obj.type !== 'stroke' || obj.isComplete) {
      return null;
    }

    const startIndex = obj.points.length;
    const ts = Date.now();
    if (finalPoint) {
      obj.points.push(finalPoint);
    }
    obj.isComplete = true;
    obj.updatedAt = ts;
    obj.seq = this.commit(
      opId,
      obj.authorId,
      MessageType.STROKE_END,
      {
        op_id: opId,
        strokeId,
        finalPoint,
        startIndex: finalPoint ? startIndex : undefined,
      },
      ts,
    );

    return obj;
  }

  public getObject(id: string): WhiteboardObject | undefined {
    return this.objects.get(id);
  }

  /**
   * Erases specified whiteboard objects by ID and records the ERASE operation.
   * Ensures idempotency: if opId was already processed, returns its original seq without mutating.
   */
  public eraseObjects(
    opId: string,
    objectIds: string[],
    userId: string = '',
  ): { seq: number; erasedIds: string[] } {
    const priorSeq = this.processedOps.get(opId);
    if (priorSeq !== undefined) {
      return { seq: priorSeq, erasedIds: [] };
    }
    const erasedIds: string[] = [];
    for (const id of objectIds) {
      if (this.objects.has(id)) {
        this.objects.delete(id);
        erasedIds.push(id);
      }
    }
    const seq = this.commit(
      opId,
      userId,
      MessageType.ERASE,
      { op_id: opId, objectIds },
      Date.now(),
    );

    return { seq, erasedIds };
  }

  /**
   * Clears all objects from the whiteboard canvas and records the CLEAR_CANVAS operation.
   * Ensures idempotency: if opId was already processed, returns its original seq without mutating.
   */
  public clearCanvas(opId: string, userId: string = ''): { seq: number } {
    const priorSeq = this.processedOps.get(opId);
    if (priorSeq !== undefined) {
      return { seq: priorSeq };
    }
    this.objects.clear();
    const seq = this.commit(
      opId,
      userId || this.hostUserId,
      MessageType.CLEAR_CANVAS,
      { op_id: opId },
      Date.now(),
    );

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
   * supplies the incremental operations (contiguous: lastSeq+1 .. room.seq).
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
   * Whether `sessionToken` identifies a participant of this room who may resume their identity,
   * either because they were disconnected, or because their old connection has not been
   * reaped yet (a reconnect that beats the server's own timeout).
   */
  public canResume(sessionToken: string | undefined): boolean {
    if (!sessionToken) return false;
    const userId = this.sessionTokenToUserId.get(sessionToken);
    if (!userId) return false;
    return this.disconnectedParticipants.has(userId) || this.participants.has(userId);
  }

  /**
   * Registers a connected client as a room participant.
   *
   * If the sessionToken is recognized the participant's previous userId, color and role are
   * restored:
   * - when the old connection was already reaped, the participant is re-admitted and a
   *   PARTICIPANT_JOINED event is broadcast;
   * - when the old connection is still registered (the client noticed the drop first), the new
   *   session silently takes over the participant. Nothing changed for the other participants,
   *   so no event is emitted and no sequence number is consumed.
   *
   * A restored HOST who lost host ownership while away (ownership was transferred) returns as
   * an EDITOR so that the room never ends up with two hosts.
   */
  public addParticipant(
    session: ClientSession,
    username: string,
    role?: Role,
    sessionToken?: string,
  ): Participant {
    const token = sessionToken ?? session.sessionId;
    const priorUserId = token ? this.sessionTokenToUserId.get(token) : undefined;

    // Case 1: takeover of a participant whose stale connection is still registered.
    const live = priorUserId ? this.participants.get(priorUserId) : undefined;
    if (priorUserId && live) {
      const staleSession = live.session;
      session.userId = priorUserId;
      session.username = live.participant.username;
      session.role = live.participant.role;
      session.color = live.participant.color;
      session.roomCode = this.code;
      this.participants.set(priorUserId, { session, participant: live.participant });

      if (staleSession !== session) {
        // Detach first so the stale session's close handler cannot evict the new entry.
        staleSession.roomCode = null;
        staleSession.destroy('Superseded by reconnect');
      }
      this.logger.info(
        `Participant ${live.participant.username} (${priorUserId}) resumed on a new connection (took over stale session).`,
      );
      return live.participant;
    }

    // Case 2: re-admission of a disconnected participant, or a brand-new participant.
    const priorParticipant = priorUserId
      ? this.disconnectedParticipants.get(priorUserId)
      : undefined;

    let assignedRole: Role;
    let assignedColor: string;

    if (priorParticipant) {
      this.disconnectedParticipants.delete(priorParticipant.id);
      session.userId = priorParticipant.id;
      assignedRole =
        priorParticipant.role === Role.HOST && this.hostUserId !== priorParticipant.id
          ? Role.EDITOR
          : priorParticipant.role;
      assignedColor = priorParticipant.color;
    } else {
      assignedRole = role ?? (this.participants.size === 0 ? Role.HOST : Role.EDITOR);
      assignedColor = session.color ?? this.pickColor();
    }

    if (token) {
      this.sessionTokenToUserId.set(token, session.userId);
    }

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

    // Sequence + log the join so that peers that miss the broadcast can recover it via resync.
    const joined = this.recordEvent(
      MessageType.PARTICIPANT_JOINED,
      { participant },
      session.userId,
    );
    const joinedEnvelope = createEnvelope(
      MessageType.PARTICIPANT_JOINED,
      { participant },
      {
        room: this.code,
        user_id: session.userId,
        seq: joined.seq,
        ts: joined.ts,
      },
    );

    // Existing peers are notified; the joining session itself learns about the join from the
    // snapshot (or resync response) it receives next, so it is registered afterwards.
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
   *
   * @param userId The participant to remove.
   * @param reason Optional human readable reason (shown in the chat as a system notice).
   * @param session When provided, the removal only happens if this is the participant's
   *   *current* session. This stops a stale connection that closes late from evicting the
   *   participant after they have already resumed on a newer connection.
   */
  public removeParticipant(
    userId: string,
    reason?: string,
    session?: ClientSession,
  ): Participant | null {
    const entry = this.participants.get(userId);
    if (!entry) return null;
    if (session && entry.session !== session) return null;

    this.participants.delete(userId);
    this.disconnectedParticipants.set(userId, entry.participant);
    entry.session.roomCode = null;

    const leftPayload = {
      userId,
      username: entry.participant.username,
      reason,
    };
    const left = this.recordEvent(MessageType.PARTICIPANT_LEFT, leftPayload, userId);
    const leftEnvelope = createEnvelope(MessageType.PARTICIPANT_LEFT, leftPayload, {
      room: this.code,
      user_id: userId,
      seq: left.seq,
      ts: left.ts,
    });

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

      const promoPayload = {
        targetUserId: nextHostEntry.participant.id,
        newRole: Role.HOST,
      };
      const promo = this.recordEvent(
        MessageType.PERMISSION_CHANGE,
        promoPayload,
        nextHostEntry.participant.id,
      );
      const promoEnvelope = createEnvelope(MessageType.PERMISSION_CHANGE, promoPayload, {
        room: this.code,
        user_id: this.hostUserId,
        seq: promo.seq,
        ts: promo.ts,
      });
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
