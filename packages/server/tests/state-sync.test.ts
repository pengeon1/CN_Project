/**
 * @fileoverview Integration tests for Phase 6: Late-join state sync,
 * server-side whiteboard model (ordered ops log + materialized object map),
 * ROOM_STATE snapshot delivery on join, periodic log compaction, and
 * RESYNC_REQUEST / RESYNC_RESPONSE incremental catch-up.
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
  type ResyncResponsePayload,
  type RoomStatePayload,
  type StrokeObject,
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
        // Suppress expected teardown resets
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

describe('Late-Join State Synchronization Suite (Phase 6)', () => {
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

  it('delivers complete current whiteboard snapshot immediately to a client joining mid-session', async () => {
    const host = await SocketTestClient.connect(port);
    clients.push(host);
    await host.authenticate('Alice');

    // 1. Host creates a whiteboard session
    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'State Sync Room', username: 'Alice' },
      { user_id: host.userId },
    );
    const hostState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = hostState.roomCode;

    // 2. Host draws Stroke 1 (complete)
    const stroke1Id = generateUuid();
    host.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: stroke1Id,
        color: '#10B981',
        width: 4,
        startPoint: { x: 10, y: 20 },
      },
      { user_id: host.userId, room: roomCode },
    );
    await host.waitFor(MessageType.STROKE_BEGIN);

    host.send(
      MessageType.STROKE_POINTS,
      {
        op_id: generateUuid(),
        strokeId: stroke1Id,
        points: [
          { x: 15, y: 25 },
          { x: 20, y: 30 },
        ],
      },
      { user_id: host.userId, room: roomCode },
    );
    await host.waitFor(MessageType.STROKE_POINTS);

    host.send(
      MessageType.STROKE_END,
      {
        op_id: generateUuid(),
        strokeId: stroke1Id,
        finalPoint: { x: 25, y: 35 },
      },
      { user_id: host.userId, room: roomCode },
    );
    await host.waitFor(MessageType.STROKE_END);

    // 3. Host draws Stroke 2 (to be erased)
    const stroke2Id = generateUuid();
    host.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: stroke2Id,
        color: '#EF4444',
        width: 2,
        startPoint: { x: 100, y: 100 },
      },
      { user_id: host.userId, room: roomCode },
    );
    await host.waitFor(MessageType.STROKE_BEGIN);

    host.send(
      MessageType.STROKE_END,
      { op_id: generateUuid(), strokeId: stroke2Id },
      { user_id: host.userId, room: roomCode },
    );
    await host.waitFor(MessageType.STROKE_END);

    // 4. Host draws Stroke 3 (in-progress, not yet finalized)
    const stroke3Id = generateUuid();
    host.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: stroke3Id,
        color: '#3B82F6',
        width: 6,
        startPoint: { x: 200, y: 200 },
      },
      { user_id: host.userId, room: roomCode },
    );
    await host.waitFor(MessageType.STROKE_BEGIN);

    // 5. Host erases Stroke 2
    host.send(
      MessageType.ERASE,
      { op_id: generateUuid(), objectIds: [stroke2Id] },
      { user_id: host.userId, room: roomCode },
    );
    const eraseMsg = await host.waitFor(MessageType.ERASE);

    // 6. Late-joining client (Bob) connects and joins the room
    const bob = await SocketTestClient.connect(port);
    clients.push(bob);
    await bob.authenticate('Bob');

    bob.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Bob' },
      { user_id: bob.userId, room: roomCode },
    );

    const bobStateEnvelope = await bob.waitFor(MessageType.ROOM_STATE);
    const bobSnapshot = bobStateEnvelope.payload as RoomStatePayload;

    // Verify Bob sees:
    // - Exact room metadata (seq includes Bob's PARTICIPANT_JOINED event)
    expect(bobSnapshot.roomCode).toBe(roomCode);
    expect(bobSnapshot.roomName).toBe('State Sync Room');
    expect(bobSnapshot.seq).toBe(eraseMsg.seq + 1);

    // - Materialized objects: stroke 1 and stroke 3 are present, stroke 2 is erased
    expect(bobSnapshot.objects[stroke1Id]).toBeDefined();
    const s1 = bobSnapshot.objects[stroke1Id] as StrokeObject;
    expect(s1.points.length).toBe(4);
    expect(s1.isComplete).toBe(true);
    expect(s1.color).toBe('#10B981');

    expect(bobSnapshot.objects[stroke3Id]).toBeDefined();
    const s3 = bobSnapshot.objects[stroke3Id] as StrokeObject;
    expect(s3.isComplete).toBe(false);

    expect(bobSnapshot.objects[stroke2Id]).toBeUndefined();

    // - Both Alice and Bob are in participants list
    expect(bobSnapshot.participants.length).toBe(2);
    expect(bobSnapshot.participants.some((p) => p.username === 'Alice')).toBe(true);
    expect(bobSnapshot.participants.some((p) => p.username === 'Bob')).toBe(true);
  });

  it('synchronizes multiple clients joining at successive stages including after canvas clear', async () => {
    const host = await SocketTestClient.connect(port);
    clients.push(host);
    await host.authenticate('Host');

    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Multi-Stage Sync', username: 'Host' },
      { user_id: host.userId },
    );
    const hostState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = hostState.roomCode;

    // Stage 1: Host draws stroke A
    const strokeA = generateUuid();
    host.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: strokeA,
        color: '#18A0FB',
        width: 3,
        startPoint: { x: 30, y: 30 },
      },
      { user_id: host.userId, room: roomCode },
    );
    await host.waitFor(MessageType.STROKE_BEGIN);

    // Client 1 joins at Stage 1
    const peer1 = await SocketTestClient.connect(port);
    clients.push(peer1);
    await peer1.authenticate('Peer1');
    peer1.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Peer1' },
      { user_id: peer1.userId, room: roomCode },
    );
    const state1 = (await peer1.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    expect(state1.objects[strokeA]).toBeDefined();

    // Stage 2: Peer1 draws stroke B
    const strokeB = generateUuid();
    peer1.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: strokeB,
        color: '#F59E0B',
        width: 5,
        startPoint: { x: 60, y: 60 },
      },
      { user_id: peer1.userId, room: roomCode },
    );
    await host.waitFor(MessageType.STROKE_BEGIN);
    await peer1.waitFor(MessageType.STROKE_BEGIN);

    // Client 2 joins at Stage 2 -> must see BOTH stroke A and stroke B
    const peer2 = await SocketTestClient.connect(port);
    clients.push(peer2);
    await peer2.authenticate('Peer2');
    peer2.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Peer2' },
      { user_id: peer2.userId, room: roomCode },
    );
    const state2 = (await peer2.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    expect(state2.objects[strokeA]).toBeDefined();
    expect(state2.objects[strokeB]).toBeDefined();

    // Stage 3: Host clears canvas
    host.send(
      MessageType.CLEAR_CANVAS,
      { op_id: generateUuid() },
      { user_id: host.userId, room: roomCode },
    );
    await host.waitFor(MessageType.CLEAR_CANVAS);
    await peer1.waitFor(MessageType.CLEAR_CANVAS);
    await peer2.waitFor(MessageType.CLEAR_CANVAS);

    // Client 3 joins at Stage 3 -> must see clean canvas with empty objects
    const peer3 = await SocketTestClient.connect(port);
    clients.push(peer3);
    await peer3.authenticate('Peer3');
    peer3.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Peer3' },
      { user_id: peer3.userId, room: roomCode },
    );
    const state3 = (await peer3.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    expect(state3.objects).toEqual({});
    expect(state3.seq).toBeGreaterThan(state2.seq);
  });

  it('handles incremental RESYNC_REQUEST for clients with a small sequence gap', async () => {
    const host = await SocketTestClient.connect(port);
    const peer = await SocketTestClient.connect(port);
    clients.push(host, peer);

    await host.authenticate('Alice');
    await peer.authenticate('Bob');

    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Resync Room', username: 'Alice' },
      { user_id: host.userId },
    );
    const roomState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    peer.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Bob' },
      { user_id: peer.userId, room: roomCode },
    );
    const peerJoinState = (await peer.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const initialSeq = peerJoinState.seq;

    // Host executes 3 sequenced operations while peer does not actively track them
    const stroke1 = generateUuid();
    host.send(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: stroke1,
        color: '#10B981',
        width: 3,
        startPoint: { x: 10, y: 10 },
      },
      { user_id: host.userId, room: roomCode },
    );
    const s1 = await host.waitFor(MessageType.STROKE_BEGIN);

    host.send(
      MessageType.STROKE_POINTS,
      {
        op_id: generateUuid(),
        strokeId: stroke1,
        points: [{ x: 20, y: 20 }],
      },
      { user_id: host.userId, room: roomCode },
    );
    const s2 = await host.waitFor(MessageType.STROKE_POINTS);

    host.send(
      MessageType.STROKE_END,
      { op_id: generateUuid(), strokeId: stroke1 },
      { user_id: host.userId, room: roomCode },
    );
    const s3 = await host.waitFor(MessageType.STROKE_END);

    // Consume peer's incoming queue to simulate catch-up request
    peer.queue.length = 0;

    // Peer requests resync from initialSeq
    peer.send(
      MessageType.RESYNC_REQUEST,
      { last_seq: initialSeq },
      { user_id: peer.userId, room: roomCode },
    );

    const resyncEnvelope = await peer.waitFor(MessageType.RESYNC_RESPONSE);
    const resyncPayload = resyncEnvelope.payload as ResyncResponsePayload;

    expect(resyncPayload.from_seq).toBe(initialSeq + 1);
    expect(resyncPayload.to_seq).toBe(s3.seq);
    expect(resyncPayload.operations).toBeDefined();
    expect(resyncPayload.operations!.length).toBe(3);

    expect(resyncPayload.operations![0]!.seq).toBe(s1.seq);
    expect(resyncPayload.operations![0]!.type).toBe(MessageType.STROKE_BEGIN);
    expect(resyncPayload.operations![1]!.seq).toBe(s2.seq);
    expect(resyncPayload.operations![1]!.type).toBe(MessageType.STROKE_POINTS);
    expect(resyncPayload.operations![2]!.seq).toBe(s3.seq);
    expect(resyncPayload.operations![2]!.type).toBe(MessageType.STROKE_END);
  });

  it('falls back to full snapshot when client gap exceeds MAX_RESYNC_OPS_WINDOW or compaction boundary', async () => {
    const host = await SocketTestClient.connect(port);
    clients.push(host);
    await host.authenticate('Alice');

    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Large Gap Room', username: 'Alice' },
      { user_id: host.userId },
    );
    const roomState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = roomState.roomCode;

    // Directly access room model on the server to test compaction boundary and large gap
    const room = server.roomManager.getRoom(roomCode)!;

    // Artificially simulate 505 operations to exceed MAX_RESYNC_OPS_WINDOW (500)
    for (let i = 0; i < 505; i++) {
      const strokeId = generateUuid();
      room.applyStrokeBegin(generateUuid(), strokeId, host.userId, '#000000', 2, { x: i, y: i });
    }
    expect(room.seq).toBeGreaterThan(500);

    // Client requests resync from seq = 0 (gap > 500)
    const client = await SocketTestClient.connect(port);
    clients.push(client);
    await client.authenticate('LateClient');

    client.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'LateClient' },
      { user_id: client.userId, room: roomCode },
    );
    await client.waitFor(MessageType.ROOM_STATE);

    client.send(
      MessageType.RESYNC_REQUEST,
      { last_seq: 0 },
      { user_id: client.userId, room: roomCode },
    );

    const resyncEnv = await client.waitFor(MessageType.RESYNC_RESPONSE);
    const resyncPayload = resyncEnv.payload as ResyncResponsePayload;

    // Server must supply fullSnapshot instead of incremental array
    expect(resyncPayload.fullSnapshot).toBeDefined();
    expect(resyncPayload.fullSnapshot!.roomCode).toBe(roomCode);
    expect(resyncPayload.fullSnapshot!.seq).toBe(room.seq);
    expect(Object.keys(resyncPayload.fullSnapshot!.objects).length).toBe(505);
  });

  it('performs log compaction correctly without losing active whiteboard objects', async () => {
    const host = await SocketTestClient.connect(port);
    clients.push(host);
    await host.authenticate('Admin');

    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Compaction Room', username: 'Admin' },
      { user_id: host.userId },
    );
    const roomState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const room = server.roomManager.getRoom(roomState.roomCode)!;

    // Configure small threshold for compaction testing
    room.maxOpsLogSize = 20;
    room.compactRetainOps = 10;

    // Apply 25 operations
    const strokeIds: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = generateUuid();
      strokeIds.push(id);
      room.applyStrokeBegin(generateUuid(), id, host.userId, '#3B82F6', 3, { x: i * 2, y: i * 2 });
    }

    // Auto-compaction should have triggered when ops reached 21, retaining 10 ops
    expect(room.operationsCount).toBeLessThanOrEqual(15);
    expect(room.baseSeq).toBeGreaterThan(0);
    expect(room.oldestSeq).toBeGreaterThan(1);

    // Materialized object map must retain all 25 strokes intact
    expect(Object.keys(room.getSnapshot().objects).length).toBe(25);
    for (const id of strokeIds) {
      expect(room.getObject(id)).toBeDefined();
    }

    // Requesting resync for an already pruned seq should automatically return fullSnapshot
    const resync = room.getResyncData(1);
    expect(resync.fullSnapshot).toBeDefined();
    expect(resync.operations).toBeUndefined();

    // Requesting resync for a seq within the retained window returns incremental ops
    const retainedSeq = room.oldestSeq + 1;
    const retainedResync = room.getResyncData(retainedSeq);
    expect(retainedResync.operations).toBeDefined();
    expect(retainedResync.fullSnapshot).toBeUndefined();
    expect(retainedResync.from_seq).toBe(retainedSeq + 1);
  });
});
