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
} from '@cn-whiteboard/common';
import type { WhiteboardServer } from '../src/index.js';
import { closeIsolatedServer, startIsolatedServer } from './helpers/isolated-server.js';

class SecurityTestClient {
  private readonly socket: net.Socket;
  private readonly decoder = new FrameDecoder();
  private readonly queue: MessageEnvelope[] = [];
  public userId = '';
  public sessionId = '';

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on('data', (chunk) => {
      this.queue.push(...this.decoder.feed(chunk));
    });
    this.socket.on('error', () => {
      // Socket resets are expected when a participant is kicked.
    });
  }

  public static connect(port: number): Promise<SecurityTestClient> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => resolve(new SecurityTestClient(socket)));
      socket.once('error', reject);
    });
  }

  public send(
    type: MessageType,
    payload: unknown,
    options?: { room?: string; user_id?: string },
  ): void {
    this.socket.write(encodeFrame(createEnvelope(type, payload, options)));
  }

  public async waitFor(
    predicate: (message: MessageEnvelope) => boolean,
    description: string,
    timeoutMs = 3000,
  ): Promise<MessageEnvelope> {
    const queuedIndex = this.queue.findIndex(predicate);
    if (queuedIndex !== -1) return this.queue.splice(queuedIndex, 1)[0]!;

    return new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        const index = this.queue.findIndex(predicate);
        if (index !== -1) {
          clearInterval(interval);
          clearTimeout(timeout);
          resolve(this.queue.splice(index, 1)[0]!);
        }
      }, 5);
      const timeout = setTimeout(() => {
        clearInterval(interval);
        reject(new Error(`Timed out waiting for ${description}`));
      }, timeoutMs);
    });
  }

  public async authenticate(username: string, sessionToken?: string): Promise<void> {
    this.send(MessageType.HELLO, {
      clientVersion: '0.1.0',
      suggestedUsername: username,
      sessionToken,
    });
    const auth = await this.waitFor((message) => message.type === MessageType.AUTH_OK, 'AUTH_OK');
    const payload = auth.payload as { userId: string; sessionId: string };
    this.userId = payload.userId;
    this.sessionId = payload.sessionId;
  }

  public waitForError(code: string): Promise<MessageEnvelope> {
    return this.waitFor(
      (message) =>
        message.type === MessageType.ERROR && (message.payload as { code?: string }).code === code,
      `ERROR ${code}`,
    );
  }

  public close(): void {
    this.socket.destroy();
  }
}

describe('Security and room roles', () => {
  let server: WhiteboardServer;
  let port: number;
  const clients: SecurityTestClient[] = [];

  beforeEach(async () => {
    const instance = await startIsolatedServer({ host: '127.0.0.1', port: 0 });
    server = instance.server;
    port = instance.port;
  });

  afterEach(async () => {
    for (const client of clients) client.close();
    clients.length = 0;
    await closeIsolatedServer(server);
  });

  async function connect(username: string, sessionToken?: string): Promise<SecurityTestClient> {
    const client = await SecurityTestClient.connect(port);
    clients.push(client);
    await client.authenticate(username, sessionToken);
    return client;
  }

  it('hashes room passwords and rate-limits failed joins by remote IP', async () => {
    const host = await connect('Host');
    host.send(MessageType.CREATE_ROOM, {
      roomName: 'Private room',
      username: 'Host',
      password: 'correct horse',
    });
    const state = (
      await host.waitFor((message) => message.type === MessageType.ROOM_STATE, 'room state')
    ).payload as RoomStatePayload;
    const room = server.roomManager.getRoom(state.roomCode)!;

    expect(room.passwordHash).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
    expect(room.passwordHash).not.toContain('correct horse');
    expect(await server.roomManager.verifyPassword('correct horse', room.passwordHash!)).toBe(true);
    expect(await server.roomManager.verifyPassword('wrong password', room.passwordHash!)).toBe(
      false,
    );
    expect(await server.roomManager.verifyPassword('anything', 'malformed')).toBe(false);

    const guest = await connect('Guest');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      guest.send(MessageType.JOIN_ROOM, {
        roomCode: state.roomCode,
        username: 'Guest',
        password: 'incorrect',
      });
      await guest.waitForError('JOIN_FAILED');
    }

    guest.send(MessageType.JOIN_ROOM, {
      roomCode: state.roomCode,
      username: 'Guest',
      password: 'correct horse',
    });
    const blocked = await guest.waitForError('JOIN_FAILED');
    expect((blocked.payload as { message: string }).message).toContain('Too many failed');
    expect(room.participantCount).toBe(1);
  });

  it('allows a participant to change their name and broadcasts the sequenced update', async () => {
    const host = await connect('Host');
    host.send(MessageType.CREATE_ROOM, {
      roomName: 'Names room',
      username: 'Host',
      allowNameChanges: true,
    });
    const state = (
      await host.waitFor((message) => message.type === MessageType.ROOM_STATE, 'room state')
    ).payload as RoomStatePayload;
    const room = server.roomManager.getRoom(state.roomCode)!;
    expect(state.allowNameChanges).toBe(true);
    expect(room.allowNameChanges).toBe(true);

    const editor = await connect('Editor');
    editor.send(MessageType.JOIN_ROOM, { roomCode: state.roomCode, username: 'Editor' });
    await editor.waitFor((message) => message.type === MessageType.ROOM_STATE, 'editor room state');

    editor.send(
      MessageType.UPDATE_USERNAME,
      { username: '  Sketcher  ' },
      { room: state.roomCode, user_id: editor.userId },
    );
    const [hostUpdate, editorUpdate] = await Promise.all([
      host.waitFor(
        (message) => message.type === MessageType.PARTICIPANT_RENAMED,
        'name update broadcast',
      ),
      editor.waitFor(
        (message) => message.type === MessageType.PARTICIPANT_RENAMED,
        'name update echo',
      ),
    ]);

    expect(hostUpdate.seq).toBe(editorUpdate.seq);
    expect(hostUpdate.payload).toEqual({ userId: editor.userId, username: 'Sketcher' });
    expect(room.getParticipant(editor.userId)?.username).toBe('Sketcher');
    expect(room.getSession(editor.userId)?.username).toBe('Sketcher');
  });

  it('rejects name changes when the host did not enable the room setting', async () => {
    const host = await connect('Host');
    host.send(MessageType.CREATE_ROOM, { roomName: 'Names disabled', username: 'Host' });
    const state = (
      await host.waitFor((message) => message.type === MessageType.ROOM_STATE, 'room state')
    ).payload as RoomStatePayload;
    const room = server.roomManager.getRoom(state.roomCode)!;
    expect(state.allowNameChanges).toBe(false);

    const editor = await connect('Editor');
    editor.send(MessageType.JOIN_ROOM, { roomCode: state.roomCode, username: 'Editor' });
    await editor.waitFor((message) => message.type === MessageType.ROOM_STATE, 'editor room state');
    editor.send(
      MessageType.UPDATE_USERNAME,
      { username: 'Sketcher' },
      { room: state.roomCode, user_id: editor.userId },
    );

    const error = await editor.waitForError('NAME_CHANGE_DISABLED');
    expect((error.payload as { message: string }).message).toContain('disabled');
    expect(room.getParticipant(editor.userId)?.username).toBe('Editor');

    // Host enables name changes dynamically in-room via PERMISSION_CHANGE
    host.send(
      MessageType.PERMISSION_CHANGE,
      { allowNameChanges: true },
      { room: state.roomCode, user_id: host.userId },
    );
    await host.waitFor((message) => message.type === MessageType.PERMISSION_CHANGE, 'enable names');
    await editor.waitFor(
      (message) => message.type === MessageType.PERMISSION_CHANGE,
      'enable names broadcast',
    );
    expect(room.allowNameChanges).toBe(true);

    editor.send(
      MessageType.UPDATE_USERNAME,
      { username: 'RenamedInRoom' },
      { room: state.roomCode, user_id: editor.userId },
    );
    const renamed = await host.waitFor(
      (message) => message.type === MessageType.PARTICIPANT_RENAMED,
      'in-room rename',
    );
    expect(renamed.payload).toEqual({ userId: editor.userId, username: 'RenamedInRoom' });
  });

  it('rejects unauthenticated and viewer mutations and enforces host role, lock, and kick controls', async () => {
    const host = await connect('Host');
    host.send(MessageType.CREATE_ROOM, { roomName: 'Roles room', username: 'Host' });
    const state = (
      await host.waitFor((message) => message.type === MessageType.ROOM_STATE, 'room state')
    ).payload as RoomStatePayload;
    const roomCode = state.roomCode;
    const room = server.roomManager.getRoom(roomCode)!;

    const editor = await connect('Editor');
    editor.send(MessageType.JOIN_ROOM, { roomCode, username: 'Editor' });
    await editor.waitFor((message) => message.type === MessageType.ROOM_STATE, 'editor room state');
    const editorId = editor.userId;

    const unauthenticated = await SecurityTestClient.connect(port);
    clients.push(unauthenticated);
    unauthenticated.send(MessageType.STROKE_BEGIN, {
      op_id: generateUuid(),
      strokeId: generateUuid(),
      color: '#10B981',
      width: 4,
      startPoint: { x: 10, y: 10, pressure: 0.5 },
    });
    const notInRoom = await unauthenticated.waitForError('NOT_IN_ROOM');
    expect((notInRoom.payload as { code: string }).code).toBe('NOT_IN_ROOM');

    editor.send(
      MessageType.PERMISSION_CHANGE,
      { targetUserId: editorId, newRole: Role.VIEWER },
      { room: roomCode, user_id: editorId },
    );
    const forbidden = await editor.waitForError('FORBIDDEN');
    expect((forbidden.payload as { code: string }).code).toBe('FORBIDDEN');

    host.send(
      MessageType.PERMISSION_CHANGE,
      { targetUserId: editorId, newRole: Role.VIEWER },
      { room: roomCode, user_id: host.userId },
    );
    await host.waitFor((message) => message.type === MessageType.PERMISSION_CHANGE, 'role update');
    await editor.waitFor(
      (message) => message.type === MessageType.PERMISSION_CHANGE,
      'role update',
    );
    expect(room.getParticipant(editorId)?.role).toBe(Role.VIEWER);

    host.send(
      MessageType.PERMISSION_CHANGE,
      { targetUserId: editorId, newRole: Role.HOST },
      { room: roomCode, user_id: host.userId },
    );
    await host.waitForError('INVALID_PERMISSION_CHANGE');
    expect(room.getParticipant(editorId)?.role).toBe(Role.VIEWER);

    const stroke = () => ({
      op_id: generateUuid(),
      strokeId: generateUuid(),
      color: '#10B981',
      width: 4,
      startPoint: { x: 10, y: 10, pressure: 0.5 },
    });
    editor.send(MessageType.STROKE_BEGIN, stroke(), { room: roomCode, user_id: editorId });
    await editor.waitForError('FORBIDDEN');
    expect(Object.keys(room.getSnapshot().objects)).toHaveLength(0);

    // Viewers cannot broadcast laser pointer trails either
    editor.send(
      MessageType.CURSOR_MOVE,
      {
        x: 120,
        y: 80,
        activeTool: 'laser',
        points: [
          { x: 110, y: 70 },
          { x: 120, y: 80 },
        ],
      },
      { room: roomCode, user_id: editorId },
    );
    const sanitizedCursor = await host.waitFor(
      (message) => message.type === MessageType.CURSOR_MOVE && message.user_id === editorId,
      'sanitized viewer cursor move',
    );
    expect((sanitizedCursor.payload as { activeTool?: string; points?: unknown }).activeTool).toBe(
      'select',
    );
    expect(
      (sanitizedCursor.payload as { activeTool?: string; points?: unknown }).points,
    ).toBeUndefined();

    host.send(
      MessageType.PERMISSION_CHANGE,
      { targetUserId: editorId, newRole: Role.EDITOR },
      { room: roomCode, user_id: host.userId },
    );
    await host.waitFor((message) => message.type === MessageType.PERMISSION_CHANGE, 'role update');
    await editor.waitFor(
      (message) => message.type === MessageType.PERMISSION_CHANGE,
      'role update',
    );

    host.send(
      MessageType.PERMISSION_CHANGE,
      { lockRoom: true },
      { room: roomCode, user_id: host.userId },
    );
    await host.waitFor((message) => message.type === MessageType.PERMISSION_CHANGE, 'room lock');
    await editor.waitFor((message) => message.type === MessageType.PERMISSION_CHANGE, 'room lock');
    expect(room.locked).toBe(true);

    editor.send(MessageType.STROKE_BEGIN, stroke(), { room: roomCode, user_id: editorId });
    const lockedError = await editor.waitForError('FORBIDDEN');
    expect((lockedError.payload as { message: string }).message).toContain('locked');
    expect(Object.keys(room.getSnapshot().objects)).toHaveLength(0);

    host.send(
      MessageType.PERMISSION_CHANGE,
      { lockRoom: false },
      { room: roomCode, user_id: host.userId },
    );
    await host.waitFor((message) => message.type === MessageType.PERMISSION_CHANGE, 'room unlock');
    await editor.waitFor(
      (message) => message.type === MessageType.PERMISSION_CHANGE,
      'room unlock',
    );

    host.send(
      MessageType.PERMISSION_CHANGE,
      { targetUserId: editorId, kick: true, reason: 'Removed by host' },
      { room: roomCode, user_id: host.userId },
    );
    await host.waitFor((message) => message.type === MessageType.PERMISSION_CHANGE, 'kick event');
    await host.waitFor(
      (message) => message.type === MessageType.PARTICIPANT_LEFT,
      'participant removal',
    );
    expect(room.getParticipant(editorId)).toBeUndefined();
    expect(room.participantCount).toBe(1);

    const reconnect = await connect('Editor', editor.sessionId);
    reconnect.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'Editor', sessionToken: editor.sessionId },
      { room: roomCode, user_id: reconnect.userId },
    );
    const kicked = await reconnect.waitForError('JOIN_FAILED');
    expect((kicked.payload as { message: string }).message).toContain('removed from this room');
  });

  it('assigns new joinees as VIEWER when defaultViewer is enabled', async () => {
    const host = await connect('Host');
    host.send(MessageType.CREATE_ROOM, {
      roomName: 'Lecture Room',
      username: 'Host',
      defaultViewer: true,
    });
    const state = (
      await host.waitFor((message) => message.type === MessageType.ROOM_STATE, 'room state')
    ).payload as RoomStatePayload;
    const room = server.roomManager.getRoom(state.roomCode)!;
    expect(state.defaultViewer).toBe(true);
    expect(room.defaultViewer).toBe(true);

    const student = await connect('Student');
    student.send(MessageType.JOIN_ROOM, { roomCode: state.roomCode, username: 'Student' });
    const studentState = (
      await student.waitFor((message) => message.type === MessageType.ROOM_STATE, 'student state')
    ).payload as RoomStatePayload;
    expect(studentState.participants.find((p) => p.id === student.userId)?.role).toBe(Role.VIEWER);

    // Host toggles defaultViewer off via PERMISSION_CHANGE so subsequent joinees become EDITOR
    host.send(
      MessageType.PERMISSION_CHANGE,
      { defaultViewer: false },
      { room: state.roomCode, user_id: host.userId },
    );
    await host.waitFor(
      (message) => message.type === MessageType.PERMISSION_CHANGE,
      'defaultViewer update',
    );
    expect(room.defaultViewer).toBe(false);

    const coEditor = await connect('CoEditor');
    coEditor.send(MessageType.JOIN_ROOM, { roomCode: state.roomCode, username: 'CoEditor' });
    const editorState = (
      await coEditor.waitFor((message) => message.type === MessageType.ROOM_STATE, 'editor state')
    ).payload as RoomStatePayload;
    expect(editorState.participants.find((p) => p.id === coEditor.userId)?.role).toBe(Role.EDITOR);
  });

  it('allows host to re-admit mistakenly kicked participants and permanently ban users', async () => {
    const host = await connect('Host');
    host.send(MessageType.CREATE_ROOM, { roomName: 'Moderation Room', username: 'Host' });
    const state = (
      await host.waitFor((message) => message.type === MessageType.ROOM_STATE, 'room state')
    ).payload as RoomStatePayload;
    const roomCode = state.roomCode;
    const room = server.roomManager.getRoom(roomCode)!;

    const accidental = await connect('AccidentalGuest');
    accidental.send(MessageType.JOIN_ROOM, { roomCode, username: 'AccidentalGuest' });
    await accidental.waitFor(
      (message) => message.type === MessageType.ROOM_STATE,
      'guest room state',
    );
    const accidentalId = accidental.userId;
    const accidentalSessionId = accidental.sessionId;

    // Host kicks by mistake
    host.send(
      MessageType.PERMISSION_CHANGE,
      { targetUserId: accidentalId, kick: true, reason: 'Clicked wrong user' },
      { room: roomCode, user_id: host.userId },
    );
    await host.waitFor(
      (message) => message.type === MessageType.PERMISSION_CHANGE,
      'kick broadcast',
    );
    await host.waitFor((message) => message.type === MessageType.PARTICIPANT_LEFT, 'kick left');
    expect(room.getRemovedParticipants()).toHaveLength(1);
    expect(room.getRemovedParticipants()[0]?.banned).toBe(false);

    // Blocked while kicked
    const retryWhileKicked = await connect('AccidentalGuest', accidentalSessionId);
    retryWhileKicked.send(
      MessageType.JOIN_ROOM,
      { roomCode, username: 'AccidentalGuest', sessionToken: accidentalSessionId },
      { room: roomCode, user_id: retryWhileKicked.userId },
    );
    await retryWhileKicked.waitForError('JOIN_FAILED');

    // Host allows back
    host.send(
      MessageType.PERMISSION_CHANGE,
      { targetUserId: accidentalId, allowRejoin: true },
      { room: roomCode, user_id: host.userId },
    );
    const allowEvent = await host.waitFor(
      (message) => message.type === MessageType.PERMISSION_CHANGE,
      'allowRejoin broadcast',
    );
    expect((allowEvent.payload as { removedParticipants?: unknown[] }).removedParticipants).toEqual(
      [],
    );

    const rejoined = await connect('AccidentalGuest', accidentalSessionId);
    rejoined.send(MessageType.JOIN_ROOM, {
      roomCode,
      username: 'AccidentalGuest',
      sessionToken: accidentalSessionId,
    });
    await rejoined.waitFor(
      (message) => message.type === MessageType.ROOM_STATE,
      're-admitted ROOM_STATE',
    );
    expect(room.participantCount).toBe(2);

    // Host permanently bans the participant
    const reAdmittedId = rejoined.userId;
    host.send(
      MessageType.PERMISSION_CHANGE,
      { targetUserId: reAdmittedId, ban: true, reason: 'Permanent ban test' },
      { room: roomCode, user_id: host.userId },
    );
    const banEvent = await host.waitFor(
      (message) => message.type === MessageType.PERMISSION_CHANGE,
      'ban broadcast',
    );
    await host.waitFor((message) => message.type === MessageType.PARTICIPANT_LEFT, 'ban left');
    expect(
      (banEvent.payload as { removedParticipants?: Array<{ banned: boolean }> })
        .removedParticipants?.[0]?.banned,
    ).toBe(true);

    // Permanently banned user cannot be allowed back and cannot rejoin even on a fresh session
    host.send(
      MessageType.PERMISSION_CHANGE,
      { targetUserId: reAdmittedId, allowRejoin: true },
      { room: roomCode, user_id: host.userId },
    );
    await host.waitForError('INVALID_PERMISSION_CHANGE');

    const bannedReconnect = await connect('AccidentalGuest');
    bannedReconnect.send(MessageType.JOIN_ROOM, { roomCode, username: 'AccidentalGuest' });
    const banError = await bannedReconnect.waitForError('JOIN_FAILED');
    expect((banError.payload as { message: string }).message).toContain('permanently banned');
  });

  it('allows the host to bulk update roles with setAllRole to VIEWER or EDITOR', async () => {
    const host = await connect('HostAlice');
    host.send(MessageType.CREATE_ROOM, { roomName: 'Bulk Role Room', username: 'HostAlice' });
    const state = (
      await host.waitFor((message) => message.type === MessageType.ROOM_STATE, 'host state')
    ).payload as RoomStatePayload;
    const roomCode = state.roomCode;
    const room = server.roomManager.getRoom(roomCode)!;

    const guest1 = await connect('GuestBob');
    guest1.send(MessageType.JOIN_ROOM, { roomCode, username: 'GuestBob' });
    await guest1.waitFor((message) => message.type === MessageType.ROOM_STATE, 'guest1 state');

    const guest2 = await connect('GuestCarol');
    guest2.send(MessageType.JOIN_ROOM, { roomCode, username: 'GuestCarol' });
    await guest2.waitFor((message) => message.type === MessageType.ROOM_STATE, 'guest2 state');

    expect(room.participantCount).toBe(3);

    // Non-host attempts setAllRole -> rejected FORBIDDEN
    guest1.send(
      MessageType.PERMISSION_CHANGE,
      { setAllRole: Role.VIEWER },
      { room: roomCode, user_id: guest1.userId },
    );
    await guest1.waitForError('FORBIDDEN');

    // Host sets all to VIEWER
    host.send(
      MessageType.PERMISSION_CHANGE,
      { setAllRole: Role.VIEWER },
      { room: roomCode, user_id: host.userId },
    );
    const setViewerMsg = await guest1.waitFor(
      (message) => message.type === MessageType.PERMISSION_CHANGE,
      'setAllRole VIEWER broadcast',
    );
    expect((setViewerMsg.payload as { setAllRole: Role }).setAllRole).toBe(Role.VIEWER);

    // Check roles on room
    const bob = room.getParticipant(guest1.userId)!;
    const carol = room.getParticipant(guest2.userId)!;
    const alice = room.getParticipant(host.userId)!;
    expect(bob.role).toBe(Role.VIEWER);
    expect(carol.role).toBe(Role.VIEWER);
    expect(alice.role).toBe(Role.HOST);

    // Host sets all back to EDITOR
    host.send(
      MessageType.PERMISSION_CHANGE,
      { setAllRole: Role.EDITOR },
      { room: roomCode, user_id: host.userId },
    );
    const setEditorMsg = await guest2.waitFor(
      (message) =>
        message.type === MessageType.PERMISSION_CHANGE &&
        (message.payload as { setAllRole?: Role }).setAllRole === Role.EDITOR,
      'setAllRole EDITOR broadcast',
    );
    expect((setEditorMsg.payload as { setAllRole: Role }).setAllRole).toBe(Role.EDITOR);
    expect(room.getParticipant(guest1.userId)!.role).toBe(Role.EDITOR);
    expect(room.getParticipant(guest2.userId)!.role).toBe(Role.EDITOR);
  });

  it('allows the host to end the session for all participants with endSession', async () => {
    const host = await connect('SessionHost');
    host.send(MessageType.CREATE_ROOM, { roomName: 'Closing Room', username: 'SessionHost' });
    const state = (
      await host.waitFor((message) => message.type === MessageType.ROOM_STATE, 'host state')
    ).payload as RoomStatePayload;
    const roomCode = state.roomCode;

    const guest = await connect('SessionGuest');
    guest.send(MessageType.JOIN_ROOM, { roomCode, username: 'SessionGuest' });
    await guest.waitFor((message) => message.type === MessageType.ROOM_STATE, 'guest state');

    // Non-host attempts endSession -> rejected FORBIDDEN
    guest.send(
      MessageType.PERMISSION_CHANGE,
      { endSession: true },
      { room: roomCode, user_id: guest.userId },
    );
    await guest.waitForError('FORBIDDEN');

    // Host ends session
    host.send(
      MessageType.PERMISSION_CHANGE,
      { endSession: true, reason: 'Meeting concluded' },
      { room: roomCode, user_id: host.userId },
    );

    const endMsg = await guest.waitFor(
      (message) => message.type === MessageType.PERMISSION_CHANGE,
      'endSession broadcast',
    );
    expect((endMsg.payload as { endSession: boolean; reason?: string }).endSession).toBe(true);
    expect((endMsg.payload as { endSession: boolean; reason?: string }).reason).toBe(
      'Meeting concluded',
    );

    // Room should be closed on the server
    expect(server.roomManager.getRoom(roomCode)).toBeUndefined();
  });
});
