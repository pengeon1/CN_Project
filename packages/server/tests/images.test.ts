/**
 * @fileoverview Phase 13: chunked image upload, validation, sequenced IMAGE_ADD, late-join fetch
 * and role enforcement, over real TCP sockets.
 */

import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  encodeFrame,
  FrameDecoder,
  generateUuid,
  IMAGE_CHUNK_BYTES,
  type MessageEnvelope,
  MessageType,
  Role,
  type RoomStatePayload,
} from '@cn-whiteboard/common';
import type { WhiteboardServer } from '../src/index.js';
import { closeIsolatedServer, startIsolatedServer } from './helpers/isolated-server.js';

class Client {
  queue: MessageEnvelope[] = [];
  userId = '';
  private decoder = new FrameDecoder();
  private waiters: Array<() => void> = [];
  constructor(public socket: net.Socket) {
    socket.on('data', (c) => {
      this.queue.push(...this.decoder.feed(c));
      this.waiters.splice(0).forEach((w) => w());
    });
    socket.on('error', () => undefined);
  }
  static async connect(port: number): Promise<Client> {
    return new Promise((res) => {
      const s = net.createConnection({ port, host: '127.0.0.1' }, () => res(new Client(s)));
    });
  }
  send(type: MessageType, payload: unknown, room?: string): void {
    this.socket.write(encodeFrame(createEnvelope(type, payload, { user_id: this.userId, room })));
  }
  async waitFor(type: MessageType, ms = 3000): Promise<MessageEnvelope> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.queue.findIndex((m) => m.type === type);
      if (i >= 0) return this.queue.splice(i, 1)[0]!;
      if (Date.now() > end) throw new Error(`Timeout waiting for ${type}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  async hello(name: string): Promise<void> {
    this.send(MessageType.HELLO, { clientVersion: '0.1.0', suggestedUsername: name });
    this.userId = (await this.waitFor(MessageType.AUTH_OK)).payload.userId as string;
  }
}

/** A tiny but signature-valid PNG padded to span several chunks. */
function fakePng(size: number): Buffer {
  const b = Buffer.alloc(size, 7);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(b);
  return b;
}

function chunks(bytes: Buffer, assetId: string, mime = 'image/png') {
  const total = Math.ceil(bytes.length / IMAGE_CHUNK_BYTES);
  return Array.from({ length: total }, (_, index) => ({
    assetId,
    mime,
    index,
    total,
    data: bytes
      .subarray(index * IMAGE_CHUNK_BYTES, (index + 1) * IMAGE_CHUNK_BYTES)
      .toString('base64'),
  }));
}

function imageObject(assetId: string, bytes: number) {
  return {
    id: generateUuid(),
    authorId: generateUuid(),
    seq: 0,
    zIndex: 0,
    updatedAt: Date.now(),
    type: 'image',
    assetId,
    mime: 'image/png',
    bytes,
    x: 10,
    y: 20,
    width: 200,
    height: 100,
  };
}

describe('Image sync (Phase 13)', () => {
  let server: WhiteboardServer;
  let port: number;
  const clients: Client[] = [];

  beforeEach(async () => {
    const i = await startIsolatedServer({ host: '127.0.0.1', port: 0 });
    server = i.server;
    port = i.port;
  });
  afterEach(async () => {
    clients.splice(0).forEach((c) => c.socket.destroy());
    await closeIsolatedServer(server);
  });

  async function setup() {
    const host = await Client.connect(port);
    clients.push(host);
    await host.hello('Host');
    host.send(MessageType.CREATE_ROOM, { roomName: 'Img', username: 'Host' });
    const code = ((await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload)
      .roomCode;
    return { host, code };
  }

  async function join(code: string, name: string): Promise<Client> {
    const c = await Client.connect(port);
    clients.push(c);
    await c.hello(name);
    c.send(MessageType.JOIN_ROOM, { roomCode: code, username: name }, code);
    await c.waitFor(MessageType.ROOM_STATE);
    return c;
  }

  it('assembles a multi-chunk upload, broadcasts a sequenced IMAGE_ADD and serves it to a late joiner', async () => {
    const { host, code } = await setup();
    const early = await join(code, 'Early');

    const png = fakePng(IMAGE_CHUNK_BYTES * 2 + 1000); // 3 chunks
    const assetId = generateUuid();
    for (const c of chunks(png, assetId)) host.send(MessageType.IMAGE_UPLOAD, c, code);
    host.send(
      MessageType.IMAGE_ADD,
      { op_id: generateUuid(), object: imageObject(assetId, png.length) },
      code,
    );

    const added = await early.waitFor(MessageType.IMAGE_ADD);
    const obj = (added.payload as { object: { authorId: string; assetId: string; seq: number } })
      .object;
    expect(obj.authorId).toBe(host.userId); // server-assigned authorship
    expect(obj.seq).toBe(added.seq);

    // Late joiner sees the object in the snapshot and can fetch the bytes in chunks.
    const late = await Client.connect(port);
    clients.push(late);
    await late.hello('Late');
    late.send(MessageType.JOIN_ROOM, { roomCode: code, username: 'Late' }, code);
    const state = (await late.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    expect(Object.values(state.objects).some((o) => o.type === 'image')).toBe(true);

    late.send(MessageType.IMAGE_REQUEST, { assetId }, code);
    const parts: string[] = [];
    let total = 1;
    while (parts.length < total) {
      const m = await late.waitFor(MessageType.IMAGE_DATA);
      const p = m.payload as { index: number; total: number; data: string };
      total = p.total;
      parts[p.index] = p.data;
    }
    expect(Buffer.from(parts.join(''), 'base64').equals(png)).toBe(true);
  });

  it('rejects IMAGE_ADD without an upload and bytes whose signature does not match', async () => {
    const { host, code } = await setup();
    host.send(
      MessageType.IMAGE_ADD,
      { op_id: generateUuid(), object: imageObject(generateUuid(), 100) },
      code,
    );
    const ack = await host.waitFor(MessageType.ACK);
    expect((ack.payload as { status: string }).status).toBe('rejected');

    const bad = Buffer.alloc(500, 1); // not a PNG
    const assetId = generateUuid();
    for (const c of chunks(bad, assetId)) host.send(MessageType.IMAGE_UPLOAD, c, code);
    expect(((await host.waitFor(MessageType.ERROR)).payload as { code: string }).code).toBe(
      'IMAGE_REJECTED',
    );
    host.send(
      MessageType.IMAGE_ADD,
      { op_id: generateUuid(), object: imageObject(assetId, 500) },
      code,
    );
    expect(((await host.waitFor(MessageType.ACK)).payload as { status: string }).status).toBe(
      'rejected',
    );
  });

  it('lets viewers fetch images but never upload or add them', async () => {
    const { host, code } = await setup();
    const viewer = await join(code, 'Viewer');
    host.send(
      MessageType.PERMISSION_CHANGE,
      { targetUserId: viewer.userId, newRole: Role.VIEWER },
      code,
    );
    await viewer.waitFor(MessageType.PERMISSION_CHANGE);

    const png = fakePng(300);
    const assetId = generateUuid();
    for (const c of chunks(png, assetId)) viewer.send(MessageType.IMAGE_UPLOAD, c, code);
    await viewer.waitFor(MessageType.ERROR);
    expect(server.roomManager.getRoom(code)!.getAsset(assetId)).toBeUndefined();

    for (const c of chunks(png, assetId)) host.send(MessageType.IMAGE_UPLOAD, c, code);
    host.send(
      MessageType.IMAGE_ADD,
      { op_id: generateUuid(), object: imageObject(assetId, 300) },
      code,
    );
    await viewer.waitFor(MessageType.IMAGE_ADD);
    viewer.send(MessageType.IMAGE_REQUEST, { assetId }, code);
    expect((await viewer.waitFor(MessageType.IMAGE_DATA)).payload.assetId).toBe(assetId);
  });
});
