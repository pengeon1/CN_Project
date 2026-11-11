/**
 * @fileoverview Phase 14: host-driven presentation, and named/automatic version history with
 * host-only restore.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateUuid,
  type MessageEnvelope,
  MessageType,
  Role,
  type RoomStatePayload,
  type ShapeObject,
  type VersionMeta,
} from '@cn-whiteboard/common';
import type { WhiteboardServer } from '../src/index.js';
import { Room } from '../src/room.js';
import { Client } from './helpers/socket-client.js';
import { closeIsolatedServer, startIsolatedServer } from './helpers/isolated-server.js';

const rect = (): ShapeObject => ({
  id: generateUuid(),
  authorId: generateUuid(),
  seq: 0,
  zIndex: 0,
  updatedAt: Date.now(),
  type: 'shape',
  shapeType: 'rectangle',
  x: 0,
  y: 0,
  width: 50,
  height: 50,
  strokeColor: '#000000',
  strokeWidth: 2,
});

describe('version history (room)', () => {
  it('restores an earlier board, keeps an undoable "before" copy and resets undo history', () => {
    const user = generateUuid();
    const room = new Room('ABC234', 'r', user);
    const a = room.applyShapeAdd(generateUuid(), rect(), user)!;
    const v1 = room.addVersion('First draft', user, false);
    const b = room.applyShapeAdd(generateUuid(), rect(), user)!;
    expect(room.getSnapshot().objects[b.id]).toBeDefined();

    expect(room.restoreVersion(v1.id)?.name).toBe('First draft');
    const objs = room.getSnapshot().objects;
    expect(Object.keys(objs)).toEqual([a.id]);

    const names = room.listVersions().map((v) => v.name);
    expect(names[0]).toContain('Before restoring');
    expect(room.listVersions().find((v) => v.name.startsWith('Before'))?.objectCount).toBe(2);
    expect(room.restoreVersion(generateUuid())).toBeNull();
    expect(room.applyUndo(generateUuid(), generateUuid(), user).accepted).toBe(false);
  });

  it('auto-snapshots only after the interval and only when the board changed', () => {
    const user = generateUuid();
    const room = new Room('ABC234', 'r', user);
    room.versionIntervalMs = 0;
    expect(room.maybeAutoSnapshot()).toBeNull(); // nothing changed yet
    room.applyShapeAdd(generateUuid(), rect(), user);
    room.applyShapeAdd(generateUuid(), rect(), user); // 2nd edit triggers snapshot of dirty board
    expect(room.listVersions().some((v) => v.auto)).toBe(true);

    const idle = new Room('ABC234', 'r', user);
    idle.versionIntervalMs = 10 * 60_000;
    idle.applyShapeAdd(generateUuid(), rect(), user);
    idle.applyShapeAdd(generateUuid(), rect(), user);
    expect(idle.listVersions()).toHaveLength(0);
  });

  it('caps stored versions and evicts automatic ones before named ones', () => {
    const user = generateUuid();
    const room = new Room('ABC234', 'r', user);
    const keep = room.addVersion('Milestone', user, false);
    for (let i = 0; i < 30; i++) room.addVersion(`auto ${i}`, null, true);
    const list = room.listVersions();
    expect(list).toHaveLength(20);
    expect(list.some((v) => v.id === keep.id)).toBe(true);
  });
});

describe('presentation and version messages (sockets)', () => {
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
    host.send(MessageType.CREATE_ROOM, { roomName: 'X', username: 'Host' });
    const code = ((await host.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload)
      .roomCode;
    const guest = await Client.connect(port);
    clients.push(guest);
    await guest.hello('Guest');
    guest.send(MessageType.JOIN_ROOM, { roomCode: code, username: 'Guest' }, code);
    await guest.waitFor(MessageType.ROOM_STATE);
    return { host, guest, code };
  }

  it('relays host viewport to others, rejects non-hosts, and tells late joiners', async () => {
    const { host, guest, code } = await setup();
    const view = { active: true, viewport: { x: 120, y: -40, zoom: 1.5 } };

    guest.send(MessageType.PRESENTATION, view, code);
    expect(
      ((await guest.waitFor(MessageType.ERROR)).payload as { code: string }).code,
    ).toBeTruthy();

    host.send(MessageType.PRESENTATION, view, code);
    const got = await guest.waitFor(MessageType.PRESENTATION);
    expect(got.payload).toEqual(view);
    expect(got.seq).toBe(0); // unsequenced

    const late = await Client.connect(port);
    clients.push(late);
    await late.hello('Late');
    late.send(MessageType.JOIN_ROOM, { roomCode: code, username: 'Late' }, code);
    const state = (await late.waitFor(MessageType.ROOM_STATE)).payload as RoomStatePayload;
    expect(state.presentation).toEqual(view);

    host.send(MessageType.PRESENTATION, { active: false }, code);
    expect((await guest.waitFor(MessageType.PRESENTATION)).payload).toEqual({ active: false });
  });

  it('ends the presentation for everyone when the presenter disconnects', async () => {
    const { host, guest, code } = await setup();
    host.send(MessageType.PRESENTATION, { active: true, viewport: { x: 0, y: 0, zoom: 1 } }, code);
    await guest.waitFor(MessageType.PRESENTATION);
    host.socket.destroy();
    const ended = await guest.waitFor(MessageType.PRESENTATION, 4000);
    expect(ended.payload).toEqual({ active: false });
  });

  it('saves, lists and restores versions for the host only, converging every client', async () => {
    const { host, guest, code } = await setup();

    guest.send(MessageType.VERSION_SAVE, { name: 'nope' }, code);
    await guest.waitFor(MessageType.ERROR);

    host.send(MessageType.SHAPE_ADD, { op_id: generateUuid(), object: rect() }, code);
    await guest.waitFor(MessageType.SHAPE_ADD);
    host.send(MessageType.VERSION_SAVE, { name: 'One shape' }, code);
    const list = (await host.waitFor(MessageType.VERSION_LIST)).payload as {
      versions: VersionMeta[];
    };
    expect(list.versions[0]).toMatchObject({ name: 'One shape', objectCount: 1, auto: false });

    host.send(MessageType.SHAPE_ADD, { op_id: generateUuid(), object: rect() }, code);
    await guest.waitFor(MessageType.SHAPE_ADD);

    host.send(MessageType.VERSION_RESTORE, { versionId: list.versions[0]!.id }, code);
    const snap: MessageEnvelope = await guest.waitFor(MessageType.ROOM_STATE);
    expect(Object.keys((snap.payload as RoomStatePayload).objects)).toHaveLength(1);
    expect(server.roomManager.getRoom(code)!.getSnapshot().objects).toBeDefined();

    guest.send(MessageType.VERSION_RESTORE, { versionId: list.versions[0]!.id }, code);
    await guest.waitFor(MessageType.ERROR);
    host.send(MessageType.VERSION_RESTORE, { versionId: generateUuid() }, code);
    expect(((await host.waitFor(MessageType.ERROR)).payload as { code: string }).code).toBe(
      'VERSION_NOT_FOUND',
    );
    expect(Role.HOST).toBeDefined();
  });
});
