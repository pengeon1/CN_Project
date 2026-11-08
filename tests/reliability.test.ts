/**
 * @fileoverview End-to-end reliability tests (Phase 8).
 *
 * Real server, real client networking code (MainTcpClient), real TCP — with a LossyProxy in
 * between that delays, duplicates, reorders and drops frames, and cuts connections.
 *
 * Every client feeds the events it is handed into a TestBoard. The board *asserts* the delivery
 * guarantee the UI relies on: each sequenced event arrives exactly once and in strict seq order.
 * At the end, every board must hold exactly the canvas the server holds.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  generateUuid,
  isSequencedType,
  type MessageEnvelope,
  MessageType,
  type Participant,
  type Point,
  type ResyncResponsePayload,
  Role,
  type RoomSnapshot,
  type RoomStatePayload,
  type StrokeObject,
  type WhiteboardObject,
} from '@cn-whiteboard/common';
import { startServer, type WhiteboardServer } from '../packages/server/src/index.js';
import {
  MainTcpClient,
  type TcpClientSink,
  type TcpClientTimings,
} from '../packages/client/electron/tcp-client.js';
import { applySequencedOpToObjects } from '../packages/client/src/store/useWhiteboardStore.js';
import type { ConnectionStatusEvent } from '../packages/client/src/types/ipc.js';
import { LossyProxy } from './lossy-proxy.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await sleep(10);
  }
}

const CLIENT_TIMINGS: Partial<TcpClientTimings> = {
  heartbeatIntervalMs: 100,
  heartbeatTimeoutMs: 3000,
  reconnectBaseMs: 30,
  reconnectMaxMs: 150,
  gapWaitMs: 50,
  resyncTimeoutMs: 500,
  connectTimeoutMs: 3000,
};

/**
 * Stands in for the renderer: applies what the client delivers and checks the delivery contract.
 */
class TestBoard {
  public objects: Record<string, WhiteboardObject> = {};
  public participants: Map<string, Participant> = new Map();
  public chatIds: Set<string> = new Set();
  public events: MessageEnvelope[] = [];
  public statuses: ConnectionStatusEvent[] = [];
  /** Any delivery that was not exactly "the next seq". Must stay empty. */
  public violations: string[] = [];
  public lastSeq = 0;
  public roomCode = '';
  public userId = '';

  public readonly sink: TcpClientSink = {
    status: (event) => {
      this.statuses.push(event);
    },
    message: (envelope) => {
      this.apply(envelope);
    },
  };

  public connectedCount(): number {
    return this.statuses.filter((s) => s.status === 'connected').length;
  }

  public eventsOfType(type: MessageType): MessageEnvelope[] {
    return this.events.filter((e) => e.type === type);
  }

  private adopt(snapshot: RoomSnapshot): void {
    this.objects = structuredClone(snapshot.objects);
    this.participants = new Map(snapshot.participants.map((p) => [p.id, { ...p }]));
    this.chatIds = new Set(snapshot.chatHistory.map((m) => m.id));
    this.lastSeq = snapshot.seq;
  }

  private apply(envelope: MessageEnvelope): void {
    if (envelope.type === MessageType.ROOM_STATE) {
      const snapshot = envelope.payload as RoomStatePayload;
      this.roomCode = snapshot.roomCode;
      this.userId = envelope.user_id;
      this.adopt(snapshot);
      return;
    }
    if (envelope.type === MessageType.RESYNC_RESPONSE) {
      const payload = envelope.payload as ResyncResponsePayload;
      if (payload.fullSnapshot) this.adopt(payload.fullSnapshot);
      return;
    }
    if (envelope.seq <= 0 || !isSequencedType(envelope.type)) return;

    if (envelope.seq !== this.lastSeq + 1) {
      this.violations.push(
        `expected seq ${this.lastSeq + 1}, got ${envelope.seq} (${envelope.type})`,
      );
    }
    this.lastSeq = envelope.seq;
    this.events.push(envelope);

    switch (envelope.type) {
      case MessageType.STROKE_BEGIN:
      case MessageType.STROKE_POINTS:
      case MessageType.STROKE_END:
      case MessageType.ERASE:
      case MessageType.CLEAR_CANVAS:
        applySequencedOpToObjects(this.objects, {
          op_id: envelope.msg_id,
          seq: envelope.seq,
          userId: envelope.user_id,
          type: envelope.type,
          payload: envelope.payload,
          ts: envelope.ts,
        });
        break;
      case MessageType.PARTICIPANT_JOINED: {
        const { participant } = envelope.payload as { participant: Participant };
        this.participants.set(participant.id, participant);
        break;
      }
      case MessageType.PARTICIPANT_LEFT:
        this.participants.delete((envelope.payload as { userId: string }).userId);
        break;
      case MessageType.PERMISSION_CHANGE: {
        const p = envelope.payload as { targetUserId: string; newRole?: Role };
        const target = this.participants.get(p.targetUserId);
        if (target && p.newRole) target.role = p.newRole;
        break;
      }
      case MessageType.CHAT_MESSAGE:
        this.chatIds.add((envelope.payload as { id: string }).id);
        break;
      default:
        break;
    }
  }
}

/** A stable description of the strokes on a canvas, independent of bookkeeping fields. */
function fingerprint(objects: Record<string, WhiteboardObject>): string {
  const strokes = Object.values(objects).filter((o): o is StrokeObject => o.type === 'stroke');
  strokes.sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(
    strokes.map((s) => ({
      id: s.id,
      author: s.authorId,
      color: s.color,
      width: s.width,
      points: s.points,
      complete: s.isComplete,
    })),
  );
}

interface Peer {
  name: string;
  client: MainTcpClient;
  board: TestBoard;
  chatIds: string[];
}

interface StrokeSpec {
  strokeId: string;
  points: Point[];
}

describe('Reliability end-to-end through a lossy network (Phase 8)', () => {
  let server: WhiteboardServer;
  const proxies: LossyProxy[] = [];
  const peers: Peer[] = [];

  async function startRig(): Promise<{ port: number }> {
    const instance = await startServer({
      host: '127.0.0.1',
      port: 0,
      heartbeatIntervalMs: 100,
      heartbeatTimeoutMs: 3000,
    });
    server = instance.server;
    return { port: instance.port };
  }

  async function startProxy(serverPort: number, seed?: number): Promise<LossyProxy> {
    const proxy = await LossyProxy.start({ host: '127.0.0.1', port: serverPort }, seed);
    proxies.push(proxy);
    return proxy;
  }

  async function connectPeer(
    name: string,
    via: LossyProxy,
    action: 'create' | 'join',
    roomCode?: string,
  ): Promise<Peer> {
    const board = new TestBoard();
    const client = new MainTcpClient(board.sink, CLIENT_TIMINGS);
    const peer: Peer = { name, client, board, chatIds: [] };
    peers.push(peer);

    const result = await client.connect({
      host: '127.0.0.1',
      port: via.port,
      username: name,
      action,
      roomName: 'Lossy Room',
      roomCode,
    });
    if (!result.success) throw new Error(`${name} failed to connect: ${result.error}`);
    return peer;
  }

  function sendChat(peer: Peer, roomCode: string, text: string): void {
    const id = generateUuid();
    peer.chatIds.push(id);
    peer.client.send(
      createEnvelope(
        MessageType.CHAT_MESSAGE,
        { id, text },
        { room: roomCode, user_id: peer.board.userId },
      ),
    );
  }

  /**
   * Draws a stroke the way the UI does: BEGIN, several POINTS batches, END.
   * Returns the exact points the server must end up with.
   */
  async function drawStroke(
    peer: Peer,
    roomCode: string,
    strokeNo: number,
    batches: number,
    perBatch: number,
    options: { pauseMs?: number } = {},
  ): Promise<StrokeSpec> {
    const room = { room: roomCode, user_id: peer.board.userId };
    const strokeId = generateUuid();
    const points: Point[] = [{ x: 0, y: strokeNo }];

    peer.client.send(
      createEnvelope(
        MessageType.STROKE_BEGIN,
        {
          op_id: generateUuid(),
          strokeId,
          color: '#2563EB',
          width: 3,
          startPoint: points[0],
        },
        room,
      ),
    );

    for (let b = 0; b < batches; b++) {
      const batch: Point[] = [];
      for (let i = 0; i < perBatch; i++) {
        batch.push({ x: points.length + i, y: strokeNo + ((b + i) % 5) });
      }
      points.push(...batch);
      peer.client.send(
        createEnvelope(
          MessageType.STROKE_POINTS,
          { op_id: generateUuid(), strokeId, points: batch },
          room,
        ),
      );
      await sleep(options.pauseMs ?? 2 + Math.random() * 6);
    }

    const finalPoint: Point = { x: points.length, y: strokeNo };
    points.push(finalPoint);
    peer.client.send(
      createEnvelope(MessageType.STROKE_END, { op_id: generateUuid(), strokeId, finalPoint }, room),
    );
    return { strokeId, points };
  }

  /** Waits until every peer has applied everything the server has and has nothing left to send. */
  async function converge(roomCode: string, who: Peer[], timeoutMs = 20000): Promise<void> {
    const room = server.roomManager.getRoom(roomCode)!;
    await waitUntil(
      () => who.every((p) => p.board.lastSeq === room.seq && p.client.getPendingCount() === 0),
      timeoutMs,
    );
    // Make sure nothing else is still trickling in.
    await sleep(200);
    await waitUntil(
      () => who.every((p) => p.board.lastSeq === room.seq && p.client.getPendingCount() === 0),
      timeoutMs,
    );
  }

  function expectIdenticalCanvases(roomCode: string, who: Peer[]): void {
    const room = server.roomManager.getRoom(roomCode)!;
    const authoritative = fingerprint(room.getSnapshot().objects);
    for (const peer of who) {
      expect(fingerprint(peer.board.objects), `${peer.name}'s canvas`).toBe(authoritative);
      expect(peer.board.violations, `${peer.name}'s delivery order`).toEqual([]);
    }
  }

  afterEach(async () => {
    for (const peer of peers) peer.client.disconnect();
    peers.length = 0;
    for (const proxy of proxies) await proxy.close();
    proxies.length = 0;
    await server.close();
  });

  it('converges to an identical canvas under delay, duplication, reordering and loss', async () => {
    const { port } = await startRig();
    const proxy = await startProxy(port);

    const alice = await connectPeer('Alice', proxy, 'create');
    const roomCode = alice.board.roomCode;
    const bob = await connectPeer('Bob', proxy, 'join', roomCode);
    const carol = await connectPeer('Carol', proxy, 'join', roomCode);
    const everyone = [alice, bob, carol];
    const room = server.roomManager.getRoom(roomCode)!;
    await waitUntil(() => everyone.every((p) => p.board.lastSeq === room.seq));

    // From here on the network is hostile.
    proxy.setFaults('toClient', {
      dropRate: 0.15,
      duplicateRate: 0.15,
      reorderRate: 0.15,
      minDelayMs: 0,
      maxDelayMs: 40,
    });
    proxy.setFaults('toServer', {
      duplicateRate: 0.2,
      minDelayMs: 0,
      maxDelayMs: 15,
    });

    const STROKES_PER_PEER = 6;
    const drawn = await Promise.all(
      everyone.map(async (peer, index) => {
        const specs: StrokeSpec[] = [];
        for (let s = 0; s < STROKES_PER_PEER; s++) {
          specs.push(await drawStroke(peer, roomCode, index * 100 + s, 3, 4));
          if (s === 2) sendChat(peer, roomCode, `${peer.name} is halfway`);
        }
        sendChat(peer, roomCode, `${peer.name} is done`);
        return specs;
      }),
    );

    // Alice erases one of her own strokes while everything is still settling.
    const erasedId = drawn[0]![0]!.strokeId;
    alice.client.send(
      createEnvelope(
        MessageType.ERASE,
        { op_id: generateUuid(), objectIds: [erasedId] },
        { room: roomCode, user_id: alice.board.userId },
      ),
    );

    await converge(roomCode, everyone);

    // The faults really happened...
    expect(proxy.stats.toClient.dropped).toBeGreaterThan(0);
    expect(proxy.stats.toClient.duplicated).toBeGreaterThan(0);
    expect(proxy.stats.toClient.reordered).toBeGreaterThan(0);
    expect(proxy.stats.toServer.duplicated).toBeGreaterThan(0);
    // ...and were repaired by the reliability layer.
    const resyncs = everyone.reduce((n, p) => n + p.client.stats.resyncRequests, 0);
    const dropped = everyone.reduce((n, p) => n + p.client.stats.duplicatesDropped, 0);
    expect(resyncs).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);

    // Everyone holds exactly the server's canvas, built in strict order, exactly once.
    expectIdenticalCanvases(roomCode, everyone);

    // No stroke lost, none duplicated, none scrambled, one erased.
    const expectedStrokes = drawn.flat().filter((s) => s.strokeId !== erasedId);
    const serverObjects = room.getSnapshot().objects;
    expect(Object.keys(serverObjects)).toHaveLength(expectedStrokes.length);
    for (const spec of expectedStrokes) {
      const stroke = serverObjects[spec.strokeId] as StrokeObject;
      expect(stroke.isComplete).toBe(true);
      expect(stroke.points).toEqual(spec.points);
    }
    expect(serverObjects[erasedId]).toBeUndefined();

    // Every chat message reached everyone exactly once.
    const allChatIds = everyone.flatMap((p) => p.chatIds);
    expect(allChatIds).toHaveLength(everyone.length * 2);
    for (const peer of everyone) {
      expect(peer.board.eventsOfType(MessageType.CHAT_MESSAGE)).toHaveLength(allChatIds.length);
      for (const id of allChatIds) expect(peer.board.chatIds.has(id)).toBe(true);
    }

    // The client's outbox is empty: every operation was acknowledged.
    for (const peer of everyone) expect(peer.client.getPendingCount()).toBe(0);
  }, 60000);

  it('resumes a client cut off mid-stroke: nothing lost, nothing duplicated, identity kept', async () => {
    const { port } = await startRig();
    const proxyA = await startProxy(port, 1);
    const proxyB = await startProxy(port, 2);

    const alice = await connectPeer('Alice', proxyA, 'create');
    const roomCode = alice.board.roomCode;
    const bob = await connectPeer('Bob', proxyB, 'join', roomCode);
    const room = server.roomManager.getRoom(roomCode)!;
    await waitUntil(() => [alice, bob].every((p) => p.board.lastSeq === room.seq));
    const bobId = bob.board.userId;

    // Bob starts a stroke and is cut off right after sending part of it.
    const room_ = { room: roomCode, user_id: bobId };
    const strokeId = generateUuid();
    const points: Point[] = [{ x: 0, y: 0 }];
    bob.client.send(
      createEnvelope(
        MessageType.STROKE_BEGIN,
        { op_id: generateUuid(), strokeId, color: '#DC2626', width: 4, startPoint: points[0] },
        room_,
      ),
    );
    const sendBatch = (): void => {
      const batch: Point[] = [0, 1, 2, 3].map((i) => ({ x: points.length + i, y: i }));
      points.push(...batch);
      bob.client.send(
        createEnvelope(
          MessageType.STROKE_POINTS,
          { op_id: generateUuid(), strokeId, points: batch },
          room_,
        ),
      );
    };
    sendBatch();
    sendBatch();
    sendBatch();
    proxyB.setOnline(false); // the network drops with frames possibly still in flight

    // Bob keeps drawing while offline: his client queues everything.
    await waitUntil(() => bob.board.statuses.some((s) => s.status === 'reconnecting'));
    sendBatch();
    sendBatch();
    sendBatch();
    const finalPoint: Point = { x: points.length, y: 99 };
    points.push(finalPoint);
    bob.client.send(
      createEnvelope(
        MessageType.STROKE_END,
        { op_id: generateUuid(), strokeId, finalPoint },
        room_,
      ),
    );
    expect(bob.client.getPendingCount()).toBeGreaterThanOrEqual(4);

    // Meanwhile Alice keeps working.
    const aliceStroke = await drawStroke(alice, roomCode, 500, 2, 3);
    await sleep(300);

    // The network comes back.
    proxyB.setOnline(true);
    await waitUntil(() => bob.board.connectedCount() >= 2);
    await converge(roomCode, [alice, bob]);

    // Bob's stroke is complete and exact on the server, and everywhere else.
    const stroke = room.getSnapshot().objects[strokeId] as StrokeObject;
    expect(stroke.isComplete).toBe(true);
    expect(stroke.points).toEqual(points);
    expect(room.getSnapshot().objects[aliceStroke.strokeId]).toBeDefined();
    expectIdenticalCanvases(roomCode, [alice, bob]);

    // He came back as the same participant: no ghost, same id, same role.
    expect(room.participantCount).toBe(2);
    expect(room.getParticipant(bobId)?.role).toBe(Role.EDITOR);
    expect(bob.board.userId).toBe(bobId);
    expect(alice.board.participants.has(bobId)).toBe(true);
    expect(alice.board.eventsOfType(MessageType.PARTICIPANT_LEFT).length).toBeGreaterThanOrEqual(1);
    expect(alice.board.eventsOfType(MessageType.PARTICIPANT_JOINED).length).toBeGreaterThanOrEqual(
      2,
    );

    // And the recovery used the cheap path with the queued operations replayed.
    expect(bob.client.stats.reconnectAttempts).toBeGreaterThanOrEqual(1);
    expect(bob.client.stats.incrementalResumes).toBe(1);
    expect(bob.client.stats.retransmitted).toBeGreaterThanOrEqual(4);
    expect(bob.client.getPendingCount()).toBe(0);
  }, 60000);

  it('lets a reconnect that beats the server timeout take over: host stays host, nobody sees a leave', async () => {
    const { port } = await startRig();
    const proxyA = await startProxy(port, 3);
    const proxyB = await startProxy(port, 4);

    const alice = await connectPeer('Alice', proxyA, 'create');
    const roomCode = alice.board.roomCode;
    const bob = await connectPeer('Bob', proxyB, 'join', roomCode);
    const room = server.roomManager.getRoom(roomCode)!;
    await waitUntil(() => [alice, bob].every((p) => p.board.lastSeq === room.seq));
    const aliceId = alice.board.userId;
    const leavesBefore = bob.board.eventsOfType(MessageType.PARTICIPANT_LEFT).length;

    // Alice's connection dies on her side only: the server keeps her old socket open and
    // still believes she is connected when she shows up again.
    proxyA.severClients();
    await waitUntil(() => alice.board.connectedCount() >= 2);

    expect(room.participantCount).toBe(2);
    expect(room.hostUserId).toBe(aliceId);
    expect(room.getParticipant(aliceId)?.role).toBe(Role.HOST);
    expect(bob.board.eventsOfType(MessageType.PARTICIPANT_LEFT)).toHaveLength(leavesBefore);
    expect(alice.client.stats.incrementalResumes).toBe(1);
    expect(server.sessionCount).toBe(2); // the stale session was retired, not left behind

    // The new connection works in both directions.
    const aliceStroke = await drawStroke(alice, roomCode, 7, 2, 3);
    const bobStroke = await drawStroke(bob, roomCode, 8, 2, 3);
    await converge(roomCode, [alice, bob]);

    const objects = room.getSnapshot().objects;
    expect((objects[aliceStroke.strokeId] as StrokeObject).points).toEqual(aliceStroke.points);
    expect((objects[bobStroke.strokeId] as StrokeObject).points).toEqual(bobStroke.points);
    expectIdenticalCanvases(roomCode, [alice, bob]);
  }, 60000);

  it('falls back to a full snapshot when a client was away longer than the server keeps history', async () => {
    const { port } = await startRig();
    const proxyA = await startProxy(port, 5);
    const proxyB = await startProxy(port, 6);

    const alice = await connectPeer('Alice', proxyA, 'create');
    const roomCode = alice.board.roomCode;
    const bob = await connectPeer('Bob', proxyB, 'join', roomCode);
    const room = server.roomManager.getRoom(roomCode)!;
    room.maxOpsLogSize = 20;
    room.compactRetainOps = 10;
    await waitUntil(() => [alice, bob].every((p) => p.board.lastSeq === room.seq));

    proxyB.setOnline(false);
    await waitUntil(() => bob.board.statuses.some((s) => s.status === 'reconnecting'));

    // Alice draws far more than the server retains while Bob is away.
    for (let s = 0; s < 15; s++) {
      await drawStroke(alice, roomCode, s, 1, 2, { pauseMs: 1 });
    }
    await waitUntil(() => alice.client.getPendingCount() === 0);
    expect(room.baseSeq).toBeGreaterThan(0);

    proxyB.setOnline(true);
    await waitUntil(() => bob.board.connectedCount() >= 2);
    await converge(roomCode, [alice, bob]);

    expect(bob.client.stats.snapshotResumes).toBe(1);
    expect(bob.client.stats.incrementalResumes).toBe(0);
    expectIdenticalCanvases(roomCode, [alice, bob]);
    expect(Object.keys(room.getSnapshot().objects)).toHaveLength(15);
    expect(room.participantCount).toBe(2);
  }, 60000);
});
