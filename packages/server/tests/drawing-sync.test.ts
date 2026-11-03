/**
 * @fileoverview Integration tests for real-time freehand drawing synchronization,
 * concurrent stroke sequencing, cursor broadcasting, and role permission enforcement.
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
  type StrokeBeginPayload,
  type StrokeEndPayload,
  type StrokePointsPayload,
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

describe('Real-time Drawing & Multi-client Synchronization', () => {
  let server: WhiteboardServer;
  let port: number;
  const clients: SocketTestClient[] = [];

  beforeEach(async () => {
    // Port 0 selects an available dynamic port
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

  it('broadcasts full stroke lifecycle (BEGIN, POINTS, END) to all peers in sequence', async () => {
    const host = await SocketTestClient.connect(port);
    const client2 = await SocketTestClient.connect(port);
    const client3 = await SocketTestClient.connect(port);
    clients.push(host, client2, client3);

    await host.authenticate('Alice');
    await client2.authenticate('Bob');
    await client3.authenticate('Charlie');

    // Alice creates room
    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Art Studio', username: 'Alice' },
      { user_id: host.userId },
    );
    const roomState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    // Bob and Charlie join
    client2.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Bob' },
      { user_id: client2.userId, room: roomCode },
    );
    await client2.waitFor(MessageType.ROOM_STATE);

    client3.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Charlie' },
      { user_id: client3.userId, room: roomCode },
    );
    await client3.waitFor(MessageType.ROOM_STATE);

    // Alice draws a stroke
    const strokeId = generateUuid();
    const beginOpId = generateUuid();
    host.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: beginOpId,
        strokeId,
        color: '#10B981',
        width: 4,
        startPoint: { x: 100, y: 150, pressure: 0.5 },
      },
      { user_id: host.userId, room: roomCode },
    );

    // All 3 receive STROKE_BEGIN
    const hostBegin = await host.waitFor(MessageType.STROKE_BEGIN);
    const c2Begin = await client2.waitFor(MessageType.STROKE_BEGIN);
    const c3Begin = await client3.waitFor(MessageType.STROKE_BEGIN);

    expect(hostBegin.seq).toBeGreaterThan(0);
    expect(c2Begin.seq).toBe(hostBegin.seq);
    expect(c3Begin.seq).toBe(hostBegin.seq);
    expect((c2Begin.payload as StrokeBeginPayload).strokeId).toBe(strokeId);
    expect(c2Begin.user_id).toBe(host.userId);

    // Alice sends intermediate batched points
    const pointsOpId = generateUuid();
    host.send(
      MessageType.STROKE_POINTS,
      {
        op_id: pointsOpId,
        strokeId,
        points: [
          { x: 105, y: 155, pressure: 0.55 },
          { x: 110, y: 160, pressure: 0.6 },
        ],
      },
      { user_id: host.userId, room: roomCode },
    );

    const c2Points = await client2.waitFor(MessageType.STROKE_POINTS);
    const c3Points = await client3.waitFor(MessageType.STROKE_POINTS);
    expect(c2Points.seq).toBe(hostBegin.seq + 1);
    expect(c3Points.seq).toBe(c2Points.seq);
    expect((c2Points.payload as StrokePointsPayload).points.length).toBe(2);

    // Alice finalizes stroke
    const endOpId = generateUuid();
    host.send(
      MessageType.STROKE_END,
      {
        op_id: endOpId,
        strokeId,
        finalPoint: { x: 120, y: 170, pressure: 0.5 },
      },
      { user_id: host.userId, room: roomCode },
    );

    const c2End = await client2.waitFor(MessageType.STROKE_END);
    const c3End = await client3.waitFor(MessageType.STROKE_END);
    expect(c2End.seq).toBe(c2Points.seq + 1);
    expect(c3End.seq).toBe(c2End.seq);
    expect((c2End.payload as StrokeEndPayload).finalPoint?.x).toBe(120);

    // A late-joining Client 4 should see the finalized stroke in ROOM_STATE
    const client4 = await SocketTestClient.connect(port);
    clients.push(client4);
    await client4.authenticate('Dave');
    client4.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Dave' },
      { user_id: client4.userId, room: roomCode },
    );
    const c4RoomState = (await client4.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    expect(c4RoomState.objects[strokeId]).toBeDefined();
    const loadedStroke = c4RoomState.objects[strokeId]!;
    expect(loadedStroke.type).toBe('stroke');
    if (loadedStroke.type === 'stroke') {
      expect(loadedStroke.isComplete).toBe(true);
      expect(loadedStroke.points.length).toBe(4); // start + 2 intermediate + final
    }
  });

  it('converges deterministically when 3 clients draw concurrently', async () => {
    const c1 = await SocketTestClient.connect(port);
    const c2 = await SocketTestClient.connect(port);
    const c3 = await SocketTestClient.connect(port);
    clients.push(c1, c2, c3);

    await c1.authenticate('User1');
    await c2.authenticate('User2');
    await c3.authenticate('User3');

    c1.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Concurrent Room', username: 'User1' },
      { user_id: c1.userId },
    );
    const roomState = (await c1.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    c2.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'User2' },
      { user_id: c2.userId, room: roomCode },
    );
    await c2.waitFor(MessageType.ROOM_STATE);

    c3.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'User3' },
      { user_id: c3.userId, room: roomCode },
    );
    await c3.waitFor(MessageType.ROOM_STATE);

    // All three clients begin strokes concurrently
    const stroke1 = generateUuid();
    const stroke2 = generateUuid();
    const stroke3 = generateUuid();

    c1.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: stroke1,
        color: '#EF4444',
        width: 3,
        startPoint: { x: 10, y: 10 },
      },
      { user_id: c1.userId, room: roomCode },
    );
    c2.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: stroke2,
        color: '#3B82F6',
        width: 3,
        startPoint: { x: 50, y: 50 },
      },
      { user_id: c2.userId, room: roomCode },
    );
    c3.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: stroke3,
        color: '#10B981',
        width: 3,
        startPoint: { x: 90, y: 90 },
      },
      { user_id: c3.userId, room: roomCode },
    );

    // Collect 3 STROKE_BEGIN envelopes on c1
    const received1: MessageEnvelope[] = [];
    for (let i = 0; i < 3; i++) {
      received1.push(await c1.waitFor(MessageType.STROKE_BEGIN));
    }

    // Sequence numbers must be strictly ordered (1, 2, 3 or N, N+1, N+2)
    const seqs = received1.map((m) => m.seq);
    expect(seqs[1]).toBe(seqs[0] + 1);
    expect(seqs[2]).toBe(seqs[1] + 1);

    // All 3 strokes must be uniquely represented
    const strokeIds = received1.map((m) => (m.payload as StrokeBeginPayload).strokeId);
    expect(strokeIds).toContain(stroke1);
    expect(strokeIds).toContain(stroke2);
    expect(strokeIds).toContain(stroke3);
  });

  it('broadcasts ephemeral CURSOR_MOVE to peers without echoing to sender', async () => {
    const c1 = await SocketTestClient.connect(port);
    const c2 = await SocketTestClient.connect(port);
    clients.push(c1, c2);

    await c1.authenticate('Alice');
    await c2.authenticate('Bob');

    c1.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Cursor Room', username: 'Alice' },
      { user_id: c1.userId },
    );
    const roomState = (await c1.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    c2.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Bob' },
      { user_id: c2.userId, room: roomCode },
    );
    await c2.waitFor(MessageType.ROOM_STATE);

    // Alice moves cursor
    c1.send(
      MessageType.CURSOR_MOVE,
      { x: 340.5, y: 210.5, activeTool: 'pen', pressure: 0.7 },
      { user_id: c1.userId, room: roomCode },
    );

    // Bob receives CURSOR_MOVE
    const bobCursor = await c2.waitFor(MessageType.CURSOR_MOVE);
    expect(bobCursor.user_id).toBe(c1.userId);
    expect((bobCursor.payload as { x: number; y: number }).x).toBe(340.5);
    expect((bobCursor.payload as { x: number; y: number }).y).toBe(210.5);

    // Alice does NOT receive her own cursor
    const aliceEcho = c1.queue.find((m) => m.type === MessageType.CURSOR_MOVE);
    expect(aliceEcho).toBeUndefined();
  });

  it('rejects drawing mutations from participants with VIEWER role', async () => {
    const host = await SocketTestClient.connect(port);
    const viewer = await SocketTestClient.connect(port);
    clients.push(host, viewer);

    await host.authenticate('HostUser');
    await viewer.authenticate('ViewerUser');

    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Restricted Board', username: 'HostUser' },
      { user_id: host.userId },
    );
    const roomState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    viewer.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'ViewerUser' },
      { user_id: viewer.userId, room: roomCode },
    );
    await viewer.waitFor(MessageType.ROOM_STATE);

    // Demote viewer to VIEWER role
    const room = server.roomManager.getRoom(roomCode)!;
    const viewerSession = room.getSession(viewer.userId)!;
    viewerSession.role = Role.VIEWER;

    // Viewer attempts to draw
    viewer.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: generateUuid(),
        color: '#FF0000',
        width: 2,
        startPoint: { x: 50, y: 50 },
      },
      { user_id: viewer.userId, room: roomCode },
    );

    const errorMsg = await viewer.waitFor(MessageType.ERROR);
    expect((errorMsg.payload as { code: string }).code).toBe('FORBIDDEN');
  });

  it('guarantees idempotency when an op_id is retried', async () => {
    const host = await SocketTestClient.connect(port);
    clients.push(host);

    await host.authenticate('Alice');
    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Idempotency Room', username: 'Alice' },
      { user_id: host.userId },
    );
    const roomState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    const opId = generateUuid();
    const strokeId = generateUuid();

    // First attempt
    host.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: opId,
        strokeId,
        color: '#3B82F6',
        width: 4,
        startPoint: { x: 20, y: 20 },
      },
      { user_id: host.userId, room: roomCode },
    );

    const firstMsg = await host.waitFor(MessageType.STROKE_BEGIN);
    const initialSeq = firstMsg.seq;

    // Retry with exact same op_id
    const room = server.roomManager.getRoom(roomCode)!;
    const strokeObj = room.applyStrokeBegin(opId, strokeId, host.userId, '#3B82F6', 4, {
      x: 20,
      y: 20,
    });

    // Seq must not have incremented for duplicate op_id
    expect(strokeObj.seq).toBe(initialSeq);
    expect(room.seq).toBe(initialSeq);
  });
});
