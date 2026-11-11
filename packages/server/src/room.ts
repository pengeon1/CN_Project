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
  type ImageChunkPayload,
  MAX_VERSIONS,
  type PresentationState,
  VERSION_AUTO_INTERVAL_MS,
  type VersionMeta,
  type ImageObject,
  IMAGE_CHUNK_BYTES,
  MAX_IMAGE_BYTES,
  MAX_ROOM_IMAGE_BYTES,
  type ObjectChanges,
  type ShapeObject,
  type StrokeObject,
  type WhiteboardObject,
  applyObjectChanges,
  normalizeNewShape,
} from '@cn-whiteboard/common';
import { Logger } from './logger.js';
import type { ClientSession } from './session.js';

export interface RoomParticipantEntry {
  session: ClientSession;
  participant: Participant;
}

/**
 * JSON-safe room state needed to restore board consistency without restoring live sessions.
 */
export interface PersistedRoomState {
  schemaVersion: 1;
  roomCode: string;
  roomName: string;
  createdAt: number;
  hostUserId: string;
  locked: boolean;
  allowNameChanges?: boolean;
  passwordHash: string | null;
  seq: number;
  baseSeq: number;
  objects: Record<string, WhiteboardObject>;
  operations: SequencedOperation[];
  chatHistory: ChatMessage[];
  processedOps: Array<[string, number]>;
  userUndoStacks: Record<string, string[]>;
  userRedoStacks: Record<string, string[]>;
  undoSnapshots: Record<string, WhiteboardObject | Record<string, WhiteboardObject> | null>;
  redoSnapshots: Record<string, WhiteboardObject | Record<string, WhiteboardObject> | null>;
  /** Image assets by id (base64 bytes), so uploaded pictures survive a server restart. */
  assets?: Record<string, StoredAsset>;
  /** Saved board versions (full object maps), newest last. */
  versions?: StoredVersion[];
}

/** A saved copy of the board that the host can restore. */
export interface StoredVersion extends VersionMeta {
  objects: Record<string, WhiteboardObject>;
}

/** Operation types that change the board (and therefore make the room "dirty" for versioning). */
const BOARD_MUTATION_TYPES: ReadonlySet<string> = new Set([
  MessageType.STROKE_BEGIN,
  MessageType.STROKE_POINTS,
  MessageType.STROKE_END,
  MessageType.SHAPE_ADD,
  MessageType.IMAGE_ADD,
  MessageType.OBJECT_UPDATE,
  MessageType.OBJECT_DELETE,
  MessageType.ERASE,
  MessageType.CLEAR_CANVAS,
  MessageType.UNDO,
  MessageType.REDO,
]);

/** A fully received image asset. */
export interface StoredAsset {
  mime: ImageObject['mime'];
  data: string;
}

/** An image still arriving in chunks. */
interface PendingUpload {
  userId: string;
  mime: ImageObject['mime'];
  total: number;
  chunks: Array<string | undefined>;
  received: number;
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
  public allowNameChanges: boolean;
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
  private kickedSessionTokens = new Set<string>();
  private objects: Map<string, WhiteboardObject> = new Map();
  /**
   * op_id -> the seq the operation was assigned. Insertion-ordered so the oldest entry can be
   * evicted once {@link MAX_PROCESSED_OPS} is exceeded.
   */
  private processedOps: Map<string, number> = new Map();
  /**
   * Per-user undo stacks, ordered from oldest to newest. Only operations authored by the same user
   * are eligible for that user's undo/redo cycle.
   */
  private userUndoStacks: Map<string, string[]> = new Map();
  private userRedoStacks: Map<string, string[]> = new Map();
  /**
   * Snapshot of the board state before a user-authored mutation was applied. Used to resolve the
   * target of a compensating undo operation and to reapply it during redo.
   */
  private undoSnapshots: Map<string, WhiteboardObject | Record<string, WhiteboardObject> | null> =
    new Map();
  private redoSnapshots: Map<string, WhiteboardObject | Record<string, WhiteboardObject> | null> =
    new Map();
  /** Live presentation state; ephemeral (not persisted, not part of the ops log). */
  public presentation: PresentationState = { active: false };
  /** Minimum gap between automatic snapshots; a field so tests can shorten it. */
  public versionIntervalMs: number = VERSION_AUTO_INTERVAL_MS;
  private versions: StoredVersion[] = [];
  private lastVersionAt = Date.now();
  private boardDirty = false;
  private assets: Map<string, StoredAsset> = new Map();
  private pendingUploads: Map<string, PendingUpload> = new Map();
  private assetBytes = 0;
  private colorIndex: number = 0;
  private serialQueue: Promise<void> = Promise.resolve();
  private logger: Logger;
  private onChange: ((room: Room) => void) | null = null;
  private awaitingRestoredHost = false;

  constructor(
    code: string,
    name: string,
    hostUserId: string,
    passwordHash?: string | null,
    createdAt = Date.now(),
    allowNameChanges = false,
  ) {
    this.code = code;
    this.name = name;
    this.hostUserId = hostUserId;
    this.passwordHash = passwordHash ?? null;
    this.createdAt = createdAt;
    this.allowNameChanges = allowNameChanges;
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
   * Whether this restored room still needs its first live participant to claim host ownership.
   */
  public get isAwaitingRestoredHost(): boolean {
    return this.awaitingRestoredHost;
  }

  /**
   * Attaches the persistence scheduler used to debounce durable room writes.
   */
  public setOnChange(listener: ((room: Room) => void) | null): void {
    this.onChange = listener;
  }

  private notifyChanged(): void {
    this.onChange?.(this);
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
    this.notifyChanged();
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

  private cloneSnapshot<T>(value: T): T {
    return structuredClone(value);
  }

  private snapshotObjectMap(): Record<string, WhiteboardObject> {
    return Object.fromEntries(
      Array.from(this.objects.entries()).map(([id, object]) => [id, this.cloneSnapshot(object)]),
    );
  }

  private rememberUserMutation(userId: string, opId: string): void {
    if (!userId) return;
    const prior = this.userUndoStacks.get(userId) ?? [];
    if (!prior.includes(opId)) {
      prior.push(opId);
      this.userUndoStacks.set(userId, prior);
    }
    this.userRedoStacks.set(userId, []);
  }

  private getTargetObjectIdFromOperation(op: SequencedOperation): string | null {
    if (!op.payload || typeof op.payload !== 'object') return null;
    const record = op.payload as Record<string, unknown>;
    if (typeof record.strokeId === 'string') return record.strokeId;
    if (typeof record.id === 'string') return record.id;
    if (typeof record.object === 'object' && record.object && 'id' in record.object) {
      return String((record.object as { id?: string }).id ?? null);
    }
    return null;
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
    if (BOARD_MUTATION_TYPES.has(type)) {
      this.maybeAutoSnapshot(ts);
      this.boardDirty = true;
    }
    const seq = this.nextSeq();
    this.markOpProcessed(opId, seq);
    this.recordOperation({ op_id: opId, seq, userId, type, payload, ts });
    this.notifyChanged();
    return seq;
  }

  /**
   * Creates a JSON-safe copy of the complete state required to resume a room after a restart.
   */
  public getPersistedState(): PersistedRoomState {
    return {
      schemaVersion: 1,
      roomCode: this.code,
      roomName: this.name,
      createdAt: this.createdAt,
      hostUserId: this.hostUserId,
      locked: this.locked,
      allowNameChanges: this.allowNameChanges,
      passwordHash: this.passwordHash,
      seq: this.seq,
      baseSeq: this.baseSeq,
      objects: Object.fromEntries(
        Array.from(this.objects, ([id, object]) => [id, this.cloneSnapshot(object)]),
      ),
      operations: this.cloneSnapshot(this.operationsLog),
      chatHistory: this.cloneSnapshot(this.chatHistory),
      processedOps: Array.from(this.processedOps.entries()),
      userUndoStacks: Object.fromEntries(
        Array.from(this.userUndoStacks, ([id, stack]) => [id, [...stack]]),
      ),
      userRedoStacks: Object.fromEntries(
        Array.from(this.userRedoStacks, ([id, stack]) => [id, [...stack]]),
      ),
      undoSnapshots: Object.fromEntries(
        Array.from(this.undoSnapshots, ([id, snapshot]) => [id, this.cloneSnapshot(snapshot)]),
      ),
      redoSnapshots: Object.fromEntries(
        Array.from(this.redoSnapshots, ([id, snapshot]) => [id, this.cloneSnapshot(snapshot)]),
      ),
      assets: Object.fromEntries(this.assets),
      versions: this.cloneSnapshot(this.versions),
    };
  }

  /**
   * Restores durable state while intentionally dropping old live sessions and participant sockets.
   */
  public restorePersistedState(
    state: PersistedRoomState,
    options: { preserveSequence?: boolean; restoredFromDisk?: boolean } = {},
  ): void {
    if (state.roomCode !== this.code || state.roomName !== this.name) {
      throw new Error(`Persisted room identity does not match ${this.code}`);
    }

    const previousSeq = this.seq;
    const previousHostUserId = this.hostUserId;
    const previousLocked = this.locked;
    const previousAllowNameChanges = this.allowNameChanges;
    const previousPasswordHash = this.passwordHash;
    const previousProcessedOps = this.processedOps;
    this.hostUserId = options.preserveSequence ? previousHostUserId : state.hostUserId;
    this.locked = options.preserveSequence ? previousLocked : state.locked;
    this.allowNameChanges = options.preserveSequence
      ? previousAllowNameChanges
      : (state.allowNameChanges ?? false);
    this.passwordHash = options.preserveSequence ? previousPasswordHash : state.passwordHash;
    this.awaitingRestoredHost = options.restoredFromDisk ?? false;
    this.seq = options.preserveSequence ? Math.max(previousSeq, state.seq) : state.seq;
    this.baseSeq = options.preserveSequence ? this.seq + 1 : state.baseSeq;
    this.objects = new Map(
      Object.entries(state.objects).map(([id, object]) => [id, this.cloneSnapshot(object)]),
    );
    this.operationsLog = options.preserveSequence ? [] : this.cloneSnapshot(state.operations);
    this.chatHistory = this.cloneSnapshot(state.chatHistory);
    this.processedOps = new Map(state.processedOps);
    if (options.preserveSequence) {
      for (const [opId, seq] of previousProcessedOps) this.processedOps.set(opId, seq);
      while (this.processedOps.size > MAX_PROCESSED_OPS) {
        const oldestOpId = this.processedOps.keys().next().value;
        if (oldestOpId === undefined) break;
        this.processedOps.delete(oldestOpId);
      }
    }
    this.userUndoStacks = new Map(
      Object.entries(state.userUndoStacks).map(([id, stack]) => [id, [...stack]]),
    );
    this.userRedoStacks = new Map(
      Object.entries(state.userRedoStacks).map(([id, stack]) => [id, [...stack]]),
    );
    this.undoSnapshots = new Map(
      Object.entries(state.undoSnapshots).map(([id, snapshot]) => [
        id,
        this.cloneSnapshot(snapshot),
      ]),
    );
    this.redoSnapshots = new Map(
      Object.entries(state.redoSnapshots).map(([id, snapshot]) => [
        id,
        this.cloneSnapshot(snapshot),
      ]),
    );
    if (!options.preserveSequence) {
      this.versions = this.cloneSnapshot(state.versions ?? []);
    }
    // A manual LOAD keeps assets already held (live clients may still reference them).
    if (!options.preserveSequence) {
      this.assets = new Map();
      this.assetBytes = 0;
    }
    for (const [id, asset] of Object.entries(state.assets ?? {})) {
      if (!this.assets.has(id)) {
        this.assets.set(id, asset);
        this.assetBytes += Buffer.byteLength(asset.data, 'base64');
      }
    }
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
    this.undoSnapshots.set(opId, this.cloneSnapshot(existing ?? null));
    stroke.seq = this.commit(
      opId,
      authorId,
      MessageType.STROKE_BEGIN,
      { op_id: opId, strokeId, color, width, startPoint },
      ts,
    );
    this.objects.set(strokeId, stroke);
    this.rememberUserMutation(authorId, opId);
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

    this.undoSnapshots.set(opId, this.cloneSnapshot(obj));
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

    this.undoSnapshots.set(opId, this.cloneSnapshot(obj));
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

  /** Highest zIndex currently on the board (0 when empty), used to place new objects on top. */
  private maxZIndex(): number {
    let max = 0;
    for (const obj of this.objects.values()) max = Math.max(max, obj.zIndex);
    return max;
  }

  // ---- Version history -------------------------------------------------------------------

  /**
   * Saves a copy of the current board. Automatic snapshots are evicted first when the cap is hit,
   * so a host's named versions outlive background ones.
   */
  public addVersion(name: string, userId: string | null, auto: boolean): VersionMeta {
    const version: StoredVersion = {
      id: generateUuid(),
      name,
      ts: Date.now(),
      createdBy: userId,
      auto,
      objectCount: this.objects.size,
      objects: this.snapshotObjectMap(),
    };
    this.versions.push(version);
    while (this.versions.length > MAX_VERSIONS) {
      const evict = this.versions.findIndex((v) => v.auto);
      this.versions.splice(evict === -1 ? 0 : evict, 1);
    }
    this.lastVersionAt = version.ts;
    this.boardDirty = false;
    this.notifyChanged();
    return this.toMeta(version);
  }

  /**
   * Takes an automatic snapshot if the board changed and the interval elapsed. Called lazily from
   * the first board edit after the interval (no timers), so it captures the state just before
   * that edit and idle rooms cost nothing.
   */
  public maybeAutoSnapshot(now: number = Date.now()): VersionMeta | null {
    if (!this.boardDirty || now - this.lastVersionAt < this.versionIntervalMs) return null;
    return this.addVersion(`Auto-save ${new Date(now).toLocaleTimeString()}`, null, true);
  }

  private toMeta(v: StoredVersion): VersionMeta {
    return {
      id: v.id,
      name: v.name,
      ts: v.ts,
      createdBy: v.createdBy,
      auto: v.auto,
      objectCount: v.objectCount,
    };
  }

  /** Version listing, newest first, without the (large) object data. */
  public listVersions(): VersionMeta[] {
    return this.versions.map((v) => this.toMeta(v)).reverse();
  }

  /**
   * Replaces the whole board with a saved version. The current board is saved first (as an
   * automatic version) so a restore can itself be reverted. Per-user undo history is cleared
   * because its targets no longer exist, and the ops log is reset so lagging clients take a full
   * snapshot instead of replaying across the jump.
   *
   * @returns The restored version's metadata, or null if the id is unknown.
   */
  public restoreVersion(versionId: string): VersionMeta | null {
    const version = this.versions.find((v) => v.id === versionId);
    if (!version) return null;

    this.addVersion(`Before restoring "${version.name}"`, null, true);
    this.objects = new Map(
      Object.entries(version.objects).map(([id, o]) => [id, this.cloneSnapshot(o)]),
    );
    this.userUndoStacks.clear();
    this.userRedoStacks.clear();
    this.undoSnapshots.clear();
    this.redoSnapshots.clear();
    this.operationsLog = [];
    this.baseSeq = this.seq + 1;
    this.boardDirty = true;
    this.notifyChanged();
    return this.toMeta(version);
  }

  /**
   * Accepts one chunk of an image upload and assembles the asset when the last chunk arrives.
   * Size, quota and file signature are all verified here, not trusted from the client.
   *
   * @returns 'partial' while chunks are missing, 'complete' once stored, otherwise an error text.
   */
  public receiveImageChunk(
    userId: string,
    chunk: ImageChunkPayload,
  ): 'partial' | 'complete' | { error: string } {
    if (this.assets.has(chunk.assetId)) return 'complete'; // duplicate upload, already stored
    let up = this.pendingUploads.get(chunk.assetId);
    if (!up) {
      if (this.pendingUploads.size >= 8) return { error: 'Too many uploads in progress' };
      up = {
        userId,
        mime: chunk.mime,
        total: chunk.total,
        chunks: new Array<string | undefined>(chunk.total).fill(undefined),
        received: 0,
      };
      this.pendingUploads.set(chunk.assetId, up);
    }
    if (up.userId !== userId || up.total !== chunk.total || up.mime !== chunk.mime) {
      return { error: 'Inconsistent upload chunk' };
    }
    if (chunk.index >= up.total) return { error: 'Chunk index out of range' };
    if (up.chunks[chunk.index] === undefined) {
      up.chunks[chunk.index] = chunk.data;
      up.received += 1;
    }
    if (up.received < up.total) return 'partial';

    this.pendingUploads.delete(chunk.assetId);
    const data = up.chunks.join('');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length > MAX_IMAGE_BYTES || bytes.length > IMAGE_CHUNK_BYTES * up.total) {
      return { error: 'Image is too large' };
    }
    if (this.assetBytes + bytes.length > MAX_ROOM_IMAGE_BYTES) {
      return { error: 'Room image storage is full' };
    }
    if (!matchesImageSignature(bytes, up.mime)) {
      return { error: 'File content does not match its image type' };
    }
    this.assets.set(chunk.assetId, { mime: up.mime, data });
    this.assetBytes += bytes.length;
    return 'complete';
  }

  /** Drops unfinished uploads of a user who disconnected, freeing the memory they held. */
  public dropPendingUploads(userId: string): void {
    for (const [id, up] of this.pendingUploads) {
      if (up.userId === userId) this.pendingUploads.delete(id);
    }
  }

  public getAsset(assetId: string): StoredAsset | undefined {
    return this.assets.get(assetId);
  }

  /**
   * Adds an image object whose bytes were already uploaded. Authorship, z-order and seq are
   * server-assigned exactly as for shapes.
   *
   * @returns The stored object, or null when the asset is missing or the id is taken.
   */
  public applyImageAdd(opId: string, object: ImageObject, userId: string): ImageObject | null {
    if (this.hasProcessedOp(opId)) {
      const existing = this.objects.get(object.id);
      return existing && existing.type === 'image' ? existing : null;
    }
    const asset = this.assets.get(object.assetId);
    if (!asset || asset.mime !== object.mime || this.objects.has(object.id)) return null;

    const ts = Date.now();
    const stored = normalizeNewShape(object, userId, this.maxZIndex() + 1, 0, ts);
    stored.bytes = Buffer.byteLength(asset.data, 'base64');
    this.undoSnapshots.set(opId, null);
    stored.seq = this.commit(
      opId,
      userId,
      MessageType.IMAGE_ADD,
      { op_id: opId, object: stored },
      ts,
    );
    this.objects.set(stored.id, stored);
    this.rememberUserMutation(userId, opId);
    return stored;
  }

  /**
   * Adds a shape, text box or sticky note. The server assigns authorship, z-order and seq, so a
   * client cannot forge another user's authorship or jump the layer order.
   *
   * @returns The stored object, or null if the object id is already taken by a different op.
   */
  public applyShapeAdd(opId: string, object: ShapeObject, userId: string): ShapeObject | null {
    if (this.hasProcessedOp(opId)) {
      const existing = this.objects.get(object.id);
      return existing && existing.type === 'shape' ? existing : null;
    }
    if (this.objects.has(object.id)) return null;

    const ts = Date.now();
    const stored = normalizeNewShape(object, userId, this.maxZIndex() + 1, 0, ts);
    this.undoSnapshots.set(opId, null);
    stored.seq = this.commit(
      opId,
      userId,
      MessageType.SHAPE_ADD,
      { op_id: opId, object: stored },
      ts,
    );
    this.objects.set(stored.id, stored);
    this.rememberUserMutation(userId, opId);
    return stored;
  }

  /**
   * Applies a property update to one object. Because the room serializes all operations, the
   * order of application is the seq order: last writer wins per property, deterministically.
   *
   * @returns The updated object, or null when the target no longer exists (deleted/erased first).
   */
  public applyObjectUpdate(
    opId: string,
    id: string,
    changes: ObjectChanges,
    userId: string,
  ): WhiteboardObject | null {
    const current = this.objects.get(id);
    if (this.hasProcessedOp(opId)) return current ?? null;
    if (!current) return null;

    const ts = Date.now();
    this.undoSnapshots.set(opId, this.cloneSnapshot(current));
    const updated = applyObjectChanges(current, changes, 0, ts);
    updated.seq = this.commit(
      opId,
      userId,
      MessageType.OBJECT_UPDATE,
      { op_id: opId, id, changes },
      ts,
    );
    this.objects.set(id, updated);
    this.rememberUserMutation(userId, opId);
    return updated;
  }

  /**
   * Deletes one object. Stored as a snapshot map (like ERASE) so undo can restore it.
   *
   * @returns The sequence number, or null when the object does not exist.
   */
  public applyObjectDelete(opId: string, id: string, userId: string): number | null {
    const prior = this.processedOps.get(opId);
    if (prior !== undefined) return prior;
    const current = this.objects.get(id);
    if (!current) return null;

    this.undoSnapshots.set(opId, { [id]: this.cloneSnapshot(current) });
    this.objects.delete(id);
    const seq = this.commit(
      opId,
      userId,
      MessageType.OBJECT_DELETE,
      { op_id: opId, id },
      Date.now(),
    );
    this.rememberUserMutation(userId, opId);
    return seq;
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

    const snapshot = Object.fromEntries(
      objectIds
        .filter((id) => this.objects.has(id))
        .map((id) => [id, this.cloneSnapshot(this.objects.get(id)!)]),
    );
    this.undoSnapshots.set(opId, snapshot);

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
    this.rememberUserMutation(userId, opId);

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
    this.undoSnapshots.set(opId, this.snapshotObjectMap());
    this.objects.clear();
    const seq = this.commit(
      opId,
      userId || this.hostUserId,
      MessageType.CLEAR_CANVAS,
      { op_id: opId },
      Date.now(),
    );
    this.rememberUserMutation(userId || this.hostUserId, opId);

    this.recordSystemMessage('Whiteboard canvas was cleared by the room host.');

    return { seq };
  }

  /**
   * Applies a user-scoped undo by removing the target op from the live canvas state. This does not
   * rewrite the authoritative history; instead it emits a compensating UNDO op that is sequenced and
   * broadcast to every peer, matching the protocol contract.
   */
  public applyUndo(
    opId: string,
    targetOpId: string,
    userId: string,
  ): {
    accepted: boolean;
    seq?: number;
    message?: string;
    payload?: {
      op_id: string;
      target_op_id: string;
      removeIds: string[];
      restoreObjects: WhiteboardObject[];
    };
  } {
    const undoStack = this.userUndoStacks.get(userId) ?? [];
    if (undoStack[undoStack.length - 1] !== targetOpId) {
      return { accepted: false, message: 'Only the most recent operation can be undone.' };
    }

    const target = this.operationsLog.find((op) => op.op_id === targetOpId);
    if (!target) {
      return { accepted: false, message: 'The target operation is no longer available.' };
    }

    if (target.userId !== userId) {
      return {
        accepted: false,
        message: 'Undo can only target operations authored by the current user.',
      };
    }

    const objectId = this.getTargetObjectIdFromOperation(target);
    const targetSnapshot = objectId ? this.objects.get(objectId) : undefined;
    if (
      target.type !== MessageType.CLEAR_CANVAS &&
      target.type !== MessageType.ERASE &&
      target.type !== MessageType.OBJECT_DELETE &&
      objectId &&
      !targetSnapshot
    ) {
      return {
        accepted: false,
        message: 'The target has already been removed or cleared by another action.',
      };
    }

    const removeIds: string[] = [];
    const restoreObjects: WhiteboardObject[] = [];
    if (target.type === MessageType.CLEAR_CANVAS) {
      const snapshot = (this.undoSnapshots.get(targetOpId) ?? {}) as Record<
        string,
        WhiteboardObject
      >;
      this.redoSnapshots.set(targetOpId, snapshot);
      for (const [id, object] of Object.entries(snapshot)) {
        this.objects.set(id, this.cloneSnapshot(object));
        restoreObjects.push(this.cloneSnapshot(object));
      }
    } else if (target.type === MessageType.OBJECT_UPDATE && objectId) {
      // Restore the pre-update object; remember the current one so redo can re-apply it.
      const before = this.undoSnapshots.get(targetOpId) as WhiteboardObject | null | undefined;
      if (!before) return { accepted: false, message: 'No state snapshot is available to undo.' };
      this.redoSnapshots.set(targetOpId, this.cloneSnapshot(this.objects.get(objectId) ?? null));
      this.objects.set(objectId, this.cloneSnapshot(before));
      restoreObjects.push(this.cloneSnapshot(before));
    } else if (target.type === MessageType.ERASE || target.type === MessageType.OBJECT_DELETE) {
      const snapshot = (this.undoSnapshots.get(targetOpId) ?? {}) as Record<
        string,
        WhiteboardObject
      >;
      this.redoSnapshots.set(targetOpId, snapshot);
      for (const [id, object] of Object.entries(snapshot)) {
        if (!this.objects.has(id)) {
          this.objects.set(id, this.cloneSnapshot(object));
          restoreObjects.push(this.cloneSnapshot(object));
        }
      }
    } else if (objectId) {
      const snapshot = this.objects.get(objectId) ?? this.undoSnapshots.get(targetOpId);
      this.redoSnapshots.set(targetOpId, snapshot ?? null);
      this.objects.delete(objectId);
      removeIds.push(objectId);
    } else {
      return { accepted: false, message: 'This operation cannot be undone.' };
    }

    this.userUndoStacks.set(
      userId,
      (this.userUndoStacks.get(userId) ?? []).filter((id) => id !== targetOpId),
    );
    const redoStack = this.userRedoStacks.get(userId) ?? [];
    if (!redoStack.includes(targetOpId)) {
      redoStack.push(targetOpId);
      this.userRedoStacks.set(userId, redoStack);
    }

    const payload = { op_id: opId, target_op_id: targetOpId, removeIds, restoreObjects };
    const seq = this.commit(opId, userId, MessageType.UNDO, payload, Date.now());
    return { accepted: true, seq, payload };
  }

  /**
   * Reapplies the last undone operation for the current user. This restores the object snapshot and
   * re-enables that target op to participate in the normal undo cycle.
   */
  public applyRedo(
    opId: string,
    targetOpId: string,
    userId: string,
  ): {
    accepted: boolean;
    seq?: number;
    message?: string;
    payload?: {
      op_id: string;
      target_op_id: string;
      removeIds: string[];
      restoreObjects: WhiteboardObject[];
    };
  } {
    const redoStack = this.userRedoStacks.get(userId) ?? [];
    if (redoStack[redoStack.length - 1] !== targetOpId) {
      return { accepted: false, message: 'Only the most recently undone operation can be redone.' };
    }

    const target = this.operationsLog.find((op) => op.op_id === targetOpId);
    if (!target || target.userId !== userId) {
      return {
        accepted: false,
        message: 'The redo target is unavailable or belongs to another user.',
      };
    }

    const snapshot = this.redoSnapshots.get(targetOpId);
    if (!snapshot) {
      return { accepted: false, message: 'No state snapshot is available to redo.' };
    }

    const removeIds: string[] = [];
    const restoreObjects: WhiteboardObject[] = [];
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && 'id' in snapshot) {
      const object = snapshot as WhiteboardObject;
      this.objects.set(object.id, this.cloneSnapshot(object));
      restoreObjects.push(this.cloneSnapshot(object));
    } else if (snapshot && typeof snapshot === 'object') {
      const entries = Object.entries(snapshot as Record<string, WhiteboardObject>);
      for (const [id, obj] of entries) {
        if (
          target.type === MessageType.CLEAR_CANVAS ||
          target.type === MessageType.ERASE ||
          target.type === MessageType.OBJECT_DELETE
        ) {
          this.objects.delete(id);
          removeIds.push(id);
        } else {
          this.objects.set(id, this.cloneSnapshot(obj));
          restoreObjects.push(this.cloneSnapshot(obj));
        }
      }
    }

    this.userRedoStacks.set(
      userId,
      (this.userRedoStacks.get(userId) ?? []).filter((id) => id !== targetOpId),
    );
    const undoStack = this.userUndoStacks.get(userId) ?? [];
    if (!undoStack.includes(targetOpId)) {
      undoStack.push(targetOpId);
      this.userUndoStacks.set(userId, undoStack);
    }

    const payload = { op_id: opId, target_op_id: targetOpId, removeIds, restoreObjects };
    const seq = this.commit(opId, userId, MessageType.REDO, payload, Date.now());
    return { accepted: true, seq, payload };
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

  public wasKicked(sessionToken: string | undefined): boolean {
    return sessionToken !== undefined && this.kickedSessionTokens.has(sessionToken);
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

    if (
      assignedRole === Role.HOST &&
      this.participants.size === 0 &&
      this.disconnectedParticipants.size === 0
    ) {
      this.hostUserId = session.userId;
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
    this.awaitingRestoredHost = false;
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

    this.dropPendingUploads(userId);
    if (this.presentation.active && userId === this.hostUserId) {
      // The presenter left: end the presentation so nobody stays locked to a stale view.
      this.presentation = { active: false };
      this.broadcast(
        createEnvelope(MessageType.PRESENTATION, this.presentation, {
          room: this.code,
          user_id: userId,
        }),
        userId,
      );
    }
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

  public kickParticipant(userId: string, reason: string): Participant | null {
    const entry = this.participants.get(userId);
    if (!entry || userId === this.hostUserId) return null;

    for (const [token, mappedUserId] of this.sessionTokenToUserId) {
      if (mappedUserId === userId) {
        this.sessionTokenToUserId.delete(token);
        this.kickedSessionTokens.add(token);
      }
    }
    this.kickedSessionTokens.add(entry.session.sessionId);

    const participant = this.removeParticipant(userId, reason, entry.session);
    if (participant) {
      this.disconnectedParticipants.delete(userId);
      entry.session.destroy(reason);
    }
    return participant;
  }

  /**
   * Retrieves participant details by user ID.
   */
  public getParticipant(userId: string): Participant | undefined {
    return this.participants.get(userId)?.participant;
  }

  public setParticipantRole(userId: string, role: Participant['role']): boolean {
    if (userId === this.hostUserId || role === Role.HOST) return false;
    const entry = this.participants.get(userId);
    if (!entry) return false;
    entry.participant.role = role;
    entry.session.role = role;
    this.notifyChanged();
    return true;
  }

  public renameParticipant(userId: string, username: string): boolean {
    const entry = this.participants.get(userId);
    if (!entry || entry.participant.username === username) return false;
    entry.participant.username = username;
    entry.session.username = username;
    return true;
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
   * Sends a full room snapshot to each participant with that participant's own envelope identity.
   */
  public broadcastSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const [userId, entry] of this.participants.entries()) {
      entry.session.send(
        createEnvelope(MessageType.ROOM_STATE, snapshot, {
          room: this.code,
          user_id: userId,
          seq: this.seq,
        }),
      );
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
      allowNameChanges: this.allowNameChanges,
      presentation: this.presentation,
      createdAt: this.createdAt,
    };
  }
}

/** Checks the file's magic bytes so a client cannot label arbitrary data as an image. */
function matchesImageSignature(bytes: Buffer, mime: ImageObject['mime']): boolean {
  if (mime === 'image/png')
    return bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return (
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  );
}
