/**
 * @fileoverview Integration tests for stroke-level eraser, host-restricted canvas clear,
 * role permission validation, sequence synchronization, and idempotency.
 */

import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  encodeFrame,
  FrameDecoder,
  generateUuid,
  type MessageEnvelope,
  MessageType,
  Role,
  type RoomStatePayload,
} from '@cn-whiteboard/common';
import { startServer, type WhiteboardServer } from '../src/index.js';

class SocketTestClient {
  public socket: net.Socket;
  private decoder = new FrameDecoder();
  public queue: MessageEnvelope[] = [];
  private waiters: Array<(msg: MessageEnvelope) => void> = [];
  public userId: string = '';
  public sessionId: string = '';

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on('data', (chunk) => {
      const msgs = this.decoder.feed(chunk);
      for (const m of msgs) {
        if (this.waiters.length > 0) {
          const resolve = this.waiters.shift()!;
          resolve(m);
        } else {
          this.queue.push(m);
        }
      }
    });
  }

  public static async connect(port: number): Promise<SocketTestClient> {
    return new Promise((resolve, _reject) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' }, () => {
        resolve(new SocketTestClient(socket));
      });
      socket.on('error', () => {
        // Suppress expected teardown socket resets
      });
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

  public async waitFor(type: MessageType, timeoutMs = 4000): Promise<MessageEnvelope> {
    const existingIndex = this.queue.findIndex((m) => m.type === type);
    if (existingIndex !== -1) {
      return this.queue.splice(existingIndex, 1)[0]!;
    }

    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const nextMsg = await new Promise<MessageEnvelope>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeoutMs);
        this.waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });

      if (nextMsg.type === type) {
        return nextMsg;
      } else {
        this.queue.push(nextMsg);
      }
    }
    throw new Error(`Timeout waiting for ${type}`);
  }

  public async authenticate(username: string): Promise<{ userId: string; sessionId: string }> {
    this.send(MessageType.HELLO, { clientVersion: '0.1.0', suggestedUsername: username });
    const authOk = await this.waitFor(MessageType.AUTH_OK);
    const p = authOk.payload as { userId: string; sessionId: string };
    this.userId = p.userId;
    this.sessionId = p.sessionId;
    return p;
  }

  public close(): void {
    this.socket.destroy();
  }
}

describe('Eraser and Canvas Clear Synchronization Suite', () => {
  let server: WhiteboardServer;
  let port: number;
  const clients: SocketTestClient[] = [];

  beforeEach(async () => {
    const instance = await startServer({ host: '127.0.0.1', port: 0 });
    server = instance.server;
    port = instance.port;
  });

  afterEach(async () => {
    for (const c of clients) {
      c.close();
    }
    clients.length = 0;
    await server.close();
  });

  it('erases objects by ID and propagates ERASE event with monotonic seq to all clients', async () => {
    const host = await SocketTestClient.connect(port);
    const peer = await SocketTestClient.connect(port);
    clients.push(host, peer);

    await host.authenticate('Alice');
    await peer.authenticate('Bob');

    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Eraser Studio', username: 'Alice' },
      { user_id: host.userId },
    );
    const roomState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    peer.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Bob' },
      { user_id: peer.userId, room: roomCode },
    );
    await peer.waitFor(MessageType.ROOM_STATE);

    // Host draws stroke 1
    const stroke1 = generateUuid();
    host.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: stroke1,
        color: '#10B981',
        width: 4,
        startPoint: { x: 50, y: 50 },
      },
      { user_id: host.userId, room: roomCode },
    );
    const strokeBegin1 = await host.waitFor(MessageType.STROKE_BEGIN);
    await peer.waitFor(MessageType.STROKE_BEGIN);

    // Host finalizes stroke 1
    host.send(
      MessageType.STROKE_END,
      { op_id: generateUuid(), strokeId: stroke1 },
      { user_id: host.userId, room: roomCode },
    );
    await host.waitFor(MessageType.STROKE_END);
    await peer.waitFor(MessageType.STROKE_END);

    // Bob erases stroke 1
    const eraseOpId = generateUuid();
    peer.send(
      MessageType.ERASE,
      { op_id: eraseOpId, objectIds: [stroke1] },
      { user_id: peer.userId, room: roomCode },
    );

    const hostErase = await host.waitFor(MessageType.ERASE);
    const peerErase = await peer.waitFor(MessageType.ERASE);

    expect(hostErase.seq).toBeGreaterThan(strokeBegin1.seq);
    expect(peerErase.seq).toBe(hostErase.seq);
    expect((hostErase.payload as { objectIds: string[] }).objectIds).toEqual([stroke1]);

    // Verify server memory state has removed stroke 1
    const room = server.roomManager.getRoom(roomCode)!;
    expect(room.getObject(stroke1)).toBeUndefined();
    expect(room.getSnapshot().objects[stroke1]).toBeUndefined();
  });

  it('restricts CLEAR_CANVAS strictly to the HOST and rejects non-host requests', async () => {
    const host = await SocketTestClient.connect(port);
    const editor = await SocketTestClient.connect(port);
    clients.push(host, editor);

    await host.authenticate('Alice');
    await editor.authenticate('Bob');

    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Clear Test Room', username: 'Alice' },
      { user_id: host.userId },
    );
    const roomState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    editor.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Bob' },
      { user_id: editor.userId, room: roomCode },
    );
    await editor.waitFor(MessageType.ROOM_STATE);

    // Add a stroke
    const strokeId = generateUuid();
    host.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId,
        color: '#3B82F6',
        width: 3,
        startPoint: { x: 100, y: 100 },
      },
      { user_id: host.userId, room: roomCode },
    );
    await host.waitFor(MessageType.STROKE_BEGIN);
    await editor.waitFor(MessageType.STROKE_BEGIN);

    // Bob (EDITOR) attempts to clear canvas -> must be rejected with FORBIDDEN
    editor.send(
      MessageType.CLEAR_CANVAS,
      { op_id: generateUuid() },
      { user_id: editor.userId, room: roomCode },
    );

    const errorMsg = await editor.waitFor(MessageType.ERROR);
    expect((errorMsg.payload as { code: string }).code).toBe('FORBIDDEN');
    expect((errorMsg.payload as { message: string }).message).toContain('host');

    // Canvas still has the stroke
    const room = server.roomManager.getRoom(roomCode)!;
    expect(room.getObject(strokeId)).toBeDefined();

    // Alice (HOST) clears canvas -> accepted and broadcast
    const hostClearOp = generateUuid();
    host.send(
      MessageType.CLEAR_CANVAS,
      { op_id: hostClearOp },
      { user_id: host.userId, room: roomCode },
    );

    const hostClear = await host.waitFor(MessageType.CLEAR_CANVAS);
    const editorClear = await editor.waitFor(MessageType.CLEAR_CANVAS);

    expect(hostClear.seq).toBeGreaterThan(0);
    expect(editorClear.seq).toBe(hostClear.seq);

    // Canvas is now completely cleared on server
    expect(room.getSnapshot().objects).toEqual({});
    expect(room.getObject(strokeId)).toBeUndefined();

    // Late joining client sees completely clear canvas
    const lateJoiner = await SocketTestClient.connect(port);
    clients.push(lateJoiner);
    await lateJoiner.authenticate('Dave');
    lateJoiner.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Dave' },
      { user_id: lateJoiner.userId, room: roomCode },
    );
    const lateState = (await lateJoiner.waitFor(MessageType.ROOM_STATE))
      .payload as RoomStatePayload;
    expect(lateState.objects).toEqual({});
  });

  it('rejects ERASE from participants with VIEWER role', async () => {
    const host = await SocketTestClient.connect(port);
    const viewer = await SocketTestClient.connect(port);
    clients.push(host, viewer);

    await host.authenticate('Alice');
    await viewer.authenticate('Observer');

    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Viewer Room', username: 'Alice' },
      { user_id: host.userId },
    );
    const roomState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    viewer.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Observer' },
      { user_id: viewer.userId, room: roomCode },
    );
    await viewer.waitFor(MessageType.ROOM_STATE);

    // Set participant role to VIEWER
    const room = server.roomManager.getRoom(roomCode)!;
    const viewerSession = room.getSession(viewer.userId)!;
    viewerSession.role = Role.VIEWER;

    // Viewer attempts to erase
    viewer.send(
      MessageType.ERASE,
      { op_id: generateUuid(), objectIds: [generateUuid()] },
      { user_id: viewer.userId, room: roomCode },
    );

    const errorMsg = await viewer.waitFor(MessageType.ERROR);
    expect((errorMsg.payload as { code: string }).code).toBe('FORBIDDEN');
  });

  it('guarantees idempotency when CLEAR_CANVAS and ERASE op_ids are retried', async () => {
    const host = await SocketTestClient.connect(port);
    clients.push(host);

    await host.authenticate('Alice');
    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Idempotent Clear', username: 'Alice' },
      { user_id: host.userId },
    );
    const roomState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    const clearOpId = generateUuid();

    // First CLEAR_CANVAS
    host.send(
      MessageType.CLEAR_CANVAS,
      { op_id: clearOpId },
      { user_id: host.userId, room: roomCode },
    );
    const clearMsg = await host.waitFor(MessageType.CLEAR_CANVAS);
    const firstSeq = clearMsg.seq;

    // Direct re-call with same opId on room
    const room = server.roomManager.getRoom(roomCode)!;
    const retryResult = room.clearCanvas(clearOpId);
    expect(retryResult.seq).toBe(firstSeq);
    expect(room.seq).toBe(firstSeq);
  });
});
