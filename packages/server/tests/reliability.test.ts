/**
 * @fileoverview Integration tests for Phase 8 (server side): liveness, idempotent retries,
 * correlated rejections, a gap-free operations log, and resuming a participant after a drop.
 */

import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AckPayload,
  createEnvelope,
  encodeFrame,
  FrameDecoder,
  generateUuid,
  type MessageEnvelope,
  MessageType,
  type ParticipantJoinedPayload,
  type PongPayload,
  type ResyncResponsePayload,
  Role,
  type RoomStatePayload,
  type StrokePointsPayload,
} from '@cn-whiteboard/common';
import { startServer, type WhiteboardServer } from '../src/index.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await sleep(10);
  }
}

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
    return new Promise((resolve) => {
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
  ): MessageEnvelope {
    const envelope = createEnvelope(type, payload, options);
    this.socket.write(encodeFrame(envelope));
    return envelope;
  }

  public sendRaw(envelope: MessageEnvelope): void {
    this.socket.write(encodeFrame(envelope));
  }

  public async waitFor(type: MessageType, timeoutMs = 4000): Promise<MessageEnvelope> {
    const deadline = Date.now() + timeoutMs;

    // Re-check the queue on every iteration: several frames can arrive in one TCP chunk, and the
    // later ones are queued (not delivered to a waiter) while this loop is between awaits.
    for (;;) {
      const index = this.queue.findIndex((m) => m.type === type);
      if (index !== -1) {
        return this.queue.splice(index, 1)[0]!;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Timeout waiting for ${type}`);
      }

      const next = await new Promise<MessageEnvelope | null>((resolve) => {
        const waiter = (msg: MessageEnvelope): void => {
          clearTimeout(timer);
          resolve(msg);
        };
        const timer = setTimeout(() => {
          // Stop listening, or this stale waiter would swallow a later message.
          const at = this.waiters.indexOf(waiter);
          if (at !== -1) this.waiters.splice(at, 1);
          resolve(null);
        }, remaining);
        this.waiters.push(waiter);
      });

      if (next) this.queue.push(next);
    }
  }

  /** Number of already-received, not yet consumed messages of this type. */
  public countQueued(type: MessageType): number {
    return this.queue.filter((m) => m.type === type).length;
  }

  public async authenticate(
    username: string,
    sessionToken?: string,
  ): Promise<{ userId: string; sessionId: string }> {
    this.send(MessageType.HELLO, {
      clientVersion: '0.1.0',
      suggestedUsername: username,
      sessionToken,
    });
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

describe('Reliability suite - server side (Phase 8)', () => {
  let server: WhiteboardServer;
  let port: number;
  const clients: SocketTestClient[] = [];
  const timers: NodeJS.Timeout[] = [];

  async function newClient(): Promise<SocketTestClient> {
    const client = await SocketTestClient.connect(port);
    clients.push(client);
    return client;
  }

  /** Creates a room with a host, plus one joined peer. */
  async function roomWithPeer(): Promise<{
    host: SocketTestClient;
    peer: SocketTestClient;
    roomCode: string;
    hostState: RoomStatePayload;
    peerState: RoomStatePayload;
  }> {
    const host = await newClient();
    await host.authenticate('Alice');
    host.send(MessageType.CREATE_ROOM, { roomName: 'Reliability', username: 'Alice' });
    const hostState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;

    const peer = await newClient();
    await peer.authenticate('Bob');
    peer.send(MessageType.JOIN_ROOM, {
      roomCode: hostState.roomCode,
      username: 'Bob',
      sessionToken: peer.sessionId,
    });
    const peerState = (await peer.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    await host.waitFor(MessageType.PARTICIPANT_JOINED);

    return { host, peer, roomCode: hostState.roomCode, hostState, peerState };
  }

  function strokeBegin(strokeId: string, opId: string = generateUuid()) {
    return {
      op_id: opId,
      strokeId,
      color: '#10B981',
      width: 3,
      startPoint: { x: 1, y: 1 },
    };
  }

  beforeEach(async () => {
    const instance = await startServer({ host: '127.0.0.1', port: 0 });
    server = instance.server;
    port = instance.port;
  });

  afterEach(async () => {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
    for (const c of clients) c.close();
    clients.length = 0;
    await server.close();
  });

  describe('connection robustness', () => {
    it('survives an abrupt connection reset without crashing the server', async () => {
      const victim = await newClient();
      await victim.authenticate('Victim');
      victim.send(MessageType.CREATE_ROOM, { roomName: 'Doomed', username: 'Victim' });
      await victim.waitFor(MessageType.ROOM_STATE);

      // Send a TCP RST (not a graceful FIN): the server-side socket emits ECONNRESET.
      const socket = victim.socket as net.Socket & { resetAndDestroy?: () => void };
      if (typeof socket.resetAndDestroy === 'function') {
        socket.resetAndDestroy();
      } else {
        socket.destroy();
      }

      await waitUntil(() => server.sessionCount === 0);

      // The server keeps serving other clients.
      const next = await newClient();
      await next.authenticate('Next');
      next.send(MessageType.CREATE_ROOM, { roomName: 'Still alive', username: 'Next' });
      const state = (await next.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
      expect(state.roomName).toBe('Still alive');
      expect(server.sessionCount).toBe(1);
    });

    it('includes the room seq in PONG so clients can detect a lost tail', async () => {
      const { host, roomCode } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;

      host.send(MessageType.PING, { nonce: 7 });
      const pong = await host.waitFor(MessageType.PONG);
      expect((pong.payload as PongPayload).roomSeq).toBe(room.seq);
    });

    it('answers PING with PONG outside of a room without a roomSeq', async () => {
      const client = await newClient();
      await client.authenticate('Lobby');
      client.send(MessageType.PING, { nonce: 3 });
      const pong = await client.waitFor(MessageType.PONG);
      expect((pong.payload as PongPayload).nonce).toBe(3);
      expect((pong.payload as PongPayload).roomSeq).toBeUndefined();
    });
  });

  describe('idempotent operations', () => {
    it('acknowledges a duplicated operation with its original seq and does not re-broadcast it', async () => {
      const { host, peer, roomCode } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;
      const strokeId = generateUuid();

      const begin = createEnvelope(MessageType.STROKE_BEGIN, strokeBegin(strokeId), {
        room: roomCode,
        user_id: host.userId,
      });
      host.sendRaw(begin);
      host.sendRaw(begin); // duplicated frame

      const echo = await host.waitFor(MessageType.STROKE_BEGIN);
      const ack = await host.waitFor(MessageType.ACK);
      expect(ack.payload as AckPayload).toMatchObject({
        status: 'ok',
        seq: echo.seq,
        target_msg_id: begin.msg_id,
      });

      await peer.waitFor(MessageType.STROKE_BEGIN);
      await sleep(100);
      expect(peer.countQueued(MessageType.STROKE_BEGIN)).toBe(0);

      const seqAfterBegin = room.seq;
      const points = createEnvelope(
        MessageType.STROKE_POINTS,
        {
          op_id: generateUuid(),
          strokeId,
          points: [
            { x: 2, y: 2 },
            { x: 3, y: 3 },
          ],
        },
        { room: roomCode, user_id: host.userId },
      );
      host.sendRaw(points);
      host.sendRaw(points);
      host.sendRaw(points);

      const pointsEcho = await host.waitFor(MessageType.STROKE_POINTS);
      expect((pointsEcho.payload as StrokePointsPayload).startIndex).toBe(1);
      await host.waitFor(MessageType.ACK);
      await host.waitFor(MessageType.ACK);
      await sleep(100);

      // One seq consumed, the points were applied exactly once.
      expect(room.seq).toBe(seqAfterBegin + 1);
      const stroke = room.getObject(strokeId);
      expect(stroke?.type === 'stroke' && stroke.points.length).toBe(3);
      expect(host.countQueued(MessageType.STROKE_POINTS)).toBe(0);
    });

    it('deduplicates retried chat messages by id', async () => {
      const { host, peer, roomCode } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;

      const chat = createEnvelope(
        MessageType.CHAT_MESSAGE,
        { id: generateUuid(), text: 'only once please' },
        { room: roomCode, user_id: host.userId },
      );
      host.sendRaw(chat);
      host.sendRaw(chat);

      const echoed = await peer.waitFor(MessageType.CHAT_MESSAGE);
      await host.waitFor(MessageType.ACK);
      await sleep(100);

      expect(peer.countQueued(MessageType.CHAT_MESSAGE)).toBe(0);
      expect(room.getChatHistory().filter((m) => m.text === 'only once please')).toHaveLength(1);

      expect(echoed.seq).toBeGreaterThan(0);
    });

    it('does not resurrect a stroke when its BEGIN is retried after it was erased', async () => {
      const { host, roomCode } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;
      const strokeId = generateUuid();
      const beginOp = generateUuid();

      host.send(MessageType.STROKE_BEGIN, strokeBegin(strokeId, beginOp), {
        room: roomCode,
        user_id: host.userId,
      });
      await host.waitFor(MessageType.STROKE_BEGIN);

      host.send(
        MessageType.ERASE,
        { op_id: generateUuid(), objectIds: [strokeId] },
        { room: roomCode, user_id: host.userId },
      );
      await host.waitFor(MessageType.ERASE);
      expect(room.getObject(strokeId)).toBeUndefined();

      // Late retry of the original BEGIN (e.g. flushed from an outbox after a reconnect).
      host.send(MessageType.STROKE_BEGIN, strokeBegin(strokeId, beginOp), {
        room: roomCode,
        user_id: host.userId,
      });
      await host.waitFor(MessageType.ACK);
      expect(room.getObject(strokeId)).toBeUndefined();
    });
  });

  describe('correlated rejections', () => {
    it('tags FORBIDDEN errors with the id of the rejected message', async () => {
      const { peer, roomCode } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;

      room.getParticipant(peer.userId)!.role = Role.VIEWER;
      room.getSession(peer.userId)!.role = Role.VIEWER;

      const attempt = peer.send(MessageType.STROKE_BEGIN, strokeBegin(generateUuid()), {
        room: roomCode,
        user_id: peer.userId,
      });
      const error = await peer.waitFor(MessageType.ERROR);
      const payload = error.payload as { code: string; details?: { target_msg_id?: string } };
      expect(payload.code).toBe('FORBIDDEN');
      expect(payload.details?.target_msg_id).toBe(attempt.msg_id);
    });

    it('rejects points for an unknown stroke with a correlated ACK so clients stop retrying', async () => {
      const { host, roomCode } = await roomWithPeer();

      const attempt = host.send(
        MessageType.STROKE_POINTS,
        { op_id: generateUuid(), strokeId: generateUuid(), points: [{ x: 1, y: 1 }] },
        { room: roomCode, user_id: host.userId },
      );
      const ack = await host.waitFor(MessageType.ACK);
      expect(ack.payload as AckPayload).toMatchObject({
        status: 'rejected',
        target_msg_id: attempt.msg_id,
      });
    });

    it('rejects points appended to an already completed stroke', async () => {
      const { host, roomCode } = await roomWithPeer();
      const strokeId = generateUuid();

      host.send(MessageType.STROKE_BEGIN, strokeBegin(strokeId), {
        room: roomCode,
        user_id: host.userId,
      });
      await host.waitFor(MessageType.STROKE_BEGIN);
      host.send(
        MessageType.STROKE_END,
        { op_id: generateUuid(), strokeId },
        { room: roomCode, user_id: host.userId },
      );
      await host.waitFor(MessageType.STROKE_END);

      host.send(
        MessageType.STROKE_POINTS,
        { op_id: generateUuid(), strokeId, points: [{ x: 9, y: 9 }] },
        { room: roomCode, user_id: host.userId },
      );
      const ack = await host.waitFor(MessageType.ACK);
      expect((ack.payload as AckPayload).status).toBe('rejected');
    });

    it('tags schema violations with the id of the offending message', async () => {
      const { host, roomCode } = await roomWithPeer();

      const attempt = host.send(
        MessageType.STROKE_POINTS,
        { op_id: 'not-a-uuid', strokeId: generateUuid(), points: [] },
        { room: roomCode, user_id: host.userId },
      );
      const error = await host.waitFor(MessageType.ERROR);
      const payload = error.payload as { code: string; details?: { target_msg_id?: string } };
      expect(payload.code).toBe('INVALID_PAYLOAD');
      expect(payload.details?.target_msg_id).toBe(attempt.msg_id);
    });
  });

  describe('gap-free sequencing', () => {
    it('records every sequence number in the ops log (drawing, chat and participant events)', async () => {
      const { host, peer, roomCode } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;
      const strokeId = generateUuid();

      host.send(MessageType.STROKE_BEGIN, strokeBegin(strokeId), {
        room: roomCode,
        user_id: host.userId,
      });
      await host.waitFor(MessageType.STROKE_BEGIN);
      peer.send(
        MessageType.CHAT_MESSAGE,
        { id: generateUuid(), text: 'between strokes' },
        { room: roomCode, user_id: peer.userId },
      );
      await host.waitFor(MessageType.CHAT_MESSAGE);
      host.send(
        MessageType.STROKE_END,
        { op_id: generateUuid(), strokeId },
        { room: roomCode, user_id: host.userId },
      );
      await host.waitFor(MessageType.STROKE_END);
      peer.send(MessageType.LEAVE_ROOM, { reason: 'bye' }, { room: roomCode });
      await host.waitFor(MessageType.PARTICIPANT_LEFT);

      const seqs = room.getOperationsSince(0).map((op) => op.seq);
      expect(seqs).toEqual(Array.from({ length: room.seq }, (_, i) => i + 1));
    });

    it('stamps stroke point batches with their authoritative start index', async () => {
      const { host, roomCode } = await roomWithPeer();
      const strokeId = generateUuid();

      host.send(MessageType.STROKE_BEGIN, strokeBegin(strokeId), {
        room: roomCode,
        user_id: host.userId,
      });
      await host.waitFor(MessageType.STROKE_BEGIN);

      host.send(
        MessageType.STROKE_POINTS,
        {
          op_id: generateUuid(),
          strokeId,
          points: [
            { x: 2, y: 2 },
            { x: 3, y: 3 },
          ],
        },
        { room: roomCode, user_id: host.userId },
      );
      const first = await host.waitFor(MessageType.STROKE_POINTS);
      host.send(
        MessageType.STROKE_POINTS,
        { op_id: generateUuid(), strokeId, points: [{ x: 4, y: 4 }] },
        { room: roomCode, user_id: host.userId },
      );
      const second = await host.waitFor(MessageType.STROKE_POINTS);
      host.send(
        MessageType.STROKE_END,
        { op_id: generateUuid(), strokeId, finalPoint: { x: 5, y: 5 } },
        { room: roomCode, user_id: host.userId },
      );
      const end = await host.waitFor(MessageType.STROKE_END);

      expect((first.payload as StrokePointsPayload).startIndex).toBe(1);
      expect((second.payload as StrokePointsPayload).startIndex).toBe(3);
      expect((end.payload as { startIndex?: number }).startIndex).toBe(4);
    });
  });

  describe('resuming after a disconnect', () => {
    it('catches a returning participant up with only the missed operations', async () => {
      const { host, peer, roomCode, peerState } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;

      // Bob drops off the network.
      peer.close();
      await host.waitFor(MessageType.PARTICIPANT_LEFT);

      // Meanwhile Alice keeps drawing.
      const strokeId = generateUuid();
      host.send(MessageType.STROKE_BEGIN, strokeBegin(strokeId), {
        room: roomCode,
        user_id: host.userId,
      });
      await host.waitFor(MessageType.STROKE_BEGIN);

      // Bob comes back on a new connection with his session token and the last seq he applied.
      const bob2 = await newClient();
      await bob2.authenticate('Bob', peer.sessionId);
      bob2.send(MessageType.JOIN_ROOM, {
        roomCode,
        username: 'Bob',
        sessionToken: peer.sessionId,
        lastSeq: peerState.seq,
      });

      const resumed = await bob2.waitFor(MessageType.RESYNC_RESPONSE);
      const payload = resumed.payload as ResyncResponsePayload;

      // Same identity as before the drop.
      expect(resumed.user_id).toBe(peer.userId);
      expect(payload.fullSnapshot).toBeUndefined();
      expect(payload.from_seq).toBe(peerState.seq + 1);
      expect(payload.to_seq).toBe(room.seq);

      // Every event since his last seq, contiguous and in order: his own leave, Alice's stroke,
      // and his rejoin.
      const seqs = payload.operations!.map((op) => op.seq);
      expect(seqs).toEqual(
        Array.from({ length: room.seq - peerState.seq }, (_, i) => peerState.seq + 1 + i),
      );
      const types = payload.operations!.map((op) => op.type);
      expect(types).toContain(MessageType.PARTICIPANT_LEFT);
      expect(types).toContain(MessageType.STROKE_BEGIN);
      expect(types).toContain(MessageType.PARTICIPANT_JOINED);

      // Alice is told Bob is back (as the same participant).
      const joined = await host.waitFor(MessageType.PARTICIPANT_JOINED);
      expect((joined.payload as ParticipantJoinedPayload).participant.id).toBe(peer.userId);
    });

    it('sends a full snapshot to a resuming participant that did not say where it left off', async () => {
      const { peer, roomCode } = await roomWithPeer();

      peer.close();
      await waitUntil(() => server.roomManager.getRoom(roomCode)!.participantCount === 1);

      const bob2 = await newClient();
      await bob2.authenticate('Bob', peer.sessionId);
      bob2.send(MessageType.JOIN_ROOM, {
        roomCode,
        username: 'Bob',
        sessionToken: peer.sessionId,
      });

      const state = (await bob2.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
      expect(state.participants.some((p) => p.id === peer.userId)).toBe(true);
    });

    it('falls back to a full snapshot when the client claims to be ahead of the room', async () => {
      const { peer, roomCode } = await roomWithPeer();

      peer.close();
      await waitUntil(() => server.roomManager.getRoom(roomCode)!.participantCount === 1);

      const bob2 = await newClient();
      await bob2.authenticate('Bob', peer.sessionId);
      bob2.send(MessageType.JOIN_ROOM, {
        roomCode,
        username: 'Bob',
        sessionToken: peer.sessionId,
        lastSeq: 99999,
      });

      const state = (await bob2.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
      expect(state.roomCode).toBe(roomCode);
    });

    it('lets a reconnect that beats the server timeout take over without disturbing the room', async () => {
      const { host, peer, roomCode } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;
      const seqBefore = room.seq;

      // Alice's old connection is still registered on the server (it has not noticed the drop).
      // She reconnects on a brand-new socket with her token.
      const alice2 = await newClient();
      await alice2.authenticate('Alice', host.sessionId);
      alice2.send(MessageType.JOIN_ROOM, {
        roomCode,
        username: 'Alice',
        sessionToken: host.sessionId,
        lastSeq: seqBefore,
      });

      const resumed = await alice2.waitFor(MessageType.RESYNC_RESPONSE);
      expect(resumed.user_id).toBe(host.userId);
      expect((resumed.payload as ResyncResponsePayload).operations).toEqual([]);

      // The stale connection is retired...
      await waitUntil(() => host.socket.destroyed);

      // ...nothing changed for the other participants: no leave/join, no seq consumed,
      // still exactly two participants, and Alice is still the host.
      await sleep(100);
      expect(room.seq).toBe(seqBefore);
      expect(room.participantCount).toBe(2);
      expect(room.hostUserId).toBe(host.userId);
      expect(room.getParticipant(host.userId)?.role).toBe(Role.HOST);
      expect(peer.countQueued(MessageType.PARTICIPANT_LEFT)).toBe(0);
      expect(peer.countQueued(MessageType.PARTICIPANT_JOINED)).toBe(0);

      // The new connection is the live one: Bob's drawing reaches Alice's new socket.
      const strokeId = generateUuid();
      peer.send(MessageType.STROKE_BEGIN, strokeBegin(strokeId), {
        room: roomCode,
        user_id: peer.userId,
      });
      const echoed = await alice2.waitFor(MessageType.STROKE_BEGIN);
      expect(echoed.seq).toBe(seqBefore + 1);
    });

    it('does not let the retired connection evict the participant when it finally closes', async () => {
      const { host, roomCode } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;

      const alice2 = await newClient();
      await alice2.authenticate('Alice', host.sessionId);
      alice2.send(MessageType.JOIN_ROOM, {
        roomCode,
        username: 'Alice',
        sessionToken: host.sessionId,
        lastSeq: room.seq,
      });
      await alice2.waitFor(MessageType.RESYNC_RESPONSE);
      await waitUntil(() => host.socket.destroyed);
      await sleep(100);

      expect(room.getParticipant(host.userId)).toBeDefined();
      expect(room.participantCount).toBe(2);
    });

    it('returns a former host as an editor after ownership moved to someone else', async () => {
      const { host, peer, roomCode } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;

      // Alice (host) drops; Bob is promoted.
      host.close();
      await peer.waitFor(MessageType.PERMISSION_CHANGE);
      expect(room.hostUserId).toBe(peer.userId);

      // Alice returns.
      const alice2 = await newClient();
      await alice2.authenticate('Alice', host.sessionId);
      alice2.send(MessageType.JOIN_ROOM, {
        roomCode,
        username: 'Alice',
        sessionToken: host.sessionId,
      });
      await alice2.waitFor(MessageType.ROOM_STATE);

      const hosts = room.getParticipants().filter((p) => p.role === Role.HOST);
      expect(hosts).toHaveLength(1);
      expect(hosts[0]!.id).toBe(peer.userId);
      expect(room.getParticipant(host.userId)?.role).toBe(Role.EDITOR);
    });

    it('keeps a locked room closed to newcomers but open to returning participants', async () => {
      const { peer, roomCode } = await roomWithPeer();
      const room = server.roomManager.getRoom(roomCode)!;
      room.locked = true;

      peer.close();
      await waitUntil(() => room.participantCount === 1);

      const stranger = await newClient();
      await stranger.authenticate('Stranger');
      stranger.send(MessageType.JOIN_ROOM, {
        roomCode,
        username: 'Stranger',
        sessionToken: stranger.sessionId,
      });
      const refusal = await stranger.waitFor(MessageType.ERROR);
      expect((refusal.payload as { code: string }).code).toBe('JOIN_FAILED');

      const bob2 = await newClient();
      await bob2.authenticate('Bob', peer.sessionId);
      bob2.send(MessageType.JOIN_ROOM, {
        roomCode,
        username: 'Bob',
        sessionToken: peer.sessionId,
      });
      const state = (await bob2.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
      expect(state.participants.some((p) => p.id === peer.userId)).toBe(true);
    });
  });
});

describe('Reliability suite - heartbeat timeout (Phase 8)', () => {
  let server: WhiteboardServer;
  let port: number;
  const clients: SocketTestClient[] = [];
  const timers: NodeJS.Timeout[] = [];

  beforeEach(async () => {
    const instance = await startServer({
      host: '127.0.0.1',
      port: 0,
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 400,
    });
    server = instance.server;
    port = instance.port;
  });

  afterEach(async () => {
    for (const timer of timers) clearInterval(timer);
    timers.length = 0;
    for (const c of clients) c.close();
    clients.length = 0;
    await server.close();
  });

  it('drops a silent client, keeps the room alive, and lets the client resume afterwards', async () => {
    const alice = await SocketTestClient.connect(port);
    clients.push(alice);
    await alice.authenticate('Alice');
    timers.push(
      setInterval(() => {
        if (!alice.socket.destroyed) alice.send(MessageType.PING, { nonce: 1 });
      }, 80),
    );
    alice.send(MessageType.CREATE_ROOM, { roomName: 'Timeouts', username: 'Alice' });
    const aliceState = (await alice.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = aliceState.roomCode;
    const room = server.roomManager.getRoom(roomCode)!;

    // Bob joins and then goes completely silent (no PINGs).
    const bob = await SocketTestClient.connect(port);
    clients.push(bob);
    await bob.authenticate('Bob');
    bob.send(MessageType.JOIN_ROOM, { roomCode, username: 'Bob', sessionToken: bob.sessionId });
    const bobState = (await bob.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    await alice.waitFor(MessageType.PARTICIPANT_JOINED);

    // The server notices the silence and removes Bob from the live roster...
    const left = await alice.waitFor(MessageType.PARTICIPANT_LEFT, 4000);
    expect((left.payload as { username: string }).username).toBe('Bob');
    await waitUntil(() => bob.socket.destroyed);

    // ...but the room (and Alice's connection) carry on untouched.
    expect(server.roomManager.getRoom(roomCode)).toBe(room);
    expect(room.participantCount).toBe(1);
    expect(alice.socket.destroyed).toBe(false);

    // Bob reconnects, keeps himself alive this time, and resumes as the same participant.
    const bob2 = await SocketTestClient.connect(port);
    clients.push(bob2);
    await bob2.authenticate('Bob', bob.sessionId);
    timers.push(
      setInterval(() => {
        if (!bob2.socket.destroyed) bob2.send(MessageType.PING, { nonce: 2 });
      }, 80),
    );
    bob2.send(MessageType.JOIN_ROOM, {
      roomCode,
      username: 'Bob',
      sessionToken: bob.sessionId,
      lastSeq: bobState.seq,
    });
    const resumed = await bob2.waitFor(MessageType.RESYNC_RESPONSE);
    expect(resumed.user_id).toBe(bob.userId);
    expect(room.participantCount).toBe(2);
  });
});
