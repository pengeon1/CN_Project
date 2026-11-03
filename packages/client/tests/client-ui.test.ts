import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  generateUuid,
  MessageType,
  Role,
  type RoomStatePayload,
} from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../src/store/useWhiteboardStore.js';
import { isEditableElement, TOOL_SHORTCUTS } from '../src/hooks/useKeyboardShortcuts.js';

describe('Client UI & Store Suite', () => {
  beforeEach(() => {
    // Reset store to initial state
    useWhiteboardStore.setState({
      connectionStatus: 'disconnected',
      connectionError: null,
      roomInfo: null,
      currentUser: null,
      participants: [],
      chatMessages: [],
      unreadChatCount: 0,
      activeTool: 'pen',
      zoom: 1.0,
      panX: 0,
      panY: 0,
      rightPanelOpen: true,
      rightPanelTab: 'chat',
      shareModalOpen: false,
      connectModalOpen: false,
      isDarkTheme: false,
      objects: {},
      liveLocalStroke: null,
      remoteCursors: {},
      lastAppliedSeq: 0,
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
  });

  it('detects editable form elements to prevent hotkey hijacking while typing', () => {
    expect(isEditableElement(null)).toBe(false);
    expect(isEditableElement({} as EventTarget)).toBe(false);
    expect(isEditableElement({ tagName: 'DIV' } as EventTarget)).toBe(false);
    expect(isEditableElement({ tagName: 'INPUT' } as EventTarget)).toBe(true);
    expect(isEditableElement({ tagName: 'textarea' } as EventTarget)).toBe(true);
    expect(isEditableElement({ tagName: 'SELECT' } as EventTarget)).toBe(true);
    expect(isEditableElement({ tagName: 'DIV', isContentEditable: true } as EventTarget)).toBe(
      true,
    );
  });
});
