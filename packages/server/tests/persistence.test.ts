import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  encodeFrame,
  FrameDecoder,
  generateUuid,
  type MessageEnvelope,
  MessageType,
  type RoomStatePayload,
} from '@cn-whiteboard/common';
import { startServer, type WhiteboardServer } from '../src/index.js';

class PersistenceTestClient {
  private readonly socket: net.Socket;
  private readonly decoder = new FrameDecoder();
  private readonly messages: MessageEnvelope[] = [];
  private readonly waiters: Array<(message: MessageEnvelope) => void> = [];
  public userId = '';

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on('data', (chunk) => {
      for (const message of this.decoder.feed(chunk)) {
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.messages.push(message);
      }
    });
    this.socket.on('error', () => {
      // Socket resets are expected while tests close their clients and server.
    });
  }

  public static connect(port: number): Promise<PersistenceTestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        resolve(new PersistenceTestClient(socket));
      });
      socket.on('error', reject);
    });
  }

  public send(
    type: MessageType,
    payload: unknown,
    options: { room?: string; user_id?: string } = {},
  ): void {
    this.socket.write(encodeFrame(createEnvelope(type, payload, options)));
  }

  public async waitFor(type: MessageType): Promise<MessageEnvelope> {
    const queuedIndex = this.messages.findIndex((message) => message.type === type);
    if (queuedIndex !== -1) return this.messages.splice(queuedIndex, 1)[0]!;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.waiters.indexOf(waiter);
        if (waiterIndex !== -1) this.waiters.splice(waiterIndex, 1);
        reject(new Error(`Timed out waiting for ${type}`));
      }, 3000);
      const waiter = (message: MessageEnvelope) => {
        clearTimeout(timer);
        if (message.type === type) resolve(message);
        else {
          this.messages.push(message);
          void this.waitFor(type).then(resolve, reject);
        }
      };
      this.waiters.push(waiter);
    });
  }

  public async authenticate(username: string): Promise<void> {
    this.send(MessageType.HELLO, { clientVersion: '0.1.0', suggestedUsername: username });
    const message = await this.waitFor(MessageType.AUTH_OK);
    this.userId = (message.payload as { userId: string }).userId;
  }

  public close(): void {
    this.socket.destroy();
  }
}

describe('Room persistence', () => {
  let server: WhiteboardServer | undefined;
  let dataDir = '';
  const clients: PersistenceTestClient[] = [];

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    if (server) {
      await server.close();
      server = undefined;
    }
    if (dataDir) {
      await fs.rm(dataDir, { recursive: true, force: true });
      dataDir = '';
    }
  });

  async function createTempDataDir(): Promise<string> {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-whiteboard-persistence-'));
    return dataDir;
  }

  async function createHost(
    port: number,
  ): Promise<{ client: PersistenceTestClient; roomCode: string }> {
    const client = await PersistenceTestClient.connect(port);
    clients.push(client);
    await client.authenticate('Host');
    client.send(
      MessageType.CREATE_ROOM,
      { roomName: 'Persistent Board', username: 'Host' },
      { user_id: client.userId },
    );
    const roomState = (await client.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    return { client, roomCode: roomState.roomCode };
  }

  it('autosaves room state and restores the board after a server restart', async () => {
    const dir = await createTempDataDir();
    const first = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir });
    server = first.server;
    const { client: host, roomCode } = await createHost(first.port);
    const room = server.roomManager.getRoom(roomCode)!;
    const strokeId = generateUuid();
    await room.enqueue(() =>
      room.applyStrokeBegin(generateUuid(), strokeId, host.userId, '#10B981', 4, {
        x: 100,
        y: 120,
        pressure: 0.5,
      }),
    );
    await room.enqueue(() => room.applyStrokeEnd(generateUuid(), strokeId));

    const filePath = path.join(dir, `${roomCode}.json`);
    let persistedContent: string | null = null;
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try {
        persistedContent = await fs.readFile(filePath, 'utf8');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(persistedContent).not.toBeNull();
    const persisted = JSON.parse(persistedContent!) as {
      objects: Record<string, unknown>;
    };
    expect(persisted.objects[strokeId]).toBeDefined();

    await server.close();
    server = undefined;
    host.close();

    const restarted = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir });
    server = restarted.server;
    const rejoiningClient = await PersistenceTestClient.connect(restarted.port);
    clients.push(rejoiningClient);
    await rejoiningClient.authenticate('Returning user');
    rejoiningClient.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Returning user' },
      { room: roomCode, user_id: rejoiningClient.userId },
    );

    const restored = (await rejoiningClient.waitFor(MessageType.ROOM_STATE))
      .payload as RoomStatePayload;
    expect(restored.roomCode).toBe(roomCode);
    expect(restored.objects[strokeId]).toMatchObject({
      id: strokeId,
      type: 'stroke',
      isComplete: true,
    });
  });

  it('allows only the host to save and load a persisted room', async () => {
    const dir = await createTempDataDir();
    const instance = await startServer({ host: '127.0.0.1', port: 0, dataDir: dir });
    server = instance.server;
    const { client: host, roomCode } = await createHost(instance.port);
    const room = server.roomManager.getRoom(roomCode)!;
    const strokeId = generateUuid();
    await room.enqueue(() =>
      room.applyStrokeBegin(generateUuid(), strokeId, host.userId, '#10B981', 4, {
        x: 100,
        y: 120,
      }),
    );

    host.send(MessageType.SAVE_STATE, {}, { room: roomCode, user_id: host.userId });
    expect(await host.waitFor(MessageType.SAVE_STATE)).toMatchObject({
      type: MessageType.SAVE_STATE,
      payload: { filename: `${roomCode}.json` },
    });

    await room.enqueue(() => room.clearCanvas(generateUuid(), host.userId));
    host.send(MessageType.LOAD_STATE, {}, { room: roomCode, user_id: host.userId });
    const loadedSnapshot = (await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    expect(loadedSnapshot.objects[strokeId]).toBeDefined();
    expect(await host.waitFor(MessageType.LOAD_STATE)).toMatchObject({
      type: MessageType.LOAD_STATE,
      payload: { filename: `${roomCode}.json` },
    });

    const editor = await PersistenceTestClient.connect(instance.port);
    clients.push(editor);
    await editor.authenticate('Editor');
    editor.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Editor' },
      { room: roomCode, user_id: editor.userId },
    );
    await editor.waitFor(MessageType.ROOM_STATE);
    editor.send(MessageType.SAVE_STATE, {}, { room: roomCode, user_id: editor.userId });
    expect(await editor.waitFor(MessageType.ERROR)).toMatchObject({
      payload: { code: 'FORBIDDEN' },
    });
    editor.send(MessageType.LOAD_STATE, {}, { room: roomCode, user_id: editor.userId });
    expect(await editor.waitFor(MessageType.ERROR)).toMatchObject({
      payload: { code: 'FORBIDDEN' },
    });
  });
});
