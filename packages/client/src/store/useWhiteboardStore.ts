/**
 * @fileoverview Central Zustand store for the whiteboard application.
 * Manages reactive UI state, canvas viewport, room synchronization,
 * participants, active tool properties, freehand stroke collections,
 * and ephemeral remote cursors.
 */

import { create } from 'zustand';
import {
  canMutateCanvas,
  createEnvelope,
  generateUuid,
  type MessageEnvelope,
  MessageType,
  type Participant,
  type ParticipantJoinedPayload,
  type ParticipantLeftPayload,
  type ParticipantListPayload,
  type Point,
  type RemoteCursor,
  Role,
  type RoomStatePayload,
  type StrokeBeginPayload,
  type StrokeEndPayload,
  type StrokeObject,
  type StrokePointsPayload,
  type CursorMovePayload,
  type WhiteboardObject,
} from '@cn-whiteboard/common';
import type { ConnectionStatus, ConnectOptions } from '../types/ipc.js';

export type CanvasTool =
  'select' | 'pen' | 'eraser' | 'rectangle' | 'ellipse' | 'line' | 'arrow' | 'text' | 'sticky_note';

export interface ToolProperties {
  color: string;
  width: number;
  fill: boolean;
  fontSize: number;
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
}

export interface ChatEntry {
  id: string;
  userId: string;
  username: string;
  color: string;
  text: string;
  ts: number;
  isSystem?: boolean;
}

export interface WhiteboardState {
  // Connection & Room state
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  serverInfo: { host: string; port: number };
  roomInfo: { code: string; name: string; isHost: boolean; locked: boolean } | null;
  currentUser: { id: string; username: string; color: string; role: Role } | null;
  participants: Participant[];

  // Whiteboard canvas objects & cursors
  objects: Record<string, WhiteboardObject>;
  liveLocalStroke: StrokeObject | null;
  remoteCursors: Record<string, RemoteCursor>;
  lastAppliedSeq: number;

  // Chat state
  chatMessages: ChatEntry[];
  unreadChatCount: number;

  // Tool state
  activeTool: CanvasTool;
  toolProps: ToolProperties;

  // Viewport (Pan & Zoom)
  zoom: number;
  panX: number;
  panY: number;

  // UI Panels & Modals
  rightPanelOpen: boolean;
  rightPanelTab: 'chat' | 'participants';
  shareModalOpen: boolean;
  connectModalOpen: boolean;
  isDarkTheme: boolean;

  // Actions
  setConnectionStatus: (status: ConnectionStatus, error?: string | null) => void;
  setActiveTool: (tool: CanvasTool) => void;
  setToolProps: (props: Partial<ToolProperties>) => void;
  setZoom: (zoom: number | ((prev: number) => number)) => void;
  setPan: (panX: number, panY: number) => void;
  adjustPan: (deltaX: number, deltaY: number) => void;
  resetView: () => void;
  setRightPanelOpen: (open: boolean) => void;
  setRightPanelTab: (tab: 'chat' | 'participants') => void;
  setShareModalOpen: (open: boolean) => void;
  setConnectModalOpen: (open: boolean) => void;
  toggleTheme: () => void;
  sendChatMessage: (text: string) => void;
  connectToServer: (options: ConnectOptions) => Promise<boolean>;
  disconnectFromServer: () => Promise<void>;
  handleIncomingEnvelope: (envelope: MessageEnvelope) => void;

  // Drawing & Cursor actions
  startDrawing: (startPoint: Point) => void;
  updateLocalLivePoint: (point: Point) => void;
  appendDrawingPoints: (points: Point[]) => void;
  finishDrawing: (finalPoint?: Point) => void;
  broadcastCursorPosition: (x: number, y: number, pressure?: number) => void;
}

function getElectronAPI() {
  if (typeof window !== 'undefined' && window.electronAPI) {
    return window.electronAPI;
  }
  return undefined;
}

export const useWhiteboardStore = create<WhiteboardState>((set, get) => ({
  connectionStatus: 'disconnected',
  connectionError: null,
  serverInfo: { host: '127.0.0.1', port: 4000 },
  roomInfo: null,
  currentUser: null,
  participants: [],

  objects: {},
  liveLocalStroke: null,
  remoteCursors: {},
  lastAppliedSeq: 0,

  chatMessages: [],
  unreadChatCount: 0,

  activeTool: 'pen',
  toolProps: {
    color: '#18A0FB',
    width: 3,
    fill: false,
    fontSize: 16,
    fontFamily: 'Inter, sans-serif',
    bold: false,
    italic: false,
    align: 'left',
  },

  zoom: 1.0,
  panX: 0,
  panY: 0,

  rightPanelOpen: true,
  rightPanelTab: 'chat',
  shareModalOpen: false,
  connectModalOpen: false,
  isDarkTheme: false,

  setConnectionStatus: (status, error = null) => {
    set({ connectionStatus: status, connectionError: error });
  },

  setActiveTool: (tool) => {
    set({ activeTool: tool });
  },

  setToolProps: (props) => {
    set((state) => ({ toolProps: { ...state.toolProps, ...props } }));
  },

  setZoom: (zoomOrFn) => {
    set((state) => {
      const nextZoom = typeof zoomOrFn === 'function' ? zoomOrFn(state.zoom) : zoomOrFn;
      // Clamp between 10% and 500%
      const clamped = Math.min(Math.max(nextZoom, 0.1), 5.0);
      return { zoom: Math.round(clamped * 100) / 100 };
    });
  },

  setPan: (panX, panY) => {
    set({ panX, panY });
  },

  adjustPan: (deltaX, deltaY) => {
    set((state) => ({ panX: state.panX + deltaX, panY: state.panY + deltaY }));
  },

  resetView: () => {
    set({ zoom: 1.0, panX: 0, panY: 0 });
  },

  setRightPanelOpen: (open) => {
    set({ rightPanelOpen: open, ...(open ? { unreadChatCount: 0 } : {}) });
  },

  setRightPanelTab: (tab) => {
    set({ rightPanelTab: tab, ...(tab === 'chat' ? { unreadChatCount: 0 } : {}) });
  },

  setShareModalOpen: (open) => {
    set({ shareModalOpen: open });
  },

  setConnectModalOpen: (open) => {
    set({ connectModalOpen: open });
  },

  toggleTheme: () => {
    set((state) => ({ isDarkTheme: !state.isDarkTheme }));
  },

  sendChatMessage: (text) => {
    const { currentUser, roomInfo } = get();
    if (!text.trim() || !currentUser || !roomInfo) return;

    const chatMsgId = generateUuid();
    const chatEnvelope = createEnvelope(
      MessageType.CHAT_MESSAGE,
      {
        id: chatMsgId,
        text: text.trim(),
        username: currentUser.username,
        color: currentUser.color,
      },
      {
        room: roomInfo.code,
        user_id: currentUser.id,
      },
    );

    const api = getElectronAPI();
    if (api) {
      api.sendMessage(chatEnvelope);
    } else {
      // Local fallback in mock/browser mode
      const localEntry: ChatEntry = {
        id: chatMsgId,
        userId: currentUser.id,
        username: currentUser.username,
        color: currentUser.color,
        text: text.trim(),
        ts: Date.now(),
      };
      set((state) => ({
        chatMessages: [...state.chatMessages, localEntry],
      }));
    }
  },

  connectToServer: async (options) => {
    set({ connectionStatus: 'connecting', connectionError: null });

    const api = getElectronAPI();
    if (api) {
      const res = await api.connect(options);
      if (!res.success) {
        set({
          connectionStatus: 'error',
          connectionError: res.error || 'Connection failed',
        });
        return false;
      }
      return true;
    } else {
      // Mock / fallback for web-only or test execution
      const mockCode = options.roomCode || 'DEMO77';
      const mockUser = {
        id: generateUuid(),
        username: options.username,
        color: '#18A0FB',
        role: options.action === 'create' ? Role.HOST : Role.EDITOR,
      };

      set({
        connectionStatus: 'connected',
        roomInfo: {
          code: mockCode,
          name: options.roomName || 'Demo Whiteboard',
          isHost: options.action === 'create',
          locked: false,
        },
        currentUser: mockUser,
        participants: [
          {
            id: mockUser.id,
            username: mockUser.username,
            role: mockUser.role,
            color: mockUser.color,
            joinedAt: Date.now(),
          },
        ],
        connectModalOpen: false,
      });
      return true;
    }
  },

  disconnectFromServer: async () => {
    const api = getElectronAPI();
    if (api) {
      await api.disconnect();
    }
    set({
      connectionStatus: 'disconnected',
      roomInfo: null,
      currentUser: null,
      participants: [],
      chatMessages: [],
      objects: {},
      liveLocalStroke: null,
      remoteCursors: {},
      lastAppliedSeq: 0,
    });
  },

  startDrawing: (startPoint) => {
    const { currentUser, roomInfo, toolProps, objects } = get();
    if (currentUser && !canMutateCanvas(currentUser.role)) {
      return;
    }
    if (roomInfo?.locked && currentUser?.role !== Role.HOST) {
      return;
    }

    const strokeId = generateUuid();
    const op_id = generateUuid();
    const authorId = currentUser ? currentUser.id : 'local-user';

    const stroke: StrokeObject = {
      id: strokeId,
      authorId,
      seq: 0,
      zIndex: Object.keys(objects).length + 1,
      updatedAt: Date.now(),
      type: 'stroke',
      color: toolProps.color,
      width: toolProps.width,
      points: [startPoint],
      isComplete: false,
    };

    set({ liveLocalStroke: stroke });

    const api = getElectronAPI();
    if (api && roomInfo && currentUser) {
      api.sendMessage(
        createEnvelope(
          MessageType.STROKE_BEGIN,
          {
            op_id,
            strokeId,
            color: toolProps.color,
            width: toolProps.width,
            startPoint,
          },
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
    }
  },

  updateLocalLivePoint: (point) => {
    const { liveLocalStroke } = get();
    if (!liveLocalStroke) return;
    liveLocalStroke.points.push(point);
    set({ liveLocalStroke: { ...liveLocalStroke } });
  },

  appendDrawingPoints: (points) => {
    const { liveLocalStroke, currentUser, roomInfo } = get();
    if (!liveLocalStroke || points.length === 0) return;

    const api = getElectronAPI();
    if (api && roomInfo && currentUser) {
      const op_id = generateUuid();
      api.sendMessage(
        createEnvelope(
          MessageType.STROKE_POINTS,
          {
            op_id,
            strokeId: liveLocalStroke.id,
            points,
          },
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
    }
  },

  finishDrawing: (finalPoint) => {
    const { liveLocalStroke, currentUser, roomInfo, objects } = get();
    if (!liveLocalStroke) return;

    if (finalPoint) {
      liveLocalStroke.points.push(finalPoint);
    }
    liveLocalStroke.isComplete = true;

    set({
      objects: { ...objects, [liveLocalStroke.id]: liveLocalStroke },
      liveLocalStroke: null,
    });

    const api = getElectronAPI();
    if (api && roomInfo && currentUser) {
      const op_id = generateUuid();
      api.sendMessage(
        createEnvelope(
          MessageType.STROKE_END,
          {
            op_id,
            strokeId: liveLocalStroke.id,
            finalPoint,
          },
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
    }
  },

  broadcastCursorPosition: (x, y, pressure) => {
    const { currentUser, roomInfo, activeTool } = get();
    const api = getElectronAPI();
    if (!currentUser || !roomInfo || !api) return;

    api.sendMessage(
      createEnvelope(
        MessageType.CURSOR_MOVE,
        {
          x,
          y,
          activeTool,
          pressure,
        },
        { user_id: currentUser.id, room: roomInfo.code },
      ),
    );
  },

  handleIncomingEnvelope: (envelope) => {
    switch (envelope.type) {
      case MessageType.ROOM_STATE: {
        const payload = envelope.payload as RoomStatePayload;
        const currentUserId = envelope.user_id;
        const myParticipant = payload.participants.find((p) => p.id === currentUserId);

        set({
          connectionStatus: 'connected',
          roomInfo: {
            code: payload.roomCode,
            name: payload.roomName,
            isHost: myParticipant?.role === Role.HOST,
            locked: payload.locked,
          },
          currentUser: myParticipant
            ? {
                id: myParticipant.id,
                username: myParticipant.username,
                color: myParticipant.color,
                role: myParticipant.role,
              }
            : null,
          participants: payload.participants,
          objects: payload.objects || {},
          lastAppliedSeq: payload.seq || 0,
          remoteCursors: {},
          liveLocalStroke: null,
          chatMessages: payload.chatHistory.map((m) => ({
            id: m.id,
            userId: m.userId,
            username: m.username,
            color: m.color,
            text: m.text,
            ts: m.ts,
            isSystem: m.isSystem,
          })),
          connectModalOpen: false,
        });
        break;
      }

      case MessageType.STROKE_BEGIN: {
        const payload = envelope.payload as StrokeBeginPayload;
        set((state) => {
          if (state.liveLocalStroke && state.liveLocalStroke.id === payload.strokeId) {
            state.liveLocalStroke.seq = envelope.seq;
          }

          const existing = state.objects[payload.strokeId];
          const stroke: StrokeObject =
            existing && existing.type === 'stroke'
              ? { ...existing, seq: envelope.seq }
              : {
                  id: payload.strokeId,
                  authorId: envelope.user_id,
                  seq: envelope.seq,
                  zIndex: Object.keys(state.objects).length + 1,
                  updatedAt: envelope.ts,
                  type: 'stroke',
                  color: payload.color,
                  width: payload.width,
                  points: [payload.startPoint],
                  isComplete: false,
                };

          return {
            objects: { ...state.objects, [payload.strokeId]: stroke },
            lastAppliedSeq: Math.max(state.lastAppliedSeq, envelope.seq),
          };
        });
        break;
      }

      case MessageType.STROKE_POINTS: {
        const payload = envelope.payload as StrokePointsPayload;
        set((state) => {
          const obj = state.objects[payload.strokeId];
          if (!obj || obj.type !== 'stroke') return state;

          if (envelope.user_id !== state.currentUser?.id) {
            obj.points.push(...payload.points);
          }
          obj.seq = envelope.seq;
          obj.updatedAt = envelope.ts;

          return {
            objects: { ...state.objects, [payload.strokeId]: { ...obj } },
            lastAppliedSeq: Math.max(state.lastAppliedSeq, envelope.seq),
          };
        });
        break;
      }

      case MessageType.STROKE_END: {
        const payload = envelope.payload as StrokeEndPayload;
        set((state) => {
          const obj = state.objects[payload.strokeId];
          if (!obj || obj.type !== 'stroke') return state;

          if (envelope.user_id !== state.currentUser?.id && payload.finalPoint) {
            obj.points.push(payload.finalPoint);
          }
          obj.isComplete = true;
          obj.seq = envelope.seq;
          obj.updatedAt = envelope.ts;

          return {
            objects: { ...state.objects, [payload.strokeId]: { ...obj } },
            lastAppliedSeq: Math.max(state.lastAppliedSeq, envelope.seq),
          };
        });
        break;
      }

      case MessageType.CURSOR_MOVE: {
        const payload = envelope.payload as CursorMovePayload;
        set((state) => {
          const participant = state.participants.find((p) => p.id === envelope.user_id);
          const cursor: RemoteCursor = {
            userId: envelope.user_id,
            username: participant?.username || 'Peer',
            color: participant?.color || '#3B82F6',
            x: payload.x,
            y: payload.y,
            activeTool: payload.activeTool,
            pressure: payload.pressure,
          };

          return {
            remoteCursors: { ...state.remoteCursors, [envelope.user_id]: cursor },
          };
        });
        break;
      }

      case MessageType.PARTICIPANT_JOINED: {
        const payload = envelope.payload as ParticipantJoinedPayload;
        set((state) => {
          const exists = state.participants.some((p) => p.id === payload.participant.id);
          const updated = exists
            ? state.participants
            : [...state.participants, payload.participant];

          const systemNotice: ChatEntry = {
            id: generateUuid(),
            userId: payload.participant.id,
            username: payload.participant.username,
            color: payload.participant.color,
            text: `${payload.participant.username} joined the whiteboard.`,
            ts: Date.now(),
            isSystem: true,
          };

          return {
            participants: updated,
            chatMessages: [...state.chatMessages, systemNotice],
            unreadChatCount:
              state.rightPanelOpen && state.rightPanelTab === 'chat'
                ? 0
                : state.unreadChatCount + 1,
          };
        });
        break;
      }

      case MessageType.PARTICIPANT_LEFT: {
        const payload = envelope.payload as ParticipantLeftPayload;
        set((state) => {
          const updated = state.participants.filter((p) => p.id !== payload.userId);
          const updatedCursors = { ...state.remoteCursors };
          delete updatedCursors[payload.userId];

          const systemNotice: ChatEntry = {
            id: generateUuid(),
            userId: payload.userId,
            username: payload.username,
            color: '#94A3B8',
            text: `${payload.username} left the session.${payload.reason ? ` (${payload.reason})` : ''}`,
            ts: Date.now(),
            isSystem: true,
          };

          return {
            participants: updated,
            remoteCursors: updatedCursors,
            chatMessages: [...state.chatMessages, systemNotice],
          };
        });
        break;
      }

      case MessageType.PARTICIPANT_LIST: {
        const payload = envelope.payload as ParticipantListPayload;
        set({ participants: payload.participants });
        break;
      }

      case MessageType.CHAT_MESSAGE: {
        const payload = envelope.payload as {
          id?: string;
          text: string;
          username?: string;
          color?: string;
          ts?: number;
        };

        const newEntry: ChatEntry = {
          id: payload.id || envelope.msg_id,
          userId: envelope.user_id,
          username: payload.username || 'User',
          color: payload.color || '#3B82F6',
          text: payload.text,
          ts: payload.ts || envelope.ts,
        };

        set((state) => ({
          chatMessages: [...state.chatMessages, newEntry],
          unreadChatCount:
            state.rightPanelOpen && state.rightPanelTab === 'chat' ? 0 : state.unreadChatCount + 1,
        }));
        break;
      }
    }
  },
}));
