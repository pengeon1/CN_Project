import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  encodeFrame,
  FrameDecoder,
  type MessageEnvelope,
  MessageType,
  type Participant,
  type ParticipantJoinedPayload,
  type ParticipantLeftPayload,
  type ParticipantListPayload,
  Role,
  type RoomStatePayload,
} from '@cn-whiteboard/common';
import type { WhiteboardServer } from '../src/index.js';
import { closeIsolatedServer, startIsolatedServer } from './helpers/isolated-server.js';

class SocketTestClient {
  private socket: net.Socket;
  private decoder = new FrameDecoder();
  public queue: MessageEnvelope[] = [];
  private waiters: Array<(msg: MessageEnvelope) => void> = [];

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
    // Check existing queue
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
      }
      this.queue.push(nextMsg);
    }
    throw new Error(`Timeout waiting for ${type}`);
  }

  public close(): void {
    this.socket.destroy();
  }
}

describe('Server Core Integration Suite: Sessions, Rooms & Participants', () => {
  let serverInstance: WhiteboardServer | undefined;
  let serverPort = 0;
  const activeClients: SocketTestClient[] = [];

  beforeEach(async () => {
    const { server, port } = await startIsolatedServer({ host: '127.0.0.1', port: 0 });
    serverInstance = server;
    serverPort = port;
  });

  afterEach(async () => {
    for (const c of activeClients) {
      c.close();
    }
    activeClients.length = 0;

    if (serverInstance) {
      await closeIsolatedServer(serverInstance);
      serverInstance = undefined;
    }
  });

  it('performs protocol handshake and receives AUTH_OK', async () => {
    const client = await SocketTestClient.connect(serverPort);
    activeClients.push(client);

    client.send(MessageType.HELLO, { clientVersion: '0.1.0', suggestedUsername: 'Alice' });

    const authMsg = await client.waitFor(MessageType.AUTH_OK);
    expect(authMsg.type).toBe('AUTH_OK');
    const payload = authMsg.payload as {
      sessionId: string;
      userId: string;
      protocolVersion: number;
    };
    expect(payload.protocolVersion).toBe(1);
    expect(payload.sessionId).toBeDefined();
    expect(payload.userId).toBeDefined();
  });

  it('handles room creation, multi-client joining, and join/leave broadcast events', async () => {
    // 1. Client 1 (Alice) connects and creates room
    const alice = await SocketTestClient.connect(serverPort);
    activeClients.push(alice);
    alice.send(MessageType.HELLO, { clientVersion: '0.1.0', suggestedUsername: 'Alice' });
    const aliceAuth = await alice.waitFor(MessageType.AUTH_OK);
    const aliceUserId = (aliceAuth.payload as { userId: string }).userId;

    alice.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Collab Room', username: 'Alice' },
      { user_id: aliceUserId },
    );

    const roomState1 = await alice.waitFor(MessageType.ROOM_STATE);
    const snapshot1 = roomState1.payload as RoomStatePayload;
    expect(snapshot1.roomCode).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/);
    expect(snapshot1.participants).toHaveLength(1);
    expect(snapshot1.participants[0]!.role).toBe(Role.HOST);
    expect(snapshot1.participants[0]!.username).toBe('Alice');
    const roomCode = snapshot1.roomCode;

    // 2. Client 2 (Bob) connects and joins Alice's room
    const bob = await SocketTestClient.connect(serverPort);
    activeClients.push(bob);
    bob.send(MessageType.HELLO, { clientVersion: '0.1.0', suggestedUsername: 'Bob' });
    const bobAuth = await bob.waitFor(MessageType.AUTH_OK);
    const bobUserId = (bobAuth.payload as { userId: string }).userId;

    bob.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Bob' },
      { room: roomCode, user_id: bobUserId },
    );

    // Bob receives current room state
    const bobRoomState = await bob.waitFor(MessageType.ROOM_STATE);
    const bobSnapshot = bobRoomState.payload as RoomStatePayload;
    expect(bobSnapshot.participants).toHaveLength(2);

    // Alice receives PARTICIPANT_JOINED notification for Bob
    const aliceJoinedNotice = await alice.waitFor(MessageType.PARTICIPANT_JOINED);
    const joinedPayload = aliceJoinedNotice.payload as ParticipantJoinedPayload;
    expect(joinedPayload.participant.username).toBe('Bob');
    expect(joinedPayload.participant.role).toBe(Role.EDITOR);
    // Colors must be distinct
    expect(joinedPayload.participant.color).not.toBe(snapshot1.participants[0]!.color);

    // 3. Client 3 (Charlie) joins
    const charlie = await SocketTestClient.connect(serverPort);
    activeClients.push(charlie);
    charlie.send(MessageType.HELLO, { clientVersion: '0.1.0', suggestedUsername: 'Charlie' });
    const charlieAuth = await charlie.waitFor(MessageType.AUTH_OK);
    const charlieUserId = (charlieAuth.payload as { userId: string }).userId;

    charlie.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Charlie' },
      { room: roomCode, user_id: charlieUserId },
    );

    await charlie.waitFor(MessageType.ROOM_STATE);
    await alice.waitFor(MessageType.PARTICIPANT_JOINED);
    await bob.waitFor(MessageType.PARTICIPANT_JOINED);

    // Verify participant list query
    charlie.send(MessageType.PARTICIPANT_LIST, {}, { room: roomCode, user_id: charlieUserId });
    const listMsg = await charlie.waitFor(MessageType.PARTICIPANT_LIST);
    const participants = (listMsg.payload as ParticipantListPayload).participants;
    expect(participants).toHaveLength(3);
    const usernames = participants.map((p: Participant) => p.username);
    expect(usernames).toContain('Alice');
    expect(usernames).toContain('Bob');
    expect(usernames).toContain('Charlie');

    // 4. Bob leaves room cleanly
    bob.send(
      MessageType.LEAVE_ROOM,
      { reason: 'Lunch break' },
      { room: roomCode, user_id: bobUserId },
    );
    await bob.waitFor(MessageType.ACK);

    // Alice and Charlie receive PARTICIPANT_LEFT
    const aliceLeftNotice = await alice.waitFor(MessageType.PARTICIPANT_LEFT);
    const leftPayloadAlice = aliceLeftNotice.payload as ParticipantLeftPayload;
    expect(leftPayloadAlice.userId).toBe(bobUserId);
    expect(leftPayloadAlice.username).toBe('Bob');

    const charlieLeftNotice = await charlie.waitFor(MessageType.PARTICIPANT_LEFT);
    const leftPayloadCharlie = charlieLeftNotice.payload as ParticipantLeftPayload;
    expect(leftPayloadCharlie.userId).toBe(bobUserId);
  });

  it('enforces password protection on secured rooms', async () => {
    const host = await SocketTestClient.connect(serverPort);
    activeClients.push(host);
    host.send(MessageType.HELLO, { clientVersion: '0.1.0' });
    const hostAuth = await host.waitFor(MessageType.AUTH_OK);
    const hostId = (hostAuth.payload as { userId: string }).userId;

    // Create password-protected room
    host.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Private Room', username: 'HostUser', password: 'secretpassword' },
      { user_id: hostId },
    );
    const stateMsg = await host.waitFor(MessageType.ROOM_STATE);
    const roomCode = (stateMsg.payload as RoomStatePayload).roomCode;

    // Guest tries to join with wrong password
    const guest = await SocketTestClient.connect(serverPort);
    activeClients.push(guest);
    guest.send(MessageType.HELLO, { clientVersion: '0.1.0' });
    const guestAuth = await guest.waitFor(MessageType.AUTH_OK);
    const guestId = (guestAuth.payload as { userId: string }).userId;

    guest.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Guest', password: 'wrongpassword' },
      { room: roomCode, user_id: guestId },
    );

    const errorMsg = await guest.waitFor(MessageType.ERROR);
    expect((errorMsg.payload as { code: string }).code).toBe('JOIN_FAILED');

    // Guest tries to join with correct password
    guest.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Guest', password: 'secretpassword' },
      { room: roomCode, user_id: guestId },
    );

    const successMsg = await guest.waitFor(MessageType.ROOM_STATE);
    expect(successMsg.type).toBe('ROOM_STATE');
  });

  it('increments sequence counter for room events', async () => {
    const client1 = await SocketTestClient.connect(serverPort);
    activeClients.push(client1);
    client1.send(MessageType.HELLO, { clientVersion: '0.1.0' });
    const auth1 = await client1.waitFor(MessageType.AUTH_OK);
    const user1 = (auth1.payload as { userId: string }).userId;

    client1.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Seq Test', username: 'User1' },
      { user_id: user1 },
    );
    const roomState = await client1.waitFor(MessageType.ROOM_STATE);
    const roomCode = (roomState.payload as RoomStatePayload).roomCode;
    expect(roomState.seq).toBe(1);

    // Client 2 joins -> seq 2
    const client2 = await SocketTestClient.connect(serverPort);
    activeClients.push(client2);
    client2.send(MessageType.HELLO, { clientVersion: '0.1.0' });
    const auth2 = await client2.waitFor(MessageType.AUTH_OK);
    const user2 = (auth2.payload as { userId: string }).userId;

    client2.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'User2' },
      { room: roomCode, user_id: user2 },
    );
    const joinedMsg = await client1.waitFor(MessageType.PARTICIPANT_JOINED);
    expect(joinedMsg.seq).toBe(2);
  });
});
