import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createEnvelope,
  generateUuid,
  MessageType,
  type ResyncResponsePayload,
  Role,
  type RoomSnapshot,
  type RoomStatePayload,
  type SequencedOperation,
  type StrokeObject,
  type WhiteboardObject,
} from '@cn-whiteboard/common';
import {
  applySequencedOpToObjects,
  consumeRemoteLaserPoints,
  useWhiteboardStore,
} from '../src/store/useWhiteboardStore.js';
import { PropertyBarContent } from '../src/components/layout/PropertyBar.js';
import { isEditableElement, TOOL_SHORTCUTS } from '../src/hooks/useKeyboardShortcuts.js';
import { shouldDismissOnOutsideEvent } from '../src/hooks/useClickOutside.js';
import type { ElectronWhiteboardAPI } from '../src/types/ipc.js';

describe('Client UI & Store Suite', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    // Reset store to initial state
    useWhiteboardStore.setState({
      connectionStatus: 'disconnected',
      connectionError: null,
      roomInfo: null,
      persistenceStatus: null,
      accessNotice: null,
      currentUser: null,
      participants: [],
      chatMessages: [],
      unreadChatCount: 0,
      undoStack: [],
      redoStack: [],
      activeTool: 'pen',
      zoom: 1.0,
      panX: 0,
      panY: 0,
      rightPanelOpen: true,
      rightPanelTab: 'chat',
      shareModalOpen: false,
      connectModalOpen: false,
      profileSettingsOpen: false,
      isDarkTheme: false,
      objects: {},
      liveLocalStroke: null,
      remoteCursors: {},
      lastAppliedSeq: 0,
      searchOpen: false,
      loadModalOpen: false,
      selectedIds: [],
      activeTextEditor: null,
      textEditRequestId: null,
      textEditCommitCount: 0,
    });
  });

  it('initializes with default tool and viewport settings', () => {
    const state = useWhiteboardStore.getState();
    expect(state.activeTool).toBe('pen');
    expect(state.zoom).toBe(1.0);
    expect(state.panX).toBe(0);
    expect(state.panY).toBe(0);
    expect(state.rightPanelOpen).toBe(true);
  });

  it('updates active tool and tool properties', () => {
    const { setActiveTool, setToolProps } = useWhiteboardStore.getState();

    setActiveTool('rectangle');
    expect(useWhiteboardStore.getState().activeTool).toBe('rectangle');

    setToolProps({ color: '#EF4444', width: 8, fill: true });
    expect(useWhiteboardStore.getState().toolProps.color).toBe('#EF4444');
    expect(useWhiteboardStore.getState().toolProps.width).toBe(8);
    expect(useWhiteboardStore.getState().toolProps.fill).toBe(true);
  });

  it('clamps zoom factors cleanly within bounds', () => {
    const { setZoom, resetView } = useWhiteboardStore.getState();

    setZoom(1.5);
    expect(useWhiteboardStore.getState().zoom).toBe(1.5);

    // Over upper bound -> clamped to 5.0
    setZoom(10.0);
    expect(useWhiteboardStore.getState().zoom).toBe(5.0);

    // Under lower bound -> clamped to 0.1
    setZoom(0.01);
    expect(useWhiteboardStore.getState().zoom).toBe(0.1);

    resetView();
    expect(useWhiteboardStore.getState().zoom).toBe(1.0);
  });

  it('handles ROOM_STATE incoming envelope to synchronize room and user data', () => {
    const { handleIncomingEnvelope } = useWhiteboardStore.getState();
    const myId = generateUuid();

    const snapshot: RoomStatePayload = {
      roomCode: 'TEST99',
      roomName: 'Sprint Planning',
      seq: 12,
      objects: {},
      participants: [
        {
          id: myId,
          username: 'Alice',
          role: Role.HOST,
          color: '#18A0FB',
          joinedAt: Date.now(),
        },
      ],
      chatHistory: [],
      locked: false,
      createdAt: Date.now(),
    };

    const envelope = createEnvelope(MessageType.ROOM_STATE, snapshot, {
      room: 'TEST99',
      user_id: myId,
      seq: 12,
    });

    handleIncomingEnvelope(envelope);

    const state = useWhiteboardStore.getState();
    expect(state.connectionStatus).toBe('connected');
    expect(state.roomInfo?.code).toBe('TEST99');
    expect(state.roomInfo?.isHost).toBe(true);
    expect(state.currentUser?.username).toBe('Alice');
    expect(state.participants).toHaveLength(1);
  });

  it('exports the current room snapshot through the Electron bridge', async () => {
    const snapshots: RoomSnapshot[] = [];
    const api: ElectronWhiteboardAPI = {
      platform: 'test',
      connect: async () => ({ success: true }),
      disconnect: async () => undefined,
      sendMessage: async () => true,
      onMessage: () => () => undefined,
      onStatus: () => () => undefined,
      exportBoard: async (snapshot) => {
        snapshots.push(snapshot);
        return { success: true, filePath: '/tmp/Planning.json' };
      },
    };
    vi.stubGlobal('window', { electronAPI: api });
    useWhiteboardStore.setState({
      roomInfo: { code: 'TEST23', name: 'Planning', isHost: true, locked: false, createdAt: 123 },
      lastAppliedSeq: 7,
    });

    await useWhiteboardStore.getState().exportBoard();

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({
      roomCode: 'TEST23',
      roomName: 'Planning',
      seq: 7,
      createdAt: 123,
      objects: {},
    });
    expect(useWhiteboardStore.getState().persistenceStatus).toBe('Exported /tmp/Planning.json');
  });

  it('updates participant list and emits chat notice on PARTICIPANT_JOINED and PARTICIPANT_LEFT', () => {
    const { handleIncomingEnvelope } = useWhiteboardStore.getState();
    const bobId = generateUuid();

    // Bob joins
    handleIncomingEnvelope(
      createEnvelope(
        MessageType.PARTICIPANT_JOINED,
        {
          participant: {
            id: bobId,
            username: 'Bob',
            role: Role.EDITOR,
            color: '#10B981',
            joinedAt: Date.now(),
          },
        },
        { room: 'TEST99', user_id: bobId },
      ),
    );

    let state = useWhiteboardStore.getState();
    expect(state.participants).toHaveLength(1);
    expect(state.participants[0]!.username).toBe('Bob');
    expect(state.chatMessages).toHaveLength(1);
    expect(state.chatMessages[0]!.isSystem).toBe(true);
    expect(state.chatMessages[0]!.text).toContain('Bob joined the whiteboard');

    // Bob leaves
    handleIncomingEnvelope(
      createEnvelope(
        MessageType.PARTICIPANT_LEFT,
        {
          userId: bobId,
          username: 'Bob',
          reason: 'Network disconnection',
        },
        { room: 'TEST99', user_id: bobId },
      ),
    );

    state = useWhiteboardStore.getState();
    expect(state.participants).toHaveLength(0);
    expect(state.chatMessages).toHaveLength(2);
    expect(state.chatMessages[1]!.text).toContain('Bob left the session');
  });

  it('notifies a participant when changed to viewer and switches to the select tool', () => {
    const userId = generateUuid();
    useWhiteboardStore.setState({
      currentUser: { id: userId, username: 'Alice', color: '#18A0FB', role: Role.EDITOR },
      roomInfo: { code: 'VIEW01', name: 'Board', isHost: false, locked: false },
      participants: [
        {
          id: userId,
          username: 'Alice',
          role: Role.EDITOR,
          color: '#18A0FB',
          joinedAt: Date.now(),
        },
      ],
      activeTool: 'pen',
      lastAppliedSeq: 0,
    });

    useWhiteboardStore
      .getState()
      .handleIncomingEnvelope(
        createEnvelope(
          MessageType.PERMISSION_CHANGE,
          { targetUserId: userId, newRole: Role.VIEWER },
          { room: 'VIEW01', user_id: userId, seq: 1 },
        ),
      );

    const state = useWhiteboardStore.getState();
    expect(state.currentUser?.role).toBe(Role.VIEWER);
    expect(state.participants[0]?.role).toBe(Role.VIEWER);
    expect(state.activeTool).toBe('select');
    expect(state.accessNotice).toMatchObject({ title: 'View-only access' });

    state.setActiveTool('pen');
    expect(useWhiteboardStore.getState().activeTool).toBe('select');
    state.setActiveTool('eraser');
    expect(useWhiteboardStore.getState().activeTool).toBe('select');
  });

  it('updates participant names and broadcasts the name-change request', async () => {
    const userId = generateUuid();
    const sendMessage = vi.fn().mockResolvedValue(true);
    const api: ElectronWhiteboardAPI = {
      platform: 'test',
      connect: async () => ({ success: true }),
      disconnect: async () => undefined,
      sendMessage,
      onMessage: () => () => undefined,
      onStatus: () => () => undefined,
      exportBoard: async () => ({ success: true }),
    };
    vi.stubGlobal('window', { electronAPI: api });
    useWhiteboardStore.setState({
      currentUser: { id: userId, username: 'Alice', color: '#18A0FB', role: Role.HOST },
      roomInfo: {
        code: 'NAME01',
        name: 'Board',
        isHost: true,
        locked: false,
        allowNameChanges: true,
      },
      participants: [
        {
          id: userId,
          username: 'Alice',
          role: Role.HOST,
          color: '#18A0FB',
          joinedAt: Date.now(),
        },
      ],
      profileSettingsOpen: true,
    });

    useWhiteboardStore.getState().updateUsername('  Sketcher  ');
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.UPDATE_USERNAME,
        payload: { username: 'Sketcher' },
      }),
    );
    expect(useWhiteboardStore.getState().profileSettingsOpen).toBe(false);

    useWhiteboardStore
      .getState()
      .handleIncomingEnvelope(
        createEnvelope(
          MessageType.PARTICIPANT_RENAMED,
          { userId, username: 'Sketcher' },
          { room: 'NAME01', user_id: userId, seq: 1 },
        ),
      );
    const state = useWhiteboardStore.getState();
    expect(state.currentUser?.username).toBe('Sketcher');
    expect(state.participants[0]?.username).toBe('Sketcher');
    expect(state.chatMessages.at(-1)?.text).toContain('changed their name to Sketcher');
  });

  it('disconnects and clears room state when kicked while keeping a notice visible', async () => {
    const userId = generateUuid();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    const api: ElectronWhiteboardAPI = {
      platform: 'test',
      connect: async () => ({ success: true }),
      disconnect,
      sendMessage: async () => true,
      onMessage: () => () => undefined,
      onStatus: () => () => undefined,
      exportBoard: async () => ({ success: true }),
    };
    vi.stubGlobal('window', { electronAPI: api });
    useWhiteboardStore.setState({
      currentUser: { id: userId, username: 'Alice', color: '#18A0FB', role: Role.EDITOR },
      roomInfo: { code: 'KICK01', name: 'Board', isHost: false, locked: false },
      participants: [],
      chatMessages: [],
      objects: {},
      activeTool: 'pen',
      lastAppliedSeq: 0,
    });

    useWhiteboardStore
      .getState()
      .handleIncomingEnvelope(
        createEnvelope(
          MessageType.PERMISSION_CHANGE,
          { targetUserId: userId, kick: true, reason: 'Policy violation' },
          { room: 'KICK01', user_id: userId, seq: 1 },
        ),
      );
    await Promise.resolve();

    const state = useWhiteboardStore.getState();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(state.connectionStatus).toBe('disconnected');
    expect(state.roomInfo).toBeNull();
    expect(state.currentUser).toBeNull();
    expect(state.accessNotice).toMatchObject({
      title: 'Removed from the room',
      message: expect.stringContaining('Policy violation'),
    });
  });

  it('manages local stroke drawing lifecycle optimistically', () => {
    const store = useWhiteboardStore.getState();
    const myId = generateUuid();

    // Set authenticated user
    useWhiteboardStore.setState({
      currentUser: { id: myId, username: 'Alice', color: '#18A0FB', role: Role.HOST },
      roomInfo: { code: 'DRAW01', name: 'Board', isHost: true, locked: false },
    });

    // 1. Start drawing
    store.startDrawing({ x: 50, y: 50, pressure: 0.5 });
    let state = useWhiteboardStore.getState();
    expect(state.liveLocalStroke).not.toBeNull();
    expect(state.liveLocalStroke?.points).toHaveLength(1);
    expect(state.liveLocalStroke?.isComplete).toBe(false);

    // 2. Append points
    store.updateLocalLivePoint({ x: 60, y: 60, pressure: 0.6 });
    state = useWhiteboardStore.getState();
    expect(state.liveLocalStroke?.points).toHaveLength(2);

    // 3. Finish drawing
    const strokeId = state.liveLocalStroke!.id;
    store.finishDrawing({ x: 70, y: 70, pressure: 0.5 });

    state = useWhiteboardStore.getState();
    expect(state.liveLocalStroke).toBeNull();
    expect(state.objects[strokeId]).toBeDefined();
    expect((state.objects[strokeId] as { isComplete: boolean }).isComplete).toBe(true);
    expect((state.objects[strokeId] as { points: unknown[] }).points).toHaveLength(3);
  });

  it('applies sequenced undo and redo effects to the visible canvas', () => {
    const userId = generateUuid();
    const strokeId = generateUuid();
    const targetOpId = generateUuid();
    const stroke: StrokeObject = {
      id: strokeId,
      authorId: userId,
      seq: 1,
      zIndex: 1,
      updatedAt: Date.now(),
      type: 'stroke',
      color: '#18A0FB',
      width: 3,
      points: [{ x: 10, y: 20 }],
      isComplete: true,
    };

    useWhiteboardStore.setState({
      currentUser: { id: userId, username: 'Alice', color: '#18A0FB', role: Role.HOST },
      roomInfo: { code: 'UNDO01', name: 'Undo test', isHost: true, locked: false },
      objects: { [strokeId]: stroke },
      undoStack: [targetOpId],
    });

    const { handleIncomingEnvelope } = useWhiteboardStore.getState();
    handleIncomingEnvelope(
      createEnvelope(
        MessageType.UNDO,
        {
          op_id: generateUuid(),
          target_op_id: targetOpId,
          removeIds: [strokeId],
          restoreObjects: [],
        },
        { room: 'UNDO01', user_id: userId, seq: 1 },
      ),
    );

    let state = useWhiteboardStore.getState();
    expect(state.objects[strokeId]).toBeUndefined();
    expect(state.undoStack).toEqual([]);
    expect(state.redoStack).toEqual([targetOpId]);

    handleIncomingEnvelope(
      createEnvelope(
        MessageType.REDO,
        {
          op_id: generateUuid(),
          target_op_id: targetOpId,
          removeIds: [],
          restoreObjects: [stroke],
        },
        { room: 'UNDO01', user_id: userId, seq: 2 },
      ),
    );

    state = useWhiteboardStore.getState();
    expect(state.objects[strokeId]).toEqual(stroke);
    expect(state.redoStack).toEqual([]);
    expect(state.undoStack).toEqual([targetOpId]);
  });

  it('synchronizes incoming remote strokes and remote cursors', () => {
    const store = useWhiteboardStore.getState();
    const remoteUserId = generateUuid();
    const strokeId = generateUuid();

    useWhiteboardStore.setState({
      participants: [
        {
          id: remoteUserId,
          username: 'Charlie',
          role: Role.EDITOR,
          color: '#8B5CF6',
          joinedAt: Date.now(),
        },
      ],
    });

    // Remote STROKE_BEGIN
    store.handleIncomingEnvelope(
      createEnvelope(
        MessageType.STROKE_BEGIN,
        {
          op_id: generateUuid(),
          strokeId,
          color: '#8B5CF6',
          width: 4,
          startPoint: { x: 200, y: 300 },
        },
        { room: 'ROOM1', user_id: remoteUserId, seq: 10 },
      ),
    );

    let state = useWhiteboardStore.getState();
    expect(state.objects[strokeId]).toBeDefined();
    expect(state.objects[strokeId]?.authorId).toBe(remoteUserId);
    expect(state.lastAppliedSeq).toBe(10);

    // Remote STROKE_POINTS
    store.handleIncomingEnvelope(
      createEnvelope(
        MessageType.STROKE_POINTS,
        {
          op_id: generateUuid(),
          strokeId,
          points: [
            { x: 210, y: 310 },
            { x: 220, y: 320 },
          ],
        },
        { room: 'ROOM1', user_id: remoteUserId, seq: 11 },
      ),
    );

    state = useWhiteboardStore.getState();
    const stroke = state.objects[strokeId] as { points: unknown[]; seq: number };
    expect(stroke.points).toHaveLength(3);
    expect(stroke.seq).toBe(11);

    // Remote CURSOR_MOVE
    store.handleIncomingEnvelope(
      createEnvelope(
        MessageType.CURSOR_MOVE,
        { x: 225, y: 325, activeTool: 'pen' },
        { room: 'ROOM1', user_id: remoteUserId, seq: 0 },
      ),
    );

    state = useWhiteboardStore.getState();
    expect(state.remoteCursors[remoteUserId]).toBeDefined();
    expect(state.remoteCursors[remoteUserId]?.username).toBe('Charlie');
    expect(state.remoteCursors[remoteUserId]?.x).toBe(225);
    expect(state.remoteCursors[remoteUserId]?.color).toBe('#8B5CF6');

    // Remote participant leaves -> cursor is cleaned up
    store.handleIncomingEnvelope(
      createEnvelope(
        MessageType.PARTICIPANT_LEFT,
        { userId: remoteUserId, username: 'Charlie' },
        { room: 'ROOM1', user_id: remoteUserId },
      ),
    );

    state = useWhiteboardStore.getState();
    expect(state.remoteCursors[remoteUserId]).toBeUndefined();
  });

  it('erases objects locally and applies incoming ERASE network envelopes', () => {
    const store = useWhiteboardStore.getState();
    const strokeId1 = generateUuid();
    const strokeId2 = generateUuid();

    // Populate objects
    useWhiteboardStore.setState({
      currentUser: { id: 'u1', username: 'Alice', color: '#10B981', role: Role.EDITOR },
      roomInfo: { code: 'ERAS01', name: 'Board', isHost: false, locked: false },
      objects: {
        [strokeId1]: {
          id: strokeId1,
          authorId: 'u1',
          seq: 1,
          zIndex: 1,
          updatedAt: Date.now(),
          type: 'stroke',
          color: '#10B981',
          width: 3,
          points: [{ x: 10, y: 10 }],
          isComplete: true,
        },
        [strokeId2]: {
          id: strokeId2,
          authorId: 'u2',
          seq: 2,
          zIndex: 2,
          updatedAt: Date.now(),
          type: 'stroke',
          color: '#3B82F6',
          width: 3,
          points: [{ x: 20, y: 20 }],
          isComplete: true,
        },
      },
    });

    // 1. Local erase
    store.eraseObjects([strokeId1]);
    let state = useWhiteboardStore.getState();
    expect(state.objects[strokeId1]).toBeUndefined();
    expect(state.objects[strokeId2]).toBeDefined();

    // 2. Incoming remote ERASE
    store.handleIncomingEnvelope(
      createEnvelope(
        MessageType.ERASE,
        { op_id: generateUuid(), objectIds: [strokeId2] },
        { room: 'ERAS01', user_id: 'u2', seq: 15 },
      ),
    );

    state = useWhiteboardStore.getState();
    expect(state.objects[strokeId2]).toBeUndefined();
    expect(state.lastAppliedSeq).toBe(15);
  });

  it('restricts clearCanvas to HOST and synchronizes CLEAR_CANVAS envelope', () => {
    const store = useWhiteboardStore.getState();
    const strokeId = generateUuid();

    // Non-host attempts clearCanvas
    useWhiteboardStore.setState({
      currentUser: { id: 'u2', username: 'Bob', color: '#3B82F6', role: Role.EDITOR },
      roomInfo: { code: 'CLR01', name: 'Board', isHost: false, locked: false },
      objects: {
        [strokeId]: {
          id: strokeId,
          authorId: 'u1',
          seq: 1,
          zIndex: 1,
          updatedAt: Date.now(),
          type: 'stroke',
          color: '#10B981',
          width: 3,
          points: [{ x: 10, y: 10 }],
          isComplete: true,
        },
      },
    });

    store.clearCanvas();
    let state = useWhiteboardStore.getState();
    // Non-host cannot clear
    expect(state.objects[strokeId]).toBeDefined();

    // Promoted to HOST -> clears canvas
    useWhiteboardStore.setState({
      currentUser: { id: 'u1', username: 'Alice', color: '#10B981', role: Role.HOST },
      roomInfo: { code: 'CLR01', name: 'Board', isHost: true, locked: false },
    });

    store.clearCanvas();
    state = useWhiteboardStore.getState();
    expect(state.objects).toEqual({});

    // Incoming CLEAR_CANVAS adds system notice and clears state
    useWhiteboardStore.setState({
      objects: {
        [strokeId]: {
          id: strokeId,
          authorId: 'u1',
          seq: 1,
          zIndex: 1,
          updatedAt: Date.now(),
          type: 'stroke',
          color: '#10B981',
          width: 3,
          points: [{ x: 10, y: 10 }],
          isComplete: true,
        },
      },
    });

    store.handleIncomingEnvelope(
      createEnvelope(
        MessageType.CLEAR_CANVAS,
        { op_id: generateUuid() },
        { room: 'CLR01', user_id: 'host-id', seq: 20 },
      ),
    );

    state = useWhiteboardStore.getState();
    expect(state.objects).toEqual({});
    expect(state.lastAppliedSeq).toBe(20);
    expect(state.chatMessages[state.chatMessages.length - 1]!.text).toContain(
      'cleared by the room host',
    );
  });

  it('maps keyboard hotkeys to whiteboard tools correctly', () => {
    expect(TOOL_SHORTCUTS['v']).toBe('select');
    expect(TOOL_SHORTCUTS['V']).toBe('select');
    expect(TOOL_SHORTCUTS['p']).toBe('pen');
    expect(TOOL_SHORTCUTS['P']).toBe('pen');
    expect(TOOL_SHORTCUTS['e']).toBe('eraser');
    expect(TOOL_SHORTCUTS['E']).toBe('eraser');
    expect(TOOL_SHORTCUTS['r']).toBe('rectangle');
    expect(TOOL_SHORTCUTS['R']).toBe('rectangle');
    expect(TOOL_SHORTCUTS['o']).toBe('ellipse');
    expect(TOOL_SHORTCUTS['O']).toBe('ellipse');
    expect(TOOL_SHORTCUTS['t']).toBe('text');
    expect(TOOL_SHORTCUTS['T']).toBe('text');
    expect(TOOL_SHORTCUTS['s']).toBe('sticky_note');
    expect(TOOL_SHORTCUTS['S']).toBe('sticky_note');
    expect(TOOL_SHORTCUTS['l']).toBe('arrow');
    expect(TOOL_SHORTCUTS['L']).toBe('arrow');
    expect(TOOL_SHORTCUTS['x']).toBe('connector');
    expect(TOOL_SHORTCUTS['X']).toBe('connector');
    expect(TOOL_SHORTCUTS['c']).toBe('connector');
    expect(TOOL_SHORTCUTS['C']).toBe('connector');
  });

  it('detects editable form elements to prevent hotkey hijacking while typing', () => {
    expect(isEditableElement(null)).toBe(false);
    expect(isEditableElement({} as unknown as EventTarget)).toBe(false);
    expect(isEditableElement({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isEditableElement({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isEditableElement({ tagName: 'textarea' } as unknown as EventTarget)).toBe(true);
    expect(isEditableElement({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(
      isEditableElement({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
  });

  describe('Late-Join & Resync Store Synchronization (Phase 6)', () => {
    it('applies sequenced operations to objects dictionary during incremental replay', () => {
      const objects: Record<string, WhiteboardObject> = {};
      const strokeId = generateUuid();
      const authorId = generateUuid();

      // 1. STROKE_BEGIN
      const beginOp: SequencedOperation = {
        op_id: generateUuid(),
        seq: 1,
        userId: authorId,
        type: MessageType.STROKE_BEGIN,
        payload: {
          op_id: generateUuid(),
          strokeId,
          color: '#18A0FB',
          width: 4,
          startPoint: { x: 5, y: 10 },
        },
        ts: 1000,
      };
      applySequencedOpToObjects(objects, beginOp);
      expect(objects[strokeId]).toBeDefined();
      expect((objects[strokeId] as StrokeObject).points.length).toBe(1);
      expect((objects[strokeId] as StrokeObject).isComplete).toBe(false);

      // 2. STROKE_POINTS
      const pointsOp: SequencedOperation = {
        op_id: generateUuid(),
        seq: 2,
        userId: authorId,
        type: MessageType.STROKE_POINTS,
        payload: {
          op_id: generateUuid(),
          strokeId,
          points: [{ x: 15, y: 20 }],
        },
        ts: 1050,
      };
      applySequencedOpToObjects(objects, pointsOp);
      expect((objects[strokeId] as StrokeObject).points.length).toBe(2);

      // 3. STROKE_END
      const endOp: SequencedOperation = {
        op_id: generateUuid(),
        seq: 3,
        userId: authorId,
        type: MessageType.STROKE_END,
        payload: {
          op_id: generateUuid(),
          strokeId,
          finalPoint: { x: 25, y: 30 },
        },
        ts: 1100,
      };
      applySequencedOpToObjects(objects, endOp);
      expect((objects[strokeId] as StrokeObject).points.length).toBe(3);
      expect((objects[strokeId] as StrokeObject).isComplete).toBe(true);

      // 4. ERASE
      const eraseOp: SequencedOperation = {
        op_id: generateUuid(),
        seq: 4,
        userId: authorId,
        type: MessageType.ERASE,
        payload: {
          op_id: generateUuid(),
          objectIds: [strokeId],
        },
        ts: 1150,
      };
      applySequencedOpToObjects(objects, eraseOp);
      expect(objects[strokeId]).toBeUndefined();
    });

    it('hydrates store completely when receiving RESYNC_RESPONSE with fullSnapshot', () => {
      const strokeId = generateUuid();
      const snapshot: RoomStatePayload = {
        roomCode: 'SNAP01',
        roomName: 'Snapshot Room',
        seq: 42,
        objects: {
          [strokeId]: {
            id: strokeId,
            authorId: 'user-1',
            seq: 40,
            zIndex: 1,
            updatedAt: Date.now(),
            type: 'stroke',
            color: '#10B981',
            width: 3,
            points: [
              { x: 10, y: 10 },
              { x: 20, y: 20 },
            ],
            isComplete: true,
          },
        },
        participants: [
          {
            id: 'user-1',
            username: 'Alice',
            role: Role.HOST,
            color: '#10B981',
            joinedAt: Date.now(),
          },
        ],
        chatHistory: [],
        locked: false,
        createdAt: Date.now(),
      };

      const resyncPayload: ResyncResponsePayload = {
        from_seq: 0,
        to_seq: 42,
        fullSnapshot: snapshot,
      };

      useWhiteboardStore.getState().handleIncomingEnvelope(
        createEnvelope(MessageType.RESYNC_RESPONSE, resyncPayload, {
          room: 'SNAP01',
          user_id: 'user-2',
          seq: 42,
        }),
      );

      const state = useWhiteboardStore.getState();
      expect(state.objects[strokeId]).toBeDefined();
      expect(state.lastAppliedSeq).toBe(42);
      expect(state.participants.length).toBe(1);
    });

    it('replays operations incrementally when receiving RESYNC_RESPONSE with operations array', () => {
      useWhiteboardStore.setState({ lastAppliedSeq: 10, objects: {} });
      const strokeId = generateUuid();

      const ops: SequencedOperation[] = [
        {
          op_id: generateUuid(),
          seq: 11,
          userId: 'user-1',
          type: MessageType.STROKE_BEGIN,
          payload: {
            op_id: generateUuid(),
            strokeId,
            color: '#3B82F6',
            width: 2,
            startPoint: { x: 50, y: 50 },
          },
          ts: 2000,
        },
        {
          op_id: generateUuid(),
          seq: 12,
          userId: 'user-1',
          type: MessageType.STROKE_END,
          payload: {
            op_id: generateUuid(),
            strokeId,
          },
          ts: 2050,
        },
      ];

      useWhiteboardStore
        .getState()
        .handleIncomingEnvelope(
          createEnvelope(
            MessageType.RESYNC_RESPONSE,
            { from_seq: 11, to_seq: 12, operations: ops },
            { room: 'ROOM1', user_id: 'user-1', seq: 12 },
          ),
        );

      const state = useWhiteboardStore.getState();
      expect(state.objects[strokeId]).toBeDefined();
      expect((state.objects[strokeId] as StrokeObject).isComplete).toBe(true);
      expect(state.lastAppliedSeq).toBe(12);
    });
  });

  describe('Group Chat & Presence Badging (Phase 7)', () => {
    it('increments unreadChatCount when CHAT_MESSAGE arrives and panel is closed', () => {
      const store = useWhiteboardStore.getState();
      store.setRightPanelOpen(false);

      const msgId = generateUuid();
      const senderId = generateUuid();

      store.handleIncomingEnvelope(
        createEnvelope(
          MessageType.CHAT_MESSAGE,
          {
            id: msgId,
            text: 'Hey everyone, check the top right corner!',
            username: 'Bob',
            color: '#3B82F6',
            ts: Date.now(),
          },
          {
            room: 'CHAT01',
            user_id: senderId,
            seq: 15,
          },
        ),
      );

      const state = useWhiteboardStore.getState();
      expect(state.chatMessages).toHaveLength(1);
      expect(state.chatMessages[0]!.text).toBe('Hey everyone, check the top right corner!');
      expect(state.unreadChatCount).toBe(1);

      // Opening the panel resets unread count
      state.setRightPanelOpen(true);
      expect(useWhiteboardStore.getState().unreadChatCount).toBe(0);
    });

    it('tracks unreadChatCount when panel is open on participants tab and resets on switching to chat', () => {
      const store = useWhiteboardStore.getState();
      store.setRightPanelOpen(true);
      store.setRightPanelTab('participants');

      store.handleIncomingEnvelope(
        createEnvelope(
          MessageType.CHAT_MESSAGE,
          {
            id: generateUuid(),
            text: 'Notice while on participants tab',
            username: 'Alice',
            color: '#EF4444',
          },
          { room: 'CHAT01', user_id: generateUuid(), seq: 16 },
        ),
      );

      expect(useWhiteboardStore.getState().unreadChatCount).toBe(1);

      // Switching tab to 'chat' clears the unread badge
      useWhiteboardStore.getState().setRightPanelTab('chat');
      expect(useWhiteboardStore.getState().unreadChatCount).toBe(0);
    });

    it('deduplicates incoming CHAT_MESSAGE by message ID', () => {
      const store = useWhiteboardStore.getState();
      store.setRightPanelOpen(true);
      store.setRightPanelTab('chat');

      const dupId = generateUuid();
      const senderId = generateUuid();
      const envelope = createEnvelope(
        MessageType.CHAT_MESSAGE,
        {
          id: dupId,
          text: 'Duplicate test message',
          username: 'Charlie',
          color: '#10B981',
        },
        { room: 'CHAT01', user_id: senderId, seq: 17 },
      );

      store.handleIncomingEnvelope(envelope);
      store.handleIncomingEnvelope(envelope); // Duplicate delivery

      const state = useWhiteboardStore.getState();
      expect(state.chatMessages.filter((m) => m.id === dupId)).toHaveLength(1);
    });

    it('hydrates store messages when CHAT_HISTORY is received', () => {
      const store = useWhiteboardStore.getState();
      const msg1Id = generateUuid();
      const msg2Id = generateUuid();

      store.handleIncomingEnvelope(
        createEnvelope(
          MessageType.CHAT_HISTORY,
          {
            messages: [
              {
                id: msg1Id,
                userId: generateUuid(),
                username: 'Host',
                color: '#EF4444',
                text: 'Welcome to the room',
                ts: 1000,
              },
              {
                id: msg2Id,
                userId: generateUuid(),
                username: 'Editor',
                color: '#3B82F6',
                text: 'Thanks!',
                ts: 2000,
              },
            ],
          },
          { room: 'CHAT01', user_id: 'server', seq: 5 },
        ),
      );

      const state = useWhiteboardStore.getState();
      expect(state.chatMessages.some((m) => m.id === msg1Id)).toBe(true);
      expect(state.chatMessages.some((m) => m.id === msg2Id)).toBe(true);
    });
  });

  describe('Idempotent event application (Phase 8)', () => {
    const remoteId = generateUuid();

    const begin = (strokeId: string, seq: number, userId = remoteId) =>
      createEnvelope(
        MessageType.STROKE_BEGIN,
        {
          op_id: generateUuid(),
          strokeId,
          color: '#8B5CF6',
          width: 4,
          startPoint: { x: 0, y: 0 },
        },
        { room: 'ROOM1', user_id: userId, seq },
      );

    const points = (
      strokeId: string,
      seq: number,
      batch: Array<{ x: number; y: number }>,
      startIndex?: number,
      userId = remoteId,
    ) =>
      createEnvelope(
        MessageType.STROKE_POINTS,
        { op_id: generateUuid(), strokeId, points: batch, startIndex },
        { room: 'ROOM1', user_id: userId, seq },
      );

    const strokeOf = (id: string) => useWhiteboardStore.getState().objects[id] as StrokeObject;

    it('applies stroke point batches idempotently by their authoritative index', () => {
      const { handleIncomingEnvelope } = useWhiteboardStore.getState();
      const strokeId = generateUuid();

      handleIncomingEnvelope(begin(strokeId, 10));
      handleIncomingEnvelope(
        points(
          strokeId,
          11,
          [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
          1,
        ),
      );
      expect(strokeOf(strokeId).points).toHaveLength(3);

      // The same batch delivered again under a later seq (e.g. replayed by a resync).
      handleIncomingEnvelope(
        points(
          strokeId,
          12,
          [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
          1,
        ),
      );
      expect(strokeOf(strokeId).points).toHaveLength(3);

      // A batch that overlaps what we already have contributes only its new tail.
      handleIncomingEnvelope(
        points(
          strokeId,
          13,
          [
            { x: 2, y: 2 },
            { x: 3, y: 3 },
          ],
          2,
        ),
      );
      expect(strokeOf(strokeId).points.map((p) => p.x)).toEqual([0, 1, 2, 3]);
    });

    it('ignores sequenced events that were already applied', () => {
      const { handleIncomingEnvelope } = useWhiteboardStore.getState();
      const strokeId = generateUuid();

      handleIncomingEnvelope(begin(strokeId, 10));
      const batch = points(strokeId, 11, [{ x: 1, y: 1 }]);
      handleIncomingEnvelope(batch);
      handleIncomingEnvelope(batch); // duplicate delivery
      expect(strokeOf(strokeId).points).toHaveLength(2);

      // A stale event (older than what was applied) must not undo newer state.
      handleIncomingEnvelope(
        createEnvelope(
          MessageType.ERASE,
          { op_id: generateUuid(), objectIds: [strokeId] },
          { room: 'ROOM1', user_id: remoteId, seq: 9 },
        ),
      );
      expect(useWhiteboardStore.getState().objects[strokeId]).toBeDefined();
      expect(useWhiteboardStore.getState().lastAppliedSeq).toBe(11);
    });

    it('tracks lastAppliedSeq across every kind of sequenced event', () => {
      const { handleIncomingEnvelope } = useWhiteboardStore.getState();
      const peerId = generateUuid();

      handleIncomingEnvelope(
        createEnvelope(
          MessageType.PARTICIPANT_JOINED,
          {
            participant: {
              id: peerId,
              username: 'Dana',
              role: Role.EDITOR,
              color: '#F59E0B',
              joinedAt: Date.now(),
            },
          },
          { room: 'ROOM1', user_id: peerId, seq: 5 },
        ),
      );
      expect(useWhiteboardStore.getState().lastAppliedSeq).toBe(5);

      handleIncomingEnvelope(
        createEnvelope(
          MessageType.CHAT_MESSAGE,
          { id: generateUuid(), text: 'hi', username: 'Dana', color: '#F59E0B' },
          { room: 'ROOM1', user_id: peerId, seq: 6 },
        ),
      );
      expect(useWhiteboardStore.getState().lastAppliedSeq).toBe(6);

      handleIncomingEnvelope(
        createEnvelope(
          MessageType.PARTICIPANT_LEFT,
          { userId: peerId, username: 'Dana' },
          { room: 'ROOM1', user_id: peerId, seq: 7 },
        ),
      );
      expect(useWhiteboardStore.getState().lastAppliedSeq).toBe(7);
    });

    it('keeps the stroke being drawn authoritative while echoes of it arrive', () => {
      const store = useWhiteboardStore.getState();
      const myId = generateUuid();
      useWhiteboardStore.setState({
        currentUser: { id: myId, username: 'Alice', color: '#18A0FB', role: Role.HOST },
        roomInfo: { code: 'DRAW01', name: 'Board', isHost: true, locked: false },
      });

      store.startDrawing({ x: 0, y: 0 });
      store.updateLocalLivePoint({ x: 1, y: 1 });
      store.updateLocalLivePoint({ x: 2, y: 2 });
      const strokeId = useWhiteboardStore.getState().liveLocalStroke!.id;

      // The server echoes the beginning of the stroke while the user is still drawing it.
      store.handleIncomingEnvelope(begin(strokeId, 5, myId));
      store.handleIncomingEnvelope(points(strokeId, 6, [{ x: 1, y: 1 }], 1, myId));

      const state = useWhiteboardStore.getState();
      expect(state.objects[strokeId]).toBeUndefined();
      expect(state.liveLocalStroke?.points).toHaveLength(3);
      expect(state.lastAppliedSeq).toBe(6);
    });

    it('does not duplicate points when the echoes of an optimistically drawn stroke arrive', () => {
      const store = useWhiteboardStore.getState();
      const myId = generateUuid();
      useWhiteboardStore.setState({
        currentUser: { id: myId, username: 'Alice', color: '#18A0FB', role: Role.HOST },
        roomInfo: { code: 'DRAW01', name: 'Board', isHost: true, locked: false },
      });

      store.startDrawing({ x: 0, y: 0 });
      store.updateLocalLivePoint({ x: 1, y: 1 });
      const strokeId = useWhiteboardStore.getState().liveLocalStroke!.id;
      store.finishDrawing({ x: 2, y: 2 }); // local copy: 3 points, complete
      expect(strokeOf(strokeId).points).toHaveLength(3);

      // Echoes of the three operations the server applied for it.
      store.handleIncomingEnvelope(begin(strokeId, 5, myId));
      store.handleIncomingEnvelope(points(strokeId, 6, [{ x: 1, y: 1 }], 1, myId));
      store.handleIncomingEnvelope(
        createEnvelope(
          MessageType.STROKE_END,
          { op_id: generateUuid(), strokeId, finalPoint: { x: 2, y: 2 }, startIndex: 2 },
          { room: 'DRAW01', user_id: myId, seq: 7 },
        ),
      );

      const stroke = strokeOf(strokeId);
      expect(stroke.points.map((p) => p.x)).toEqual([0, 1, 2]);
      expect(stroke.isComplete).toBe(true);
      expect(stroke.seq).toBe(7);
    });

    it('refills a stroke from the outbox flow when a snapshot replaced the local copy', () => {
      const store = useWhiteboardStore.getState();
      const myId = generateUuid();
      useWhiteboardStore.setState({
        currentUser: { id: myId, username: 'Alice', color: '#18A0FB', role: Role.HOST },
        roomInfo: { code: 'DRAW01', name: 'Board', isHost: true, locked: false },
      });

      // The server's snapshot knows the stroke with only its first point.
      const strokeId = generateUuid();
      store.handleIncomingEnvelope(begin(strokeId, 5, myId));
      expect(strokeOf(strokeId).points).toHaveLength(1);

      // Operations retransmitted after a reconnect are echoed with their authoritative indices.
      store.handleIncomingEnvelope(
        points(
          strokeId,
          6,
          [
            { x: 1, y: 1 },
            { x: 2, y: 2 },
          ],
          1,
          myId,
        ),
      );
      store.handleIncomingEnvelope(points(strokeId, 7, [{ x: 3, y: 3 }], 3, myId));

      expect(strokeOf(strokeId).points.map((p) => p.x)).toEqual([0, 1, 2, 3]);
    });

    it('does not abort the stroke being drawn when a snapshot arrives (reconnect)', () => {
      const store = useWhiteboardStore.getState();
      const myId = generateUuid();
      useWhiteboardStore.setState({
        currentUser: { id: myId, username: 'Alice', color: '#18A0FB', role: Role.HOST },
        roomInfo: { code: 'DRAW01', name: 'Board', isHost: true, locked: false },
      });
      store.startDrawing({ x: 0, y: 0 });
      store.updateLocalLivePoint({ x: 1, y: 1 });

      store.handleIncomingEnvelope(
        createEnvelope(
          MessageType.ROOM_STATE,
          {
            roomCode: 'DRAW01',
            roomName: 'Board',
            seq: 20,
            objects: {},
            participants: [
              {
                id: myId,
                username: 'Alice',
                role: Role.HOST,
                color: '#18A0FB',
                joinedAt: Date.now(),
              },
            ],
            chatHistory: [],
            locked: false,
            createdAt: Date.now(),
          } satisfies RoomStatePayload,
          { room: 'DRAW01', user_id: myId, seq: 20 },
        ),
      );

      const state = useWhiteboardStore.getState();
      expect(state.liveLocalStroke).not.toBeNull();
      expect(state.liveLocalStroke?.points).toHaveLength(2);
      expect(state.lastAppliedSeq).toBe(20);
    });

    it('applies PERMISSION_CHANGE so a promoted host sees host controls', () => {
      const myId = generateUuid();
      const otherId = generateUuid();
      useWhiteboardStore.setState({
        currentUser: { id: myId, username: 'Bob', color: '#3B82F6', role: Role.EDITOR },
        roomInfo: { code: 'PERM01', name: 'Board', isHost: false, locked: false },
        participants: [
          { id: myId, username: 'Bob', role: Role.EDITOR, color: '#3B82F6', joinedAt: 1 },
          { id: otherId, username: 'Alice', role: Role.HOST, color: '#10B981', joinedAt: 0 },
        ],
      });

      useWhiteboardStore
        .getState()
        .handleIncomingEnvelope(
          createEnvelope(
            MessageType.PERMISSION_CHANGE,
            { targetUserId: myId, newRole: Role.HOST },
            { room: 'PERM01', user_id: myId, seq: 30 },
          ),
        );

      const state = useWhiteboardStore.getState();
      expect(state.currentUser?.role).toBe(Role.HOST);
      expect(state.roomInfo?.isHost).toBe(true);
      expect(state.participants.find((p) => p.id === myId)?.role).toBe(Role.HOST);
      expect(state.lastAppliedSeq).toBe(30);
    });

    it('merges chat it was missing from a snapshot resync without dropping local messages', () => {
      const localId = generateUuid();
      const missedId = generateUuid();
      useWhiteboardStore.setState({
        chatMessages: [
          {
            id: localId,
            userId: 'u1',
            username: 'Alice',
            color: '#10B981',
            text: 'already here',
            ts: 1000,
          },
        ],
      });

      useWhiteboardStore.getState().handleIncomingEnvelope(
        createEnvelope(
          MessageType.RESYNC_RESPONSE,
          {
            from_seq: 0,
            to_seq: 9,
            fullSnapshot: {
              roomCode: 'SNAP02',
              roomName: 'Snapshot Room',
              seq: 9,
              objects: {},
              participants: [],
              chatHistory: [
                {
                  id: localId,
                  userId: 'u1',
                  username: 'Alice',
                  color: '#10B981',
                  text: 'already here',
                  ts: 1000,
                },
                {
                  id: missedId,
                  userId: 'u2',
                  username: 'Bob',
                  color: '#3B82F6',
                  text: 'you missed this',
                  ts: 2000,
                },
              ],
              locked: false,
              createdAt: Date.now(),
            } satisfies RoomStatePayload,
          },
          { room: 'SNAP02', user_id: 'u1', seq: 9 },
        ),
      );

      const chat = useWhiteboardStore.getState().chatMessages;
      expect(chat.map((m) => m.id)).toEqual([localId, missedId]);
    });

    it('toggles search dialog state and focuses canvas objects', () => {
      const store = useWhiteboardStore.getState();
      expect(store.searchOpen).toBe(false);

      store.setSearchOpen(true);
      expect(useWhiteboardStore.getState().searchOpen).toBe(true);

      const testShapeId = generateUuid();
      useWhiteboardStore.setState({
        objects: {
          [testShapeId]: {
            id: testShapeId,
            type: 'shape',
            shapeType: 'sticky_note',
            x: 500,
            y: 300,
            width: 160,
            height: 160,
            strokeColor: '#F59E0B',
            strokeWidth: 2,
            text: 'Meeting notes',
            authorId: 'u1',
            createdAt: Date.now(),
          },
        },
        zoom: 1.0,
      });

      useWhiteboardStore.getState().focusObject(testShapeId);

      const updated = useWhiteboardStore.getState();
      expect(updated.searchOpen).toBe(false);
      expect(updated.selectedIds).toEqual([testShapeId]);
      expect(updated.activeTool).toBe('select');
      // Center of 500+80=580, 300+80=380. Check pan shifted towards object
      expect(typeof updated.panX).toBe('number');
      expect(typeof updated.panY).toBe('number');
    });

    it('toggles load previous save dialog state', () => {
      const store = useWhiteboardStore.getState();
      expect(store.loadModalOpen).toBe(false);

      store.setLoadModalOpen(true);
      expect(useWhiteboardStore.getState().loadModalOpen).toBe(true);

      store.setLoadModalOpen(false);
      expect(useWhiteboardStore.getState().loadModalOpen).toBe(false);
    });

    it('toggles keyboard shortcuts dialog state', () => {
      const store = useWhiteboardStore.getState();
      expect(store.shortcutsModalOpen).toBe(false);

      store.setShortcutsModalOpen(true);
      expect(useWhiteboardStore.getState().shortcutsModalOpen).toBe(true);

      store.setShortcutsModalOpen(false);
      expect(useWhiteboardStore.getState().shortcutsModalOpen).toBe(false);
    });

    it('buffers batched remote laser vertices without dropping intermediate points', () => {
      const peerId = generateUuid();
      useWhiteboardStore.setState({
        participants: [
          {
            id: peerId,
            username: 'LaserPeer',
            role: Role.EDITOR,
            color: '#EF4444',
            joinedAt: Date.now(),
          },
        ],
      });

      useWhiteboardStore.getState().handleIncomingEnvelope(
        createEnvelope(
          MessageType.CURSOR_MOVE,
          {
            x: 130,
            y: 230,
            activeTool: 'laser',
            points: [
              { x: 100, y: 200 },
              { x: 110, y: 210 },
              { x: 120, y: 220 },
              { x: 130, y: 230 },
            ],
          },
          { user_id: peerId, room: 'LASER1' },
        ),
      );

      const consumed = consumeRemoteLaserPoints(peerId);
      expect(consumed).toHaveLength(4);
      expect(consumed.map((p) => [p.x, p.y])).toEqual([
        [100, 200],
        [110, 210],
        [120, 220],
        [130, 230],
      ]);
      // Queue drains completely on consumption
      expect(consumeRemoteLaserPoints(peerId)).toHaveLength(0);
    });

    it('supports independent fillColor, centered shape text state, and visible PropertyBar editing controls', () => {
      const store = useWhiteboardStore.getState();

      // Custom fillColor can be stored independently of stroke color without breaking default text align
      store.setToolProps({ fill: true, fillColor: '#10B981', shapeAlign: 'center' });
      const props = useWhiteboardStore.getState().toolProps;
      expect(props.fill).toBe(true);
      expect(props.fillColor).toBe('#10B981');
      expect(props.align).toBe('left');
      expect(props.shapeAlign).toBe('center');

      // Selecting a shape shows Fill & Edit Text controls in PropertyBar
      const rectId = generateUuid();
      useWhiteboardStore.setState({
        activeTool: 'select',
        selectedIds: [rectId],
        objects: {
          [rectId]: {
            id: rectId,
            type: 'shape',
            shapeType: 'rectangle',
            x: 10,
            y: 20,
            width: 140,
            height: 90,
            strokeColor: '#18A0FB',
            strokeWidth: 4,
            fillColor: '#DBEAFE',
            align: 'center',
            authorId: 'u1',
            seq: 1,
            zIndex: 1,
            updatedAt: Date.now(),
          },
        },
      });
      const selectedHtml = renderToStaticMarkup(
        React.createElement(PropertyBarContent, useWhiteboardStore.getState()),
      );
      expect(selectedHtml).toContain('Fill');
      expect(selectedHtml).toContain('Edit Text');
      expect(selectedHtml).toContain('Alignment: center');

      // While typing inside a shape or draft text box (even with activeTool='select' or 'text'),
      // typography & Done controls stay visible and patchActiveTextEditor updates styles live
      useWhiteboardStore.setState({ activeTool: 'select' });
      useWhiteboardStore.getState().setActiveTextEditor({
        objectId: rectId,
        shapeType: 'rectangle',
        strokeColor: '#18A0FB',
        fillColor: '#DBEAFE',
        fontSize: 16,
        fontFamily: 'Inter, sans-serif',
        bold: false,
        italic: false,
        align: 'center',
      });
      useWhiteboardStore
        .getState()
        .patchActiveTextEditor({ bold: true, fontSize: 22, fillColor: '#FEE2E2' });
      const activeEditor = useWhiteboardStore.getState().activeTextEditor;
      expect(activeEditor?.bold).toBe(true);
      expect(activeEditor?.fontSize).toBe(22);
      expect(activeEditor?.fillColor).toBe('#FEE2E2');

      const editingHtml = renderToStaticMarkup(
        React.createElement(PropertyBarContent, useWhiteboardStore.getState()),
      );
      expect(editingHtml).toContain('Done');
      expect(editingHtml).toContain('Bold');
      expect(editingHtml).toContain('22');
      expect(editingHtml).toContain('Fill');

      // Clearing fill removes fillColor from activeTextEditor
      useWhiteboardStore.getState().patchActiveTextEditor({ fillColor: null });
      expect(useWhiteboardStore.getState().activeTextEditor?.fillColor).toBeUndefined();

      // Draft text editing (objectId=null, activeTool='text', selectedIds=[]) still renders Done & typography
      useWhiteboardStore.setState({ activeTool: 'text', selectedIds: [] });
      useWhiteboardStore.getState().setActiveTextEditor({
        objectId: null,
        shapeType: 'text',
        strokeColor: '#000000',
        fontSize: 18,
        fontFamily: 'Inter, sans-serif',
        bold: true,
        italic: false,
        align: 'left',
      });
      const draftHtml = renderToStaticMarkup(
        React.createElement(PropertyBarContent, useWhiteboardStore.getState()),
      );
      expect(draftHtml).toContain('Done');
      expect(draftHtml).toContain('18');

      // Requesting text edit & commit bumps expected store coordination fields
      useWhiteboardStore.getState().requestTextEdit(rectId);
      expect(useWhiteboardStore.getState().textEditRequestId).toBe(rectId);
      const beforeCommit = useWhiteboardStore.getState().textEditCommitCount;
      useWhiteboardStore.getState().requestCommitTextEdit();
      expect(useWhiteboardStore.getState().textEditCommitCount).toBe(beforeCommit + 1);
    });

    it('dismisses popovers only when pointer target is outside the container', () => {
      const insideNode = { label: 'inside' };
      const outsideNode = { label: 'outside' };
      const container = {
        contains: (node: unknown) => node === container || node === insideNode,
      };

      expect(shouldDismissOnOutsideEvent(null, outsideNode)).toBe(false);
      expect(shouldDismissOnOutsideEvent(container, null)).toBe(false);
      expect(shouldDismissOnOutsideEvent(container, container)).toBe(false);
      expect(shouldDismissOnOutsideEvent(container, insideNode)).toBe(false);
      expect(shouldDismissOnOutsideEvent(container, outsideNode)).toBe(true);
    });
  });
});
