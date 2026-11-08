/**
 * @fileoverview Deterministic tests of the client's reliability layer (Phase 8).
 *
 * The real MainTcpClient talks over a real TCP socket to a scripted fake server, which lets each
 * test inject exactly the misbehaviour it wants to prove is handled: reordered frames,
 * duplicates, lost frames, a lost tail, dropped connections, silence, rejections...
 */

import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  encodeFrame,
  FrameDecoder,
  generateUuid,
  isSequencedType,
  type MessageEnvelope,
  MessageType,
  type RoomStatePayload,
  type SequencedOperation,
} from '@cn-whiteboard/common';
import {
  MainTcpClient,
  type TcpClientSink,
  type TcpClientTimings,
} from '../electron/tcp-client.js';
import type { ConnectionStatusEvent } from '../src/types/ipc.js';

const ROOM = 'ABC234';
const USER_ID = generateUuid();
const SESSION_ID = generateUuid();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
    await sleep(5);
  }
}

const FAST: Partial<TcpClientTimings> = {
  heartbeatIntervalMs: 50,
  heartbeatTimeoutMs: 5000,
  reconnectBaseMs: 20,
  reconnectMaxMs: 80,
  gapWaitMs: 40,
  resyncTimeoutMs: 300,
  connectTimeoutMs: 2000,
};

// ---------------------------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------------------------

class TestSink implements TcpClientSink {
  public messages: MessageEnvelope[] = [];
  public statuses: ConnectionStatusEvent[] = [];

  public status = (event: ConnectionStatusEvent): void => {
    this.statuses.push(event);
  };

  public message = (envelope: MessageEnvelope): void => {
    this.messages.push(envelope);
  };

  /** Sequence numbers of the sequenced events handed to the renderer, in delivery order. */
  public delivered(): number[] {
    return this.messages.filter((m) => m.seq > 0 && isSequencedType(m.type)).map((m) => m.seq);
  }

  public ofType(type: MessageType): MessageEnvelope[] {
    return this.messages.filter((m) => m.type === type);
  }

  public hasStatus(status: ConnectionStatusEvent['status']): boolean {
    return this.statuses.some((s) => s.status === status);
  }
}

class FakeConn {
  public received: MessageEnvelope[] = [];
  private decoder = new FrameDecoder();

  constructor(
    public readonly index: number,
    public readonly socket: net.Socket,
    onEnvelope: (conn: FakeConn, envelope: MessageEnvelope) => void,
  ) {
    socket.on('data', (chunk) => {
      for (const envelope of this.decoder.feed(chunk)) {
        this.received.push(envelope);
        onEnvelope(this, envelope);
      }
    });
    socket.on('error', () => {
      // Resets are expected when the client tears connections down.
    });
  }

  public sendEnvelope(envelope: MessageEnvelope): void {
    if (!this.socket.destroyed) this.socket.write(encodeFrame(envelope));
  }

  public send(
    type: MessageType,
    payload: unknown,
    options?: { seq?: number; room?: string; user_id?: string },
  ): void {
    this.sendEnvelope(createEnvelope(type, payload, options));
  }

  public ofType(type: MessageType): MessageEnvelope[] {
    return this.received.filter((m) => m.type === type);
  }
}

type Handler = (conn: FakeConn, envelope: MessageEnvelope) => void;

class FakeServer {
  public connections: FakeConn[] = [];
  public port = 0;
  private server: net.Server;

  private constructor(handler: Handler) {
    this.server = net.createServer((socket) => {
      const conn = new FakeConn(this.connections.length, socket, handler);
      this.connections.push(conn);
    });
  }

  public static async start(handler: Handler, port = 0): Promise<FakeServer> {
    const fake = new FakeServer(handler);
    await new Promise<void>((resolve) => fake.server.listen(port, '127.0.0.1', resolve));
    fake.port = (fake.server.address() as net.AddressInfo).port;
    return fake;
  }

  public async close(): Promise<void> {
    for (const conn of this.connections) conn.socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function roomState(seq: number): RoomStatePayload {
  return {
    roomCode: ROOM,
    roomName: 'Fake Room',
    seq,
    objects: {},
    participants: [],
    chatHistory: [],
    locked: false,
    createdAt: Date.now(),
  };
}

function chatEvent(seq: number): MessageEnvelope {
  return createEnvelope(
    MessageType.CHAT_MESSAGE,
    { id: generateUuid(), text: `message ${seq}`, username: 'Peer', color: '#10B981', ts: 1 },
    { seq, room: ROOM, user_id: USER_ID },
  );
}

function chatOperation(seq: number): SequencedOperation {
  return {
    op_id: generateUuid(),
    seq,
    userId: USER_ID,
    type: MessageType.CHAT_MESSAGE,
    payload: { id: generateUuid(), text: `message ${seq}`, username: 'Peer', color: '#10B981' },
    ts: 1,
  };
}

interface FakeOptions {
  /** Seq of the snapshot sent on CREATE_ROOM. */
  baselineSeq?: number;
  /** Called for every JOIN_ROOM (a reconnect). Default: answer with an empty resync. */
  onJoin?: Handler;
  /** Called for every other message after the standard handshake handling. */
  onOther?: Handler;
  /** Replaces the standard CREATE_ROOM answer. */
  onCreate?: Handler;
}

/**
 * A fake server that speaks just enough of the protocol: handshake, create, rejoin.
 * Everything else is up to the individual test.
 */
function scripted(options: FakeOptions = {}): Handler {
  const baseline = options.baselineSeq ?? 1;
  return (conn, envelope) => {
    switch (envelope.type) {
      case MessageType.HELLO: {
        const token = (envelope.payload as { sessionToken?: string }).sessionToken;
        conn.send(MessageType.AUTH_OK, {
          sessionId: token ?? SESSION_ID,
          userId: USER_ID,
          protocolVersion: 1,
        });
        break;
      }
      case MessageType.CREATE_ROOM:
        if (options.onCreate) {
          options.onCreate(conn, envelope);
        } else {
          conn.send(MessageType.ROOM_STATE, roomState(baseline), {
            room: ROOM,
            user_id: USER_ID,
            seq: baseline,
          });
        }
        break;
      case MessageType.JOIN_ROOM: {
        if (options.onJoin) {
          options.onJoin(conn, envelope);
        } else {
          const lastSeq = (envelope.payload as { lastSeq?: number }).lastSeq ?? 0;
          conn.send(
            MessageType.RESYNC_RESPONSE,
            { from_seq: lastSeq, to_seq: lastSeq, operations: [] },
            { room: ROOM, user_id: USER_ID },
          );
        }
        break;
      }
      default:
        options.onOther?.(conn, envelope);
    }
  };
}

describe('Client reliability layer (Phase 8)', () => {
  const servers: FakeServer[] = [];
  const clients: MainTcpClient[] = [];

  async function setup(
    options: FakeOptions = {},
    timings: Partial<TcpClientTimings> = {},
  ): Promise<{ server: FakeServer; client: MainTcpClient; sink: TestSink }> {
    const server = await FakeServer.start(scripted(options));
    servers.push(server);
    const sink = new TestSink();
    const client = new MainTcpClient(sink, { ...FAST, ...timings });
    clients.push(client);
    const result = await client.connect({
      host: '127.0.0.1',
      port: server.port,
      username: 'Alice',
      action: 'create',
      roomName: 'Fake Room',
    });
    expect(result.success).toBe(true);
    return { server, client, sink };
  }

  function strokeBegin(): MessageEnvelope {
    return createEnvelope(
      MessageType.STROKE_BEGIN,
      {
        op_id: generateUuid(),
        strokeId: generateUuid(),
        color: '#10B981',
        width: 3,
        startPoint: { x: 1, y: 1 },
      },
      { room: ROOM, user_id: USER_ID },
    );
  }

  afterEach(async () => {
    for (const client of clients) client.disconnect();
    clients.length = 0;
    for (const server of servers) await server.close();
    servers.length = 0;
  });

  describe('ordered, exactly-once delivery', () => {
    it('delivers reordered and duplicated events once and in order, without needing a resync', async () => {
      const { server, client, sink } = await setup();
      const conn = server.connections[0]!;

      const e2 = chatEvent(2);
      const e3 = chatEvent(3);
      const e4 = chatEvent(4);
      conn.sendEnvelope(e3); // arrives early: must wait for 2
      conn.sendEnvelope(e2);
      conn.sendEnvelope(e3); // duplicate
      conn.sendEnvelope(e2); // duplicate
      conn.sendEnvelope(e4);

      await waitUntil(() => sink.delivered().length >= 3);
      await sleep(150);

      expect(sink.delivered()).toEqual([2, 3, 4]);
      expect(client.stats.duplicatesDropped).toBeGreaterThanOrEqual(2);
      expect(client.stats.outOfOrderBuffered).toBeGreaterThanOrEqual(1);
      expect(client.stats.resyncRequests).toBe(0);
      expect(client.getLastSeq()).toBe(4);
    });

    it('drops events already contained in the initial snapshot and holds back ones that raced ahead of it', async () => {
      const { sink } = await setup({
        onCreate: (conn) => {
          // Events overtook the snapshot: 3 and 2 arrive before ROOM_STATE(seq=2).
          conn.sendEnvelope(chatEvent(3));
          conn.sendEnvelope(chatEvent(2));
          conn.send(MessageType.ROOM_STATE, roomState(2), {
            room: ROOM,
            user_id: USER_ID,
            seq: 2,
          });
        },
      });

      await waitUntil(() => sink.delivered().length >= 1);
      await sleep(100);

      // Snapshot first, then only the event that is newer than it.
      expect(sink.delivered()).toEqual([3]);
      const snapshotIndex = sink.messages.findIndex((m) => m.type === MessageType.ROOM_STATE);
      const eventIndex = sink.messages.findIndex((m) => m.seq === 3);
      expect(snapshotIndex).toBeLessThan(eventIndex);
    });

    it('ignores a stale or duplicated snapshot instead of rewinding', async () => {
      const { server, sink } = await setup({ baselineSeq: 5 });
      const conn = server.connections[0]!;

      conn.sendEnvelope(chatEvent(6));
      conn.sendEnvelope(chatEvent(7));
      await waitUntil(() => sink.delivered().length === 2);

      conn.send(MessageType.ROOM_STATE, roomState(3), { room: ROOM, user_id: USER_ID, seq: 3 });
      conn.sendEnvelope(chatEvent(8));
      await waitUntil(() => sink.delivered().length === 3);

      expect(sink.ofType(MessageType.ROOM_STATE)).toHaveLength(1);
      expect(sink.delivered()).toEqual([6, 7, 8]);
    });
  });

  describe('gap recovery', () => {
    it('requests the missing range when a gap does not close by itself', async () => {
      const { server, client, sink } = await setup({
        onOther: (conn, envelope) => {
          if (envelope.type === MessageType.RESYNC_REQUEST) {
            conn.send(
              MessageType.RESYNC_RESPONSE,
              {
                from_seq: 2,
                to_seq: 3,
                operations: [chatOperation(2), chatOperation(3)],
              },
              { room: ROOM, user_id: USER_ID },
            );
          }
        },
      });
      const conn = server.connections[0]!;

      conn.sendEnvelope(chatEvent(3)); // seq 2 was lost

      await waitUntil(() => sink.delivered().length >= 2);

      const requests = conn.ofType(MessageType.RESYNC_REQUEST);
      expect(requests).toHaveLength(1);
      expect((requests[0]!.payload as { last_seq: number }).last_seq).toBe(1);
      expect(sink.delivered()).toEqual([2, 3]);
      expect(client.stats.resyncRequests).toBe(1);
    });

    it('notices a lost tail from the room seq carried by PONG and recovers it', async () => {
      const { server, client, sink } = await setup({
        onOther: (conn, envelope) => {
          if (envelope.type === MessageType.RESYNC_REQUEST) {
            conn.send(
              MessageType.RESYNC_RESPONSE,
              {
                from_seq: 3,
                to_seq: 4,
                operations: [chatOperation(3), chatOperation(4)],
              },
              { room: ROOM, user_id: USER_ID },
            );
          }
        },
      });
      const conn = server.connections[0]!;

      conn.sendEnvelope(chatEvent(2));
      await waitUntil(() => sink.delivered().length === 1);

      // Events 3 and 4 were lost; nothing later will ever reveal the gap, except the heartbeat.
      conn.send(MessageType.PONG, { nonce: 1, serverTs: Date.now(), roomSeq: 4 });

      await waitUntil(() => sink.delivered().length === 3);
      expect(sink.delivered()).toEqual([2, 3, 4]);
      const request = conn.ofType(MessageType.RESYNC_REQUEST)[0]!;
      expect((request.payload as { last_seq: number }).last_seq).toBe(2);
      expect(client.getLastSeq()).toBe(4);
    });

    it('asks again when a resync response never arrives', async () => {
      let requests = 0;
      const { server, sink } = await setup({
        onOther: (conn, envelope) => {
          if (envelope.type === MessageType.RESYNC_REQUEST) {
            requests += 1;
            if (requests === 2) {
              conn.send(
                MessageType.RESYNC_RESPONSE,
                { from_seq: 2, to_seq: 3, operations: [chatOperation(2), chatOperation(3)] },
                { room: ROOM, user_id: USER_ID },
              );
            }
          }
        },
      });

      server.connections[0]!.sendEnvelope(chatEvent(3));

      await waitUntil(() => sink.delivered().length >= 2, 4000);
      expect(requests).toBe(2);
      expect(sink.delivered()).toEqual([2, 3]);
    });

    it('accepts a full snapshot as the answer to a resync and continues after it', async () => {
      const { server, sink } = await setup({
        onOther: (conn, envelope) => {
          if (envelope.type === MessageType.RESYNC_REQUEST) {
            conn.send(
              MessageType.RESYNC_RESPONSE,
              { from_seq: 0, to_seq: 50, fullSnapshot: roomState(50) },
              { room: ROOM, user_id: USER_ID },
            );
          }
        },
      });
      const conn = server.connections[0]!;

      conn.sendEnvelope(chatEvent(40)); // far ahead: the server will answer with a snapshot
      await waitUntil(() => sink.ofType(MessageType.RESYNC_RESPONSE).length === 1);

      conn.sendEnvelope(chatEvent(51));
      await waitUntil(() => sink.delivered().includes(51));
      expect(sink.delivered()).toEqual([51]);
    });
  });

  describe('operation delivery', () => {
    it('keeps un-acknowledged operations and retransmits them after reconnecting', async () => {
      const { server, client, sink } = await setup();
      const first = server.connections[0]!;

      const op1 = strokeBegin();
      client.send(op1);
      await waitUntil(() => first.ofType(MessageType.STROKE_BEGIN).length === 1);
      expect(client.getPendingCount()).toBe(1); // sent, but never echoed or acknowledged

      // The connection dies; the user keeps drawing while offline.
      first.socket.destroy();
      await waitUntil(() => sink.hasStatus('reconnecting'));
      const op2 = createEnvelope(
        MessageType.STROKE_POINTS,
        { op_id: generateUuid(), strokeId: generateUuid(), points: [{ x: 2, y: 2 }] },
        { room: ROOM, user_id: USER_ID },
      );
      expect(client.send(op2)).toBe(true);
      expect(client.getPendingCount()).toBe(2);

      // The client comes back as the same participant, and tells the server how far it got.
      await waitUntil(() => server.connections.length >= 2);
      const second = server.connections[1]!;
      await waitUntil(() => second.ofType(MessageType.JOIN_ROOM).length === 1);
      const join = second.ofType(MessageType.JOIN_ROOM)[0]!.payload as {
        roomCode: string;
        sessionToken: string;
        lastSeq: number;
      };
      expect(join.roomCode).toBe(ROOM);
      expect(join.sessionToken).toBe(SESSION_ID);
      expect(join.lastSeq).toBe(1);
      expect(
        (second.ofType(MessageType.HELLO)[0]!.payload as { sessionToken: string }).sessionToken,
      ).toBe(SESSION_ID);

      // Both operations are re-sent, in the original order.
      await waitUntil(
        () =>
          second.ofType(MessageType.STROKE_BEGIN).length === 1 &&
          second.ofType(MessageType.STROKE_POINTS).length === 1,
      );
      const resent = second.received.filter(
        (m) => m.type === MessageType.STROKE_BEGIN || m.type === MessageType.STROKE_POINTS,
      );
      expect(resent.map((m) => m.msg_id)).toEqual([op1.msg_id, op2.msg_id]);
      expect(client.stats.retransmitted).toBe(2);
      expect(sink.hasStatus('connected')).toBe(true);
      expect(client.stats.incrementalResumes).toBe(1);

      // The server acknowledges them (it recognised the retried op ids).
      second.send(MessageType.ACK, { target_msg_id: op1.msg_id, status: 'ok', seq: 2 });
      second.send(MessageType.ACK, { target_msg_id: op2.msg_id, status: 'ok', seq: 3 });
      await waitUntil(() => client.getPendingCount() === 0);
    });

    it('treats the echo of an operation as its acknowledgement', async () => {
      const { server, client } = await setup();
      const conn = server.connections[0]!;

      const op = strokeBegin();
      client.send(op);
      await waitUntil(() => conn.ofType(MessageType.STROKE_BEGIN).length === 1);
      expect(client.getPendingCount()).toBe(1);

      // The server's broadcast carries the same msg_id and op_id back, now with a seq.
      conn.sendEnvelope({ ...op, seq: 2 });
      await waitUntil(() => client.getPendingCount() === 0);
    });

    it('stops retransmitting an operation the server rejected', async () => {
      const { server, client, sink } = await setup();
      const first = server.connections[0]!;

      const op = strokeBegin();
      client.send(op);
      await waitUntil(() => first.ofType(MessageType.STROKE_BEGIN).length === 1);

      first.send(MessageType.ERROR, {
        code: 'FORBIDDEN',
        message: 'Viewer role cannot mutate canvas',
        details: { target_msg_id: op.msg_id },
      });
      await waitUntil(() => client.getPendingCount() === 0);
      expect(sink.ofType(MessageType.ERROR)).toHaveLength(1);

      first.socket.destroy();
      await waitUntil(() => server.connections.length >= 2);
      await waitUntil(() => sink.statuses.filter((s) => s.status === 'connected').length >= 2);
      expect(server.connections[1]!.ofType(MessageType.STROKE_BEGIN)).toHaveLength(0);
    });

    it('does not queue ephemeral messages such as cursor moves while offline', async () => {
      const { server, client, sink } = await setup();
      server.connections[0]!.socket.destroy();
      await waitUntil(() => sink.hasStatus('reconnecting'));

      const cursor = createEnvelope(
        MessageType.CURSOR_MOVE,
        { x: 1, y: 2 },
        { room: ROOM, user_id: USER_ID },
      );
      expect(client.send(cursor)).toBe(false);
      expect(client.getPendingCount()).toBe(0);
    });
  });

  describe('reconnecting', () => {
    it('applies the operations it missed while away when the server answers with an incremental resync', async () => {
      const { server, client, sink } = await setup({
        onJoin: (conn) => {
          conn.send(
            MessageType.RESYNC_RESPONSE,
            {
              from_seq: 2,
              to_seq: 4,
              operations: [chatOperation(2), chatOperation(3), chatOperation(4)],
            },
            { room: ROOM, user_id: USER_ID },
          );
        },
      });

      server.connections[0]!.socket.destroy();
      await waitUntil(() => sink.delivered().length === 3);

      expect(sink.delivered()).toEqual([2, 3, 4]);
      expect(client.getLastSeq()).toBe(4);
      expect(client.stats.incrementalResumes).toBe(1);
      expect(sink.statuses.filter((s) => s.status === 'connected')).toHaveLength(2);
    });

    it('adopts a full snapshot when the server cannot resume incrementally', async () => {
      const { server, client, sink } = await setup({
        onJoin: (conn) => {
          conn.send(MessageType.ROOM_STATE, roomState(30), {
            room: ROOM,
            user_id: USER_ID,
            seq: 30,
          });
        },
      });

      server.connections[0]!.socket.destroy();
      await waitUntil(() => sink.ofType(MessageType.ROOM_STATE).length === 2);

      expect(client.getLastSeq()).toBe(30);
      expect(client.stats.snapshotResumes).toBe(1);
    });

    it('backs off exponentially while the server is unreachable and recovers when it returns', async () => {
      const { server, client, sink } = await setup(
        {},
        { reconnectBaseMs: 30, reconnectMaxMs: 120 },
      );
      const port = server.port;

      // Take the whole server down.
      await server.close();
      await waitUntil(
        () => sink.statuses.filter((s) => s.status === 'reconnecting').length >= 4,
        4000,
      );

      const delays = sink.statuses
        .filter((s) => s.status === 'reconnecting')
        .map((s) => s.retryInMs ?? 0);
      // 30, 60, 120, 120... (each with +/-20% jitter), never above the cap plus jitter.
      expect(delays[0]).toBeLessThanOrEqual(36);
      expect(delays[1]).toBeGreaterThan(delays[0]!);
      expect(Math.max(...delays)).toBeLessThanOrEqual(Math.ceil(120 * 1.2));
      expect(sink.statuses.filter((s) => s.status === 'reconnecting')[3]!.attempt).toBe(4);

      // Bring a server back on the same port.
      const revived = await FakeServer.start(scripted(), port);
      servers.push(revived);
      await waitUntil(
        () => sink.statuses.filter((s) => s.status === 'connected').length >= 2,
        4000,
      );
      expect(client.getRoomCode()).toBe(ROOM);
    });

    it('gives up and reports an error when the room is gone', async () => {
      const { server, client, sink } = await setup({
        onJoin: (conn) => {
          conn.send(MessageType.ERROR, {
            code: 'JOIN_FAILED',
            message: 'Room with code "ABC234" not found',
          });
        },
      });

      server.connections[0]!.socket.destroy();
      await waitUntil(() => sink.hasStatus('error'));

      const failure = sink.statuses.find((s) => s.status === 'error')!;
      expect(failure.error).toContain('Could not rejoin');
      expect(failure.error).toContain('not found');
      expect(client.getRoomCode()).toBeNull();

      // No further attempts are made.
      await sleep(250);
      expect(server.connections).toHaveLength(2);
    });

    it('treats prolonged silence from the server as a dead connection and reconnects', async () => {
      // The fake server never answers PING, so the client hears nothing after the snapshot.
      const { server, sink } = await setup(
        {},
        { heartbeatIntervalMs: 40, heartbeatTimeoutMs: 250 },
      );

      await waitUntil(() => server.connections.length >= 2, 3000);

      const reconnecting = sink.statuses.find((s) => s.status === 'reconnecting');
      expect(reconnecting?.error).toContain('heartbeat');
      expect(server.connections[0]!.ofType(MessageType.PING).length).toBeGreaterThan(0);
    });

    it('abandons a reconnect attempt that hangs and tries again', async () => {
      // The second connection is accepted but never answered (no AUTH_OK), as if the server
      // were stuck or the network black-holed the handshake.
      const base = scripted();
      const server = await FakeServer.start((conn, envelope) => {
        if (conn.index === 1) return;
        base(conn, envelope);
      });
      servers.push(server);
      const sink = new TestSink();
      const client = new MainTcpClient(sink, { ...FAST, connectTimeoutMs: 150 });
      clients.push(client);

      const result = await client.connect({
        host: '127.0.0.1',
        port: server.port,
        username: 'Alice',
        action: 'create',
        roomName: 'Hang',
      });
      expect(result.success).toBe(true);

      server.connections[0]!.socket.destroy();
      await waitUntil(() => server.connections.length >= 3, 4000);
      await waitUntil(
        () => sink.statuses.filter((s) => s.status === 'connected').length >= 2,
        4000,
      );

      const hung = server.connections[1]!;
      expect(hung.ofType(MessageType.HELLO)).toHaveLength(1);
      expect(hung.ofType(MessageType.JOIN_ROOM)).toHaveLength(0);
      expect(
        sink.statuses.some((s) => s.status === 'reconnecting' && /timed out/.test(s.error ?? '')),
      ).toBe(true);
    });

    it('does not create a second room when the handshake reply is duplicated', async () => {
      const server = await FakeServer.start((conn, envelope) => {
        if (envelope.type === MessageType.HELLO) {
          const auth = createEnvelope(
            MessageType.AUTH_OK,
            { sessionId: SESSION_ID, userId: USER_ID, protocolVersion: 1 },
            { user_id: USER_ID },
          );
          conn.sendEnvelope(auth);
          conn.sendEnvelope(auth);
        } else if (envelope.type === MessageType.CREATE_ROOM) {
          conn.send(MessageType.ROOM_STATE, roomState(1), {
            room: ROOM,
            user_id: USER_ID,
            seq: 1,
          });
        }
      });
      servers.push(server);
      const client = new MainTcpClient(new TestSink(), FAST);
      clients.push(client);

      const result = await client.connect({
        host: '127.0.0.1',
        port: server.port,
        username: 'Alice',
        action: 'create',
        roomName: 'Once',
      });
      await sleep(100);

      expect(result.success).toBe(true);
      expect(server.connections[0]!.ofType(MessageType.CREATE_ROOM)).toHaveLength(1);
    });
  });

  describe('initial connection', () => {
    it('reports a refused connection as a failure and never starts reconnecting', async () => {
      const probe = await FakeServer.start(scripted());
      const deadPort = probe.port;
      await probe.close();

      const sink = new TestSink();
      const client = new MainTcpClient(sink, FAST);
      clients.push(client);

      const result = await client.connect({
        host: '127.0.0.1',
        port: deadPort,
        username: 'Alice',
        action: 'create',
      });

      expect(result.success).toBe(false);
      expect(sink.hasStatus('error')).toBe(true);
      await sleep(150);
      expect(sink.hasStatus('reconnecting')).toBe(false);
    });

    it('reports JOIN_FAILED from the server as a failed connect', async () => {
      const server = await FakeServer.start((conn, envelope) => {
        if (envelope.type === MessageType.HELLO) {
          conn.send(MessageType.AUTH_OK, {
            sessionId: SESSION_ID,
            userId: USER_ID,
            protocolVersion: 1,
          });
        } else if (envelope.type === MessageType.JOIN_ROOM) {
          conn.send(MessageType.ERROR, { code: 'JOIN_FAILED', message: 'Incorrect room password' });
        }
      });
      servers.push(server);
      const client = new MainTcpClient(new TestSink(), FAST);
      clients.push(client);

      const result = await client.connect({
        host: '127.0.0.1',
        port: server.port,
        username: 'Alice',
        action: 'join',
        roomCode: ROOM,
        password: 'wrong',
      });

      expect(result).toEqual({ success: false, error: 'Incorrect room password' });
    });
  });
});
