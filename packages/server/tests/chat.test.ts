/**
 * @fileoverview Integration tests for Phase 7: Real-time Group Chat,
 * multi-client broadcasting, chronological history, late-join delivery,
 * system notifications, and bounded message retention.
 */

import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ChatHistoryPayload,
  type ChatMessage,
  type ChatMessagePayload,
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

describe('Real-time Group Chat Suite (Phase 7)', () => {
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

  it('broadcasts chat messages to all room participants with monotonic seq', async () => {
    const alice = await SocketTestClient.connect(port);
    const bob = await SocketTestClient.connect(port);
    const charlie = await SocketTestClient.connect(port);
    clients.push(alice, bob, charlie);

    await alice.authenticate('Alice');
    await bob.authenticate('Bob');
    await charlie.authenticate('Charlie');

    // Alice creates room
    alice.send(MessageType.CREATE_ROOM, { roomName: 'Chat Room', username: 'Alice' });
    const aliceState = (await alice.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = aliceState.roomCode;

    // Bob and Charlie join
    bob.send(MessageType.JOIN_ROOM, { roomCode, username: 'Bob' });
    await bob.waitFor(MessageType.ROOM_STATE);

    charlie.send(MessageType.JOIN_ROOM, { roomCode, username: 'Charlie' });
    await charlie.waitFor(MessageType.ROOM_STATE);

    // Drain any join notices
    await new Promise((r) => setTimeout(r, 50));

    // Bob sends a chat message
    bob.send(
      MessageType.CHAT_MESSAGE,
      {
        id: generateUuid(),
        text: 'Hello team, welcome to the whiteboard session!',
      },
      { room: roomCode, user_id: bob.userId },
    );

    // Alice, Bob, and Charlie should all receive the broadcast
    const aliceMsg = await alice.waitFor(MessageType.CHAT_MESSAGE);
    const bobMsg = await bob.waitFor(MessageType.CHAT_MESSAGE);
    const charlieMsg = await charlie.waitFor(MessageType.CHAT_MESSAGE);

    expect(aliceMsg.seq).toBeGreaterThan(0);
    expect(aliceMsg.seq).toBe(bobMsg.seq);
    expect(bobMsg.seq).toBe(charlieMsg.seq);

    const payload = aliceMsg.payload as ChatMessagePayload;
    expect(payload.text).toBe('Hello team, welcome to the whiteboard session!');
    expect(payload.username).toBe('Bob');
    expect(aliceMsg.user_id).toBe(bob.userId);
  });

  it('delivers chronological chat history to late joiners in ROOM_STATE', async () => {
    const alice = await SocketTestClient.connect(port);
    const bob = await SocketTestClient.connect(port);
    clients.push(alice, bob);

    await alice.authenticate('Alice');
    await bob.authenticate('Bob');

    alice.send(MessageType.CREATE_ROOM, { roomName: 'History Room', username: 'Alice' });
    const aliceState = (await alice.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = aliceState.roomCode;

    bob.send(MessageType.JOIN_ROOM, { roomCode, username: 'Bob' });
    await bob.waitFor(MessageType.ROOM_STATE);

    // Send 3 chat messages between Alice and Bob
    alice.send(
      MessageType.CHAT_MESSAGE,
      { id: generateUuid(), text: 'Message 1 from Alice' },
      { room: roomCode, user_id: alice.userId },
    );
    await alice.waitFor(MessageType.CHAT_MESSAGE);

    bob.send(
      MessageType.CHAT_MESSAGE,
      { id: generateUuid(), text: 'Message 2 from Bob' },
      { room: roomCode, user_id: bob.userId },
    );
    await alice.waitFor(MessageType.CHAT_MESSAGE);

    alice.send(
      MessageType.CHAT_MESSAGE,
      { id: generateUuid(), text: 'Message 3 from Alice' },
      { room: roomCode, user_id: alice.userId },
    );
    await alice.waitFor(MessageType.CHAT_MESSAGE);

    // Now Dave joins late
    const dave = await SocketTestClient.connect(port);
    clients.push(dave);
    await dave.authenticate('Dave');

    dave.send(MessageType.JOIN_ROOM, { roomCode, username: 'Dave' });
    const daveState = (await dave.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;

    expect(daveState.chatHistory).toBeDefined();
    // System notices + user messages should all be present in chronological order
    const userMessages = daveState.chatHistory.filter((m: ChatMessage) => !m.isSystem);
    expect(userMessages.length).toBe(3);
    expect(userMessages[0]!.text).toBe('Message 1 from Alice');
    expect(userMessages[0]!.username).toBe('Alice');
    expect(userMessages[1]!.text).toBe('Message 2 from Bob');
    expect(userMessages[1]!.username).toBe('Bob');
    expect(userMessages[2]!.text).toBe('Message 3 from Alice');
    expect(userMessages[2]!.username).toBe('Alice');
  });

  it('records system notifications when participants join, leave, or clear canvas', async () => {
    const host = await SocketTestClient.connect(port);
    clients.push(host);
    await host.authenticate('Host');

    host.send(MessageType.CREATE_ROOM, { roomName: 'System Msg Room', username: 'Host' });
    const hostState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = hostState.roomCode;

    // Guest joins
    const guest = await SocketTestClient.connect(port);
    clients.push(guest);
    await guest.authenticate('Guest');

    guest.send(MessageType.JOIN_ROOM, { roomCode, username: 'Guest' });
    await guest.waitFor(MessageType.ROOM_STATE);
    await host.waitFor(MessageType.PARTICIPANT_JOINED);

    // Host clears the canvas
    host.send(MessageType.CLEAR_CANVAS, { op_id: generateUuid() }, { room: roomCode });
    await host.waitFor(MessageType.CLEAR_CANVAS);

    // Guest leaves cleanly
    guest.send(MessageType.LEAVE_ROOM, { reason: 'Finished work' }, { room: roomCode });
    await host.waitFor(MessageType.PARTICIPANT_LEFT);

    // Check room snapshot chat history
    const room = server.roomManager.getRoom(roomCode)!;
    const history = room.getChatHistory();

    const systemMessages = history.filter((m) => m.isSystem);
    expect(systemMessages.some((m) => m.text.includes('Host joined'))).toBe(true);
    expect(systemMessages.some((m) => m.text.includes('Guest joined'))).toBe(true);
    expect(systemMessages.some((m) => m.text.includes('cleared by the room host'))).toBe(true);
    expect(systemMessages.some((m) => m.text.includes('Guest left'))).toBe(true);
  });

  it('bounds chat history to maxChatHistorySize pruning oldest messages', async () => {
    const client = await SocketTestClient.connect(port);
    clients.push(client);
    await client.authenticate('Alice');

    client.send(MessageType.CREATE_ROOM, { roomName: 'Bounded Room', username: 'Alice' });
    const state = (await client.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const room = server.roomManager.getRoom(state.roomCode)!;

    // Set a small limit for test
    room.maxChatHistorySize = 5;

    for (let i = 1; i <= 8; i++) {
      client.send(
        MessageType.CHAT_MESSAGE,
        { id: generateUuid(), text: `Msg #${i}` },
        { room: state.roomCode, user_id: client.userId },
      );
      await client.waitFor(MessageType.CHAT_MESSAGE);
    }

    const history = room.getChatHistory();
    expect(history.length).toBe(5);
    // Messages 1, 2, 3 should have been pruned; 4 through 8 should remain
    expect(history[0]!.text).toBe('Msg #4');
    expect(history[4]!.text).toBe('Msg #8');
  });

  it('allows VIEWER role to send chat messages', async () => {
    const host = await SocketTestClient.connect(port);
    const viewer = await SocketTestClient.connect(port);
    clients.push(host, viewer);

    await host.authenticate('Host');
    await viewer.authenticate('Observer');

    host.send(MessageType.CREATE_ROOM, { roomName: 'Viewer Chat Room', username: 'Host' });
    const hostState = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    const roomCode = hostState.roomCode;

    viewer.send(MessageType.JOIN_ROOM, { roomCode, username: 'Observer' });
    await viewer.waitFor(MessageType.ROOM_STATE);

    // Host demotes viewer to VIEWER
    const room = server.roomManager.getRoom(roomCode)!;
    const viewerParticipant = room.getParticipant(viewer.userId)!;
    viewerParticipant.role = Role.VIEWER;
    const viewerSession = room.getSession(viewer.userId)!;
    viewerSession.role = Role.VIEWER;

    // Viewer sends a chat message
    viewer.send(
      MessageType.CHAT_MESSAGE,
      { id: generateUuid(), text: 'Question from an observer' },
      { room: roomCode, user_id: viewer.userId },
    );

    const received = await host.waitFor(MessageType.CHAT_MESSAGE);
    const payload = received.payload as ChatMessagePayload;
    expect(payload.text).toBe('Question from an observer');
    expect(payload.username).toBe('Observer');
  });

  it('rejects CHAT_MESSAGE sent outside of a room', async () => {
    const client = await SocketTestClient.connect(port);
    clients.push(client);
    await client.authenticate('Rogue');

    client.send(MessageType.CHAT_MESSAGE, {
      id: generateUuid(),
      text: 'Trying to chat before joining a room',
    });

    const errorMsg = await client.waitFor(MessageType.ERROR);
    const payload = errorMsg.payload as { code: string; message: string };
    expect(payload.code).toBe('NOT_IN_ROOM');
  });

  it('responds with CHAT_HISTORY when explicitly requested', async () => {
    const client = await SocketTestClient.connect(port);
    clients.push(client);
    await client.authenticate('Tester');

    client.send(MessageType.CREATE_ROOM, { roomName: 'History Req Room', username: 'Tester' });
    const state = (await client.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;

    client.send(
      MessageType.CHAT_MESSAGE,
      { id: generateUuid(), text: 'Persisted chat 1' },
      { room: state.roomCode, user_id: client.userId },
    );
    await client.waitFor(MessageType.CHAT_MESSAGE);

    // Explicitly request CHAT_HISTORY
    client.send(MessageType.CHAT_HISTORY, {}, { room: state.roomCode });
    const historyMsg = await client.waitFor(MessageType.CHAT_HISTORY);
    const payload = historyMsg.payload as ChatHistoryPayload;

    expect(payload.messages).toBeDefined();
    expect(payload.messages.some((m) => m.text === 'Persisted chat 1')).toBe(true);
  });
});
