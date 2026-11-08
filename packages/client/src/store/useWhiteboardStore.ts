/**
 * @fileoverview Central Zustand store for the whiteboard application.
 * Manages reactive UI state, canvas viewport, room synchronization,
 * participants, active tool properties, freehand stroke collections,
 * and ephemeral remote cursors.
 *
 * Delivery guarantees: the main process hands this store a gap-free, in-order, de-duplicated
 * stream of room events (see electron/tcp-client.ts). The store still ignores any sequenced event
 * it has already applied, and applies stroke points idempotently (by their authoritative index),
 * so replays and retransmissions can never corrupt the canvas.
 */

import { create } from 'zustand';
import {
  canMutateCanvas,
  type ChatMessage,
  createEnvelope,
  type CursorMovePayload,
  type ErasePayload,
  generateUuid,
  isHost,
  isSequencedType,
  type MessageEnvelope,
  MessageType,
  mergeStrokePoints,
  type Participant,
  type ParticipantJoinedPayload,
  type ParticipantLeftPayload,
  type ParticipantListPayload,
  type PermissionChangePayload,
  type Point,
  type RemoteCursor,
  type ResyncResponsePayload,
  Role,
  type RoomStatePayload,
  type SequencedOperation,
  type StrokeBeginPayload,
  type StrokeEndPayload,
  type StrokeObject,
  type StrokePointsPayload,
  type UndoPayload,
  type RedoPayload,
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

  // Undo / redo history
  undoStack: string[];
  redoStack: string[];

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
  clearModalOpen: boolean;
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
  setClearModalOpen: (open: boolean) => void;
  toggleTheme: () => void;
  sendChatMessage: (text: string) => void;
  undoLastAction: () => void;
  redoLastAction: () => void;
  connectToServer: (options: ConnectOptions) => Promise<boolean>;
  disconnectFromServer: () => Promise<void>;
  handleIncomingEnvelope: (envelope: MessageEnvelope) => void;

  // Drawing & Cursor actions
  startDrawing: (startPoint: Point) => void;
  updateLocalLivePoint: (point: Point) => void;
  appendDrawingPoints: (points: Point[]) => void;
  finishDrawing: (finalPoint?: Point) => void;
  broadcastCursorPosition: (x: number, y: number, pressure?: number) => void;
  eraseObjects: (objectIds: string[]) => void;
  clearCanvas: () => void;
  /**
   * Manually asks the server for everything after `lastSeq`. Gap recovery is normally automatic
   * (the main process does it); this exists for diagnostics and manual refresh.
   */
  requestResync: (lastSeq?: number) => void;
}

function getElectronAPI() {
  if (typeof window !== 'undefined' && window.electronAPI) {
    return window.electronAPI;
  }
  return undefined;
}

function toChatEntry(message: ChatMessage): ChatEntry {
  return {
    id: message.id,
    userId: message.userId,
    username: message.username,
    color: message.color,
    text: message.text,
    ts: message.ts,
    isSystem: message.isSystem,
  };
}

/**
 * Mutates an objects dictionary by applying a single sequenced operation.
 * Used for deterministic log replay during incremental state synchronization.
 *
 * Stroke objects are replaced rather than mutated in place so that anything holding on to the
 * previous object (React memoization, canvas caches) observes a new identity. Stroke points are
 * merged idempotently by their authoritative index when the operation carries one.
 */
export function applySequencedOpToObjects(
  objects: Record<string, WhiteboardObject>,
  op: SequencedOperation,
): void {
  switch (op.type) {
    case MessageType.STROKE_BEGIN: {
      const p = op.payload as StrokeBeginPayload;
      const existing = objects[p.strokeId];
      if (existing && existing.type === 'stroke') {
        objects[p.strokeId] = { ...existing, seq: op.seq };
      } else {
        objects[p.strokeId] = {
          id: p.strokeId,
          authorId: op.userId,
          seq: op.seq,
          zIndex: Object.keys(objects).length + 1,
          updatedAt: op.ts,
          type: 'stroke',
          color: p.color,
          width: p.width,
          points: [p.startPoint],
          isComplete: false,
        };
      }
      break;
    }

    case MessageType.STROKE_POINTS: {
      const p = op.payload as StrokePointsPayload;
      const obj = objects[p.strokeId];
      if (obj && obj.type === 'stroke') {
        const points = [...obj.points];
        mergeStrokePoints(points, p.points, p.startIndex);
        objects[p.strokeId] = { ...obj, points, seq: op.seq, updatedAt: op.ts };
      }
      break;
    }

    case MessageType.STROKE_END: {
      const p = op.payload as StrokeEndPayload;
      const obj = objects[p.strokeId];
      if (obj && obj.type === 'stroke') {
        const points = [...obj.points];
        if (p.finalPoint) {
          mergeStrokePoints(points, [p.finalPoint], p.startIndex);
        }
        objects[p.strokeId] = {
          ...obj,
          points,
          isComplete: true,
          seq: op.seq,
          updatedAt: op.ts,
        };
      }
      break;
    }

    case MessageType.ERASE: {
      const p = op.payload as ErasePayload;
      for (const id of p.objectIds) {
        delete objects[id];
      }
      break;
    }

    case MessageType.CLEAR_CANVAS: {
      for (const id of Object.keys(objects)) {
        delete objects[id];
      }
      break;
    }
  }
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
  undoStack: [],
  redoStack: [],

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
  clearModalOpen: false,
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
    set((state) => ({
      rightPanelOpen: open,
      ...(open && state.rightPanelTab === 'chat' ? { unreadChatCount: 0 } : {}),
    }));
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

  setClearModalOpen: (open) => {
    set({ clearModalOpen: open });
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

  undoLastAction: () => {
    const { currentUser, roomInfo, undoStack } = get();
    const targetOpId = undoStack[undoStack.length - 1];
    if (!currentUser || !roomInfo || !targetOpId) return;

    const api = getElectronAPI();
    if (!api) return;

    const op_id = generateUuid();
    api.sendMessage(
      createEnvelope(
        MessageType.UNDO,
        { op_id, target_op_id: targetOpId },
        { user_id: currentUser.id, room: roomInfo.code },
      ),
    );

    set((state) => ({
      undoStack: state.undoStack.slice(0, -1),
      redoStack: [...state.redoStack, targetOpId],
    }));
  },

  redoLastAction: () => {
    const { currentUser, roomInfo, redoStack } = get();
    const targetOpId = redoStack[redoStack.length - 1];
    if (!currentUser || !roomInfo || !targetOpId) return;

    const api = getElectronAPI();
    if (!api) return;

    const op_id = generateUuid();
    api.sendMessage(
      createEnvelope(
        MessageType.REDO,
        { op_id, target_op_id: targetOpId },
        { user_id: currentUser.id, room: roomInfo.code },
      ),
    );

    set((state) => ({
      redoStack: state.redoStack.slice(0, -1),
      undoStack: [...state.undoStack, targetOpId],
    }));
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
    set((state) => ({ undoStack: [...state.undoStack, op_id], redoStack: [] }));

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

  eraseObjects: (objectIds) => {
    if (objectIds.length === 0) return;
    const { currentUser, roomInfo, objects } = get();
    if (currentUser && !canMutateCanvas(currentUser.role)) return;
    if (roomInfo?.locked && currentUser?.role !== Role.HOST) return;

    // Optimistically remove from local state
    const nextObjects = { ...objects };
    for (const id of objectIds) {
      delete nextObjects[id];
    }
    set({ objects: nextObjects });

    const api = getElectronAPI();
    if (api && roomInfo && currentUser) {
      const op_id = generateUuid();
      set((state) => ({ undoStack: [...state.undoStack, op_id], redoStack: [] }));
      api.sendMessage(
        createEnvelope(
          MessageType.ERASE,
          { op_id, objectIds },
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
    }
  },

  clearCanvas: () => {
    const { currentUser, roomInfo } = get();
    if (currentUser && !isHost(currentUser.role)) return;

    // Optimistically clear local state
    set({ objects: {}, liveLocalStroke: null, clearModalOpen: false });

    const api = getElectronAPI();
    if (api && roomInfo && currentUser) {
      const op_id = generateUuid();
      set((state) => ({ undoStack: [...state.undoStack, op_id], redoStack: [] }));
      api.sendMessage(
        createEnvelope(
          MessageType.CLEAR_CANVAS,
          { op_id },
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
    }
  },

  requestResync: (explicitLastSeq) => {
    const { currentUser, roomInfo, lastAppliedSeq } = get();
    const api = getElectronAPI();
    if (!currentUser || !roomInfo || !api) return;

    const targetSeq = explicitLastSeq !== undefined ? explicitLastSeq : lastAppliedSeq;
    api.sendMessage(
      createEnvelope(
        MessageType.RESYNC_REQUEST,
        { last_seq: targetSeq },
        { user_id: currentUser.id, room: roomInfo.code },
      ),
    );
  },

  handleIncomingEnvelope: (envelope) => {
    const sequenced = envelope.seq > 0 && isSequencedType(envelope.type);

    // Already applied (a replay or a duplicate): applying it again could only do harm.
    if (sequenced && envelope.seq <= get().lastAppliedSeq) {
      return;
    }

    switch (envelope.type) {
      case MessageType.ROOM_STATE: {
        const payload = envelope.payload as RoomStatePayload;
        const currentUserId = envelope.user_id;
        const myParticipant = payload.participants.find((p) => p.id === currentUserId);

        // Note: liveLocalStroke is deliberately preserved. A snapshot received while the user is
        // mid-stroke (reconnect) must not abort the stroke; its remaining points and its end are
        // still delivered from the outbox.
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
          undoStack: [],
          redoStack: [],
          remoteCursors: {},
          chatMessages: payload.chatHistory.map(toChatEntry),
          connectModalOpen: false,
        });
        break;
      }

      case MessageType.STROKE_BEGIN: {
        const payload = envelope.payload as StrokeBeginPayload;
        set((state) => {
          // While the local user is drawing this stroke their copy is the authoritative view.
          if (state.liveLocalStroke && state.liveLocalStroke.id === payload.strokeId) {
            return state;
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

          return { objects: { ...state.objects, [payload.strokeId]: stroke } };
        });
        break;
      }

      case MessageType.STROKE_POINTS: {
        const payload = envelope.payload as StrokePointsPayload;
        set((state) => {
          if (state.liveLocalStroke && state.liveLocalStroke.id === payload.strokeId) {
            return state;
          }
          const obj = state.objects[payload.strokeId];
          if (!obj || obj.type !== 'stroke') return state;

          // Idempotent by index: points the local copy already holds (drawn locally, or applied
          // from an earlier delivery) are skipped.
          const points = [...obj.points];
          mergeStrokePoints(points, payload.points, payload.startIndex);

          return {
            objects: {
              ...state.objects,
              [payload.strokeId]: { ...obj, points, seq: envelope.seq, updatedAt: envelope.ts },
            },
          };
        });
        break;
      }

      case MessageType.STROKE_END: {
        const payload = envelope.payload as StrokeEndPayload;
        set((state) => {
          if (state.liveLocalStroke && state.liveLocalStroke.id === payload.strokeId) {
            return state;
          }
          const obj = state.objects[payload.strokeId];
          if (!obj || obj.type !== 'stroke') return state;

          const points = [...obj.points];
          if (payload.finalPoint) {
            mergeStrokePoints(points, [payload.finalPoint], payload.startIndex);
          }

          return {
            objects: {
              ...state.objects,
              [payload.strokeId]: {
                ...obj,
                points,
                isComplete: true,
                seq: envelope.seq,
                updatedAt: envelope.ts,
              },
            },
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

      case MessageType.PERMISSION_CHANGE: {
        const payload = envelope.payload as PermissionChangePayload;
        set((state) => {
          const updatedParticipants = state.participants.map((p) =>
            p.id === payload.targetUserId && payload.newRole ? { ...p, role: payload.newRole } : p,
          );

          const updatedCurrent =
            state.currentUser && state.currentUser.id === payload.targetUserId && payload.newRole
              ? { ...state.currentUser, role: payload.newRole }
              : state.currentUser;

          return {
            participants: updatedParticipants,
            currentUser: updatedCurrent,
            roomInfo: state.roomInfo
              ? {
                  ...state.roomInfo,
                  isHost: updatedCurrent?.role === Role.HOST,
                  locked: payload.lockRoom !== undefined ? payload.lockRoom : state.roomInfo.locked,
                }
              : null,
          };
        });
        break;
      }

      case MessageType.CHAT_MESSAGE: {
        const payload = envelope.payload as {
          id?: string;
          text: string;
          username?: string;
          color?: string;
          ts?: number;
          isSystem?: boolean;
        };

        const msgId = payload.id || envelope.msg_id;

        set((state) => {
          if (state.chatMessages.some((m) => m.id === msgId)) {
            return state;
          }

          const newEntry: ChatEntry = {
            id: msgId,
            userId: envelope.user_id,
            username: payload.username || 'User',
            color: payload.color || '#3B82F6',
            text: payload.text,
            ts: payload.ts || envelope.ts,
            isSystem: payload.isSystem,
          };

          return {
            chatMessages: [...state.chatMessages, newEntry],
            unreadChatCount:
              state.rightPanelOpen && state.rightPanelTab === 'chat'
                ? 0
                : state.unreadChatCount + 1,
          };
        });
        break;
      }

      case MessageType.CHAT_HISTORY: {
        const payload = envelope.payload as { messages: ChatEntry[] };
        set((state) => {
          const existingIds = new Set(state.chatMessages.map((m) => m.id));
          const newEntries = (payload.messages || []).filter((m) => !existingIds.has(m.id));
          return {
            chatMessages: [...state.chatMessages, ...newEntries],
          };
        });
        break;
      }

      case MessageType.ERASE: {
        const payload = envelope.payload as ErasePayload;
        set((state) => {
          const nextObjects = { ...state.objects };
          for (const id of payload.objectIds) {
            delete nextObjects[id];
          }
          return { objects: nextObjects };
        });
        break;
      }

      case MessageType.CLEAR_CANVAS: {
        set((state) => {
          const systemNotice: ChatEntry = {
            id: generateUuid(),
            userId: envelope.user_id,
            username: 'System',
            color: '#EF4444',
            text: 'Whiteboard canvas was cleared by the room host.',
            ts: Date.now(),
            isSystem: true,
          };
          return {
            objects: {},
            liveLocalStroke: null,
            chatMessages: [...state.chatMessages, systemNotice],
          };
        });
        break;
      }

      case MessageType.UNDO: {
        const payload = envelope.payload as UndoPayload;
        set((state) => {
          const nextObjects = { ...state.objects };
          for (const id of payload.removeIds ?? []) {
            delete nextObjects[id];
          }
          for (const object of payload.restoreObjects ?? []) {
            nextObjects[object.id] = object;
          }

          if (envelope.user_id !== state.currentUser?.id) {
            return { objects: nextObjects };
          }

          return {
            objects: nextObjects,
            undoStack: state.undoStack.filter((id) => id !== payload.target_op_id),
            redoStack: state.redoStack.includes(payload.target_op_id)
              ? state.redoStack
              : [...state.redoStack, payload.target_op_id],
          };
        });
        break;
      }

      case MessageType.REDO: {
        const payload = envelope.payload as RedoPayload;
        set((state) => {
          const nextObjects = { ...state.objects };
          for (const id of payload.removeIds ?? []) {
            delete nextObjects[id];
          }
          for (const object of payload.restoreObjects ?? []) {
            nextObjects[object.id] = object;
          }

          if (envelope.user_id !== state.currentUser?.id) {
            return { objects: nextObjects };
          }

          return {
            objects: nextObjects,
            redoStack: state.redoStack.filter((id) => id !== payload.target_op_id),
            undoStack: state.undoStack.includes(payload.target_op_id)
              ? state.undoStack
              : [...state.undoStack, payload.target_op_id],
          };
        });
        break;
      }

      case MessageType.RESYNC_RESPONSE: {
        const payload = envelope.payload as ResyncResponsePayload;
        if (payload.fullSnapshot) {
          const snapshot = payload.fullSnapshot;
          set((state) => {
            // Keep local chat entries; add whatever the snapshot knows that we do not.
            const knownIds = new Set(state.chatMessages.map((m) => m.id));
            const missingChat = (snapshot.chatHistory ?? [])
              .filter((m) => !knownIds.has(m.id))
              .map(toChatEntry);
            return {
              objects: snapshot.objects || {},
              lastAppliedSeq: Math.max(state.lastAppliedSeq, snapshot.seq),
              participants: snapshot.participants || state.participants,
              chatMessages:
                missingChat.length > 0
                  ? [...state.chatMessages, ...missingChat].sort((a, b) => a.ts - b.ts)
                  : state.chatMessages,
            };
          });
        } else if (payload.operations && payload.operations.length > 0) {
          set((state) => {
            const nextObjects = { ...state.objects };
            for (const op of payload.operations!) {
              if (op.seq > state.lastAppliedSeq) {
                applySequencedOpToObjects(nextObjects, op);
              }
            }
            return {
              objects: nextObjects,
              lastAppliedSeq: Math.max(state.lastAppliedSeq, payload.to_seq),
            };
          });
        } else {
          set((state) => ({
            lastAppliedSeq: Math.max(state.lastAppliedSeq, payload.to_seq),
          }));
        }
        break;
      }
    }

    if (sequenced) {
      set((state) => ({ lastAppliedSeq: Math.max(state.lastAppliedSeq, envelope.seq) }));
    }
  },
}));
