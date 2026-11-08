import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as net from 'node:net';
import {
  createEnvelope,
  encodeFrame,
  FrameDecoder,
  type MessageEnvelope,
  MessageType,
  generateUuid,
} from '@cn-whiteboard/common';
import { startServer, type WhiteboardServer } from '../src/index.js';

class SocketTestClient {
  private socket: net.Socket;
  private decoder = new FrameDecoder();
  public queue: MessageEnvelope[] = [];
  private waiters: Array<(msg: MessageEnvelope) => void> = [];

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on('data', (chunk) => {
      const msgs = this.decoder.feed(chunk);
      for (const message of msgs) {
        if (this.waiters.length > 0) {
          const resolve = this.waiters.shift()!;
          resolve(message);
        } else {
          this.queue.push(message);
        }
      }
    });
  }

  public static async connect(port: number): Promise<SocketTestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        resolve(new SocketTestClient(socket));
      });
      socket.on('error', (err) => reject(err));
    });
  }

  public send(
    type: MessageType,
    payload: unknown,
    options?: { room?: string; user_id?: string },
  ): void {
    const envelope = createEnvelope(type, payload, options);
    this.socket.write(encodeFrame(envelope));
  }

  public async waitFor(type: MessageType, timeoutMs = 3000): Promise<MessageEnvelope> {
    const existingIndex = this.queue.findIndex((message) => message.type === type);
    if (existingIndex !== -1) return this.queue.splice(existingIndex, 1)[0]!;

    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const next = await new Promise<MessageEnvelope>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
        this.waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });

      if (next.type === type) return next;
      this.queue.push(next);
    }

    throw new Error(`Timeout waiting for ${type}`);
  }

  public close(): void {
    this.socket.destroy();
  }
}

describe('Undo/redo server semantics', () => {
  let serverInstance: WhiteboardServer | undefined;
  let serverPort = 0;
  const activeClients: SocketTestClient[] = [];

  beforeEach(async () => {
    const { server, port } = await startServer({ host: '127.0.0.1', port: 0 });
    serverInstance = server;
    serverPort = port;
  });

  afterEach(async () => {
    for (const client of activeClients) {
      client.close();
    }
    activeClients.length = 0;
    if (serverInstance) {
      await serverInstance.close();
      serverInstance = undefined;
    }
  });

  it('undoes and redoes a target created by the same user while rejecting other users', async () => {
    const alice = await SocketTestClient.connect(serverPort);
    const bob = await SocketTestClient.connect(serverPort);
    activeClients.push(alice, bob);

    alice.send(MessageType.HELLO, { clientVersion: '0.1.0', suggestedUsername: 'Alice' });
    const aliceAuth = await alice.waitFor(MessageType.AUTH_OK);
    const aliceUserId = (aliceAuth.payload as { userId: string }).userId;

    alice.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Undo Room', username: 'Alice' },
      { user_id: aliceUserId },
    );
    const roomState = await alice.waitFor(MessageType.ROOM_STATE);
    const roomCode = (roomState.payload as { roomCode: string }).roomCode;

    bob.send(MessageType.HELLO, { clientVersion: '0.1.0', suggestedUsername: 'Bob' });
    const bobAuth = await bob.waitFor(MessageType.AUTH_OK);
    const bobUserId = (bobAuth.payload as { userId: string }).userId;

    bob.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Bob' },
      { room: roomCode, user_id: bobUserId },
    );
    await bob.waitFor(MessageType.ROOM_STATE);
    await alice.waitFor(MessageType.PARTICIPANT_JOINED);

    const aliceStrokeId = generateUuid();
    const aliceStrokeOpId = generateUuid();
    alice.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: aliceStrokeOpId,
        strokeId: aliceStrokeId,
        color: '#111111',
        width: 4,
        startPoint: { x: 20, y: 30 },
      },
      { room: roomCode, user_id: aliceUserId },
    );
    await alice.waitFor(MessageType.STROKE_BEGIN);
    await bob.waitFor(MessageType.STROKE_BEGIN);

    const room = serverInstance!.roomManager.getRoom(roomCode)!;
    expect(room.getObject(aliceStrokeId)).toBeDefined();

    const undoOpId = generateUuid();
    alice.send(
      MessageType.UNDO,
      { op_id: undoOpId, target_op_id: aliceStrokeOpId },
      { room: roomCode, user_id: aliceUserId },
    );
    const undoMessage = await alice.waitFor(MessageType.UNDO);
    expect(undoMessage.payload).toMatchObject({
      target_op_id: aliceStrokeOpId,
      removeIds: [aliceStrokeId],
      restoreObjects: [],
    });
    expect(room.getObject(aliceStrokeId)).toBeUndefined();

    const redoOpId = generateUuid();
    alice.send(
      MessageType.REDO,
      { op_id: redoOpId, target_op_id: aliceStrokeOpId },
      { room: roomCode, user_id: aliceUserId },
    );
    const redoMessage = await alice.waitFor(MessageType.REDO);
    expect(redoMessage.payload).toMatchObject({
      target_op_id: aliceStrokeOpId,
      removeIds: [],
      restoreObjects: [{ id: aliceStrokeId }],
    });
    expect(room.getObject(aliceStrokeId)).toBeDefined();

    const bobStrokeId = generateUuid();
    const bobStrokeOpId = generateUuid();
    bob.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: bobStrokeOpId,
        strokeId: bobStrokeId,
        color: '#222222',
        width: 3,
        startPoint: { x: 50, y: 60 },
      },
      { room: roomCode, user_id: bobUserId },
    );
    await bob.waitFor(MessageType.STROKE_BEGIN);

    const crossUserUndo = room.applyUndo(generateUuid(), bobStrokeOpId, aliceUserId);
    expect(crossUserUndo).toMatchObject({
      accepted: false,
      message: 'Only the most recent operation can be undone.',
    });
    expect(room.getObject(bobStrokeId)).toBeDefined();

    const eraseOpId = generateUuid();
    room.eraseObjects(eraseOpId, [aliceStrokeId], aliceUserId);
    expect(room.getObject(aliceStrokeId)).toBeUndefined();
    const undoErase = room.applyUndo(generateUuid(), eraseOpId, aliceUserId);
    expect(undoErase.payload?.restoreObjects.map((object) => object.id)).toContain(aliceStrokeId);
    expect(room.getObject(aliceStrokeId)).toBeDefined();
    const redoErase = room.applyRedo(generateUuid(), eraseOpId, aliceUserId);
    expect(redoErase.payload?.removeIds).toContain(aliceStrokeId);
    expect(room.getObject(aliceStrokeId)).toBeUndefined();

    const clearOpId = generateUuid();
    room.clearCanvas(clearOpId, aliceUserId);
    expect(room.getObject(bobStrokeId)).toBeUndefined();
    const undoClear = room.applyUndo(generateUuid(), clearOpId, aliceUserId);
    expect(undoClear.payload?.restoreObjects.map((object) => object.id)).toEqual([bobStrokeId]);
    expect(room.getObject(bobStrokeId)).toBeDefined();
    const redoClear = room.applyRedo(generateUuid(), clearOpId, aliceUserId);
    expect(redoClear.payload?.removeIds).toEqual([bobStrokeId]);
    expect(room.getObject(bobStrokeId)).toBeUndefined();
  });
});
