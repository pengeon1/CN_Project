import { beforeEach, describe, expect, it } from 'vitest';
import {
  createEnvelope,
  generateUuid,
  MessageType,
  Role,
  type RoomStatePayload,
} from '@cn-whiteboard/common';
import { useWhiteboardStore } from '../src/store/useWhiteboardStore.js';

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
});
