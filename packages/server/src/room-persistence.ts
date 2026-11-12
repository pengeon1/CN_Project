/**
 * @fileoverview Atomic JSON persistence for whiteboard rooms.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ChatMessageSchema,
  RemovedParticipantSchema,
  SequencedOperationSchema,
  WhiteboardObjectSchema,
} from '@cn-whiteboard/common';
import { Logger } from './logger.js';
import type { PersistedRoomState, Room } from './room.js';

const SnapshotValueSchema = z.union([
  WhiteboardObjectSchema,
  z.record(WhiteboardObjectSchema),
  z.null(),
]);

const PersistedRoomSchema = z.object({
  schemaVersion: z.literal(1),
  roomCode: z.string().regex(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/),
  roomName: z.string().min(1).max(64),
  createdAt: z.number().int().positive(),
  hostUserId: z.string().uuid(),
  locked: z.boolean(),
  allowNameChanges: z.boolean().optional().default(false),
  defaultViewer: z.boolean().optional().default(false),
  passwordHash: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  baseSeq: z.number().int().nonnegative(),
  objects: z.record(WhiteboardObjectSchema),
  operations: z.array(SequencedOperationSchema),
  chatHistory: z.array(ChatMessageSchema),
  processedOps: z.array(z.tuple([z.string().uuid(), z.number().int().nonnegative()])),
  userUndoStacks: z.record(z.array(z.string().uuid())),
  userRedoStacks: z.record(z.array(z.string().uuid())),
  undoSnapshots: z.record(SnapshotValueSchema),
  redoSnapshots: z.record(SnapshotValueSchema),
  versions: z
    .array(
      z.object({
        id: z.string().uuid(),
        name: z.string(),
        ts: z.number().int().positive(),
        createdBy: z.string().uuid().nullable(),
        auto: z.boolean(),
        objectCount: z.number().int().nonnegative(),
        objects: z.record(WhiteboardObjectSchema),
      }),
    )
    .optional(),
  assets: z
    .record(
      z.object({
        mime: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        data: z.string(),
      }),
    )
    .optional(),
  moderationRecords: z
    .array(
      z.object({
        info: RemovedParticipantSchema,
        tokens: z.array(z.string()),
        ips: z.array(z.string()),
        usernames: z.array(z.string()),
      }),
    )
    .optional(),
});

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/**
 * A validated room payload paired with the persisted file it came from.
 */
export interface SavedRoomFile {
  state: PersistedRoomState;
  filename: string;
}

/**
 * Debounces autosaves, validates room files during recovery, and uses rename for atomic updates.
 */
export class RoomPersistence {
  private readonly dataDir: string;
  private readonly debounceMs: number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly scheduledRooms = new Map<string, Room>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly logger = new Logger('RoomPersistence');

  /**
   * Creates the store for one configured data directory.
   */
  constructor(dataDir: string, debounceMs = 300) {
    this.dataDir = path.resolve(dataDir);
    this.debounceMs = debounceMs;
  }

  /**
   * Schedules a debounced autosave after the room's current serialized work has completed.
   */
  public scheduleSave(room: Room): void {
    const previous = this.timers.get(room.code);
    if (previous) clearTimeout(previous);

    const timer = setTimeout(() => {
      this.timers.delete(room.code);
      this.scheduledRooms.delete(room.code);
      void room
        .enqueue(() => this.writeState(room.getPersistedState()))
        .catch((error: unknown) => {
          this.logger.error(`Autosave failed for room ${room.code}`, error);
        });
    }, this.debounceMs);
    timer.unref();
    this.timers.set(room.code, timer);
    this.scheduledRooms.set(room.code, room);
  }

  /**
   * Immediately persists the latest room state and returns its file metadata.
   */
  public async saveRoom(room: Room): Promise<{ savedAt: number; filename: string }> {
    const pending = this.timers.get(room.code);
    if (pending) {
      clearTimeout(pending);
      this.timers.delete(room.code);
    }
    this.scheduledRooms.delete(room.code);

    const savedAt = Date.now();
    const filename = this.filenameFor(room.code);
    await this.writeState(room.getPersistedState());
    return { savedAt, filename: path.basename(filename) };
  }

  /**
   * Reads and validates all persisted room files before the TCP listener accepts connections.
   */
  public async loadAll(): Promise<SavedRoomFile[]> {
    await fs.mkdir(this.dataDir, { recursive: true });
    const entries = await fs.readdir(this.dataDir, { withFileTypes: true });
    const files = entries
      .filter(
        (entry) =>
          entry.isFile() && /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}\.json$/.test(entry.name),
      )
      .sort((a, b) => a.name.localeCompare(b.name));

    const restored: SavedRoomFile[] = [];
    for (const entry of files) {
      const filename = path.join(this.dataDir, entry.name);
      const contents = await fs.readFile(filename, 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents);
      } catch (error) {
        throw new Error(`Cannot parse persisted room file ${filename}`, { cause: error });
      }

      const result = PersistedRoomSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`Invalid persisted room file ${filename}: ${result.error.message}`);
      }
      if (`${result.data.roomCode}.json` !== entry.name) {
        throw new Error(`Room code does not match persisted filename ${filename}`);
      }
      const state: PersistedRoomState = {
        ...result.data,
        operations: result.data.operations.map((operation) => ({
          ...operation,
          payload: operation.payload,
        })),
      };
      restored.push({ state, filename });
    }
    return restored;
  }

  /**
   * Returns one validated room file, or null when the room has never been saved.
   */
  public async loadRoom(roomCode: string): Promise<SavedRoomFile | null> {
    const filename = this.filenameFor(roomCode);
    let contents: string;
    try {
      contents = await fs.readFile(filename, 'utf8');
    } catch (error) {
      if (hasErrorCode(error, 'ENOENT')) return null;
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`Cannot parse persisted room file ${filename}`, { cause: error });
    }

    const result = PersistedRoomSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(`Invalid persisted room file ${filename}: ${result.error.message}`);
    }
    if (result.data.roomCode !== roomCode) {
      throw new Error(`Room code does not match persisted filename ${filename}`);
    }
    const state: PersistedRoomState = {
      ...result.data,
      operations: result.data.operations.map((operation) => ({
        ...operation,
        payload: operation.payload,
      })),
    };
    return { state, filename };
  }

  /**
   * Writes pending debounced saves and waits for active writes to finish during shutdown.
   */
  public async flush(): Promise<void> {
    const pendingRooms = Array.from(this.timers.keys());
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();

    const saves = pendingRooms.map((roomCode) => {
      const room = this.scheduledRooms.get(roomCode);
      return room
        ? room.enqueue(() => this.writeState(room.getPersistedState()))
        : Promise.resolve();
    });
    this.scheduledRooms.clear();
    await Promise.all(saves);
    await Promise.all(this.writeQueues.values());
  }

  private filenameFor(roomCode: string): string {
    if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/.test(roomCode)) {
      throw new Error(`Invalid room code for persistence: ${roomCode}`);
    }
    return path.join(this.dataDir, `${roomCode}.json`);
  }

  private async writeState(state: PersistedRoomState): Promise<void> {
    const previous = this.writeQueues.get(state.roomCode) ?? Promise.resolve();
    const write = async () => {
      await fs.mkdir(this.dataDir, { recursive: true });
      const destination = this.filenameFor(state.roomCode);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: 'utf8',
          flag: 'wx',
        });
        await fs.rename(temporary, destination);
      } catch (error) {
        try {
          await fs.unlink(temporary);
        } catch (cleanupError) {
          if (!hasErrorCode(cleanupError, 'ENOENT')) {
            this.logger.warn(`Could not remove temporary file ${temporary}`, cleanupError);
          }
        }
        throw error;
      }
    };

    const queued = previous.then(write, (error: unknown) => {
      this.logger.error(`A previous save failed for room ${state.roomCode}; retrying`, error);
      return write();
    });
    this.writeQueues.set(state.roomCode, queued);
    try {
      await queued;
    } finally {
      if (this.writeQueues.get(state.roomCode) === queued) {
        this.writeQueues.delete(state.roomCode);
      }
    }
  }
}
