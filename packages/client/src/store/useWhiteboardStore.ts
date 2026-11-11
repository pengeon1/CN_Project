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
  type ParticipantRenamedPayload,
  type PermissionChangePayload,
  type Point,
  type RemoteCursor,
  type ResyncResponsePayload,
  Role,
  type RoomSnapshot,
  type RoomStatePayload,
  type SequencedOperation,
  IMAGE_CHUNK_BYTES,
  MAX_VERSION_NAME_LENGTH,
  PRESENTATION_STALE_MS,
  type ImageAddPayload,
  type ImageChunkPayload,
  type ImageObject,
  type ObjectChanges,
  type PresentationPayload,
  type VersionListPayload,
  type VersionMeta,
  type ObjectDeletePayload,
  type ObjectUpdatePayload,
  type ShapeAddPayload,
  type ShapeObject,
  applyObjectChanges,
  type StrokeBeginPayload,
  type StrokeEndPayload,
  type StrokeObject,
  type StrokePointsPayload,
  type UndoPayload,
  type RedoPayload,
  type UpdateUsernamePayload,
  type WhiteboardObject,
} from '@cn-whiteboard/common';
import type { ConnectionStatus, ConnectOptions } from '../types/ipc.js';

export type CanvasTool =
  | 'select'
  | 'pen'
  | 'eraser'
  | 'laser'
  | 'rectangle'
  | 'ellipse'
  | 'line'
  | 'arrow'
  | 'text'
  | 'sticky_note';

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

export interface AccessNotice {
  title: string;
  message: string;
}

export interface WhiteboardState {
  // Connection & Room state
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  serverInfo: { host: string; port: number };
  roomInfo: {
    code: string;
    name: string;
    isHost: boolean;
    locked: boolean;
    allowNameChanges?: boolean;
    createdAt?: number;
  } | null;
  persistenceStatus: string | null;
  accessNotice: AccessNotice | null;
  currentUser: { id: string; username: string; color: string; role: Role } | null;
  participants: Participant[];

  // Whiteboard canvas objects & cursors
  objects: Record<string, WhiteboardObject>;
  liveLocalStroke: StrokeObject | null;
  selectedIds: string[];
  /** Current presentation (own, as host, or the host's as a follower). */
  presentation: PresentationPayload & { receivedAt: number };
  versions: VersionMeta[];
  versionsOpen: boolean;
  searchOpen: boolean;
  /** assetId -> data: URL of every image whose bytes have arrived. */
  imageData: Record<string, string>;
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
  profileSettingsOpen: boolean;
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
  setProfileSettingsOpen: (open: boolean) => void;
  setClearModalOpen: (open: boolean) => void;
  dismissAccessNotice: () => void;
  toggleTheme: () => void;
  sendChatMessage: (text: string) => void;
  sendPermissionChange: (payload: PermissionChangePayload) => void;
  updateUsername: (username: string) => void;
  undoLastAction: () => void;
  redoLastAction: () => void;
  connectToServer: (options: ConnectOptions) => Promise<boolean>;
  disconnectFromServer: () => Promise<void>;
  requestSaveState: () => Promise<void>;
  requestLoadState: () => Promise<void>;
  exportBoard: () => Promise<void>;
  handleIncomingEnvelope: (envelope: MessageEnvelope) => void;

  // Drawing & Cursor actions
  startDrawing: (startPoint: Point) => void;
  updateLocalLivePoint: (point: Point) => void;
  appendDrawingPoints: (points: Point[]) => void;
  finishDrawing: (finalPoint?: Point) => void;
  broadcastCursorPosition: (x: number, y: number, pressure?: number) => void;
  eraseObjects: (objectIds: string[]) => void;
  setSelectedIds: (ids: string[]) => void;
  /** Host: start/stop presenting. Followers' views are locked to the host's while active. */
  setPresenting: (active: boolean) => void;
  /** Host: broadcast the centre of the current view (call throttled while presenting). */
  sendPresentationViewport: (x: number, y: number, zoom: number) => void;
  /** Follower: drop a presentation whose host went silent (lost "stop" message). */
  endStalePresentation: () => void;
  setVersionsOpen: (open: boolean) => void;
  setSearchOpen: (open: boolean) => void;
  focusObject: (id: string) => void;
  requestVersions: () => void;
  saveVersion: (name: string) => void;
  restoreVersion: (versionId: string) => void;
  /** Uploads image bytes in chunks, then adds the image object (optimistically shown). */
  addImage: (image: {
    assetId: string;
    mime: ImageObject['mime'];
    base64: string;
    bytes: number;
    width: number;
    height: number;
    centerX: number;
    centerY: number;
  }) => boolean;
  /** Requests bytes for every image on the board that has none yet (retries slow ones). */
  ensureImages: () => void;
  /** Adds a shape/text/sticky note optimistically and sends SHAPE_ADD. Returns its id. */
  addShape: (
    shape: Omit<ShapeObject, 'id' | 'authorId' | 'seq' | 'zIndex' | 'updatedAt' | 'type'>,
  ) => string | null;
  /** Applies `changesFor(obj)` to each object (optimistic) and sends one OBJECT_UPDATE each. */
  updateObjects: (ids: string[], changesFor: (obj: WhiteboardObject) => ObjectChanges) => void;
  deleteObjects: (ids: string[]) => void;
  reorderObjects: (ids: string[], direction: 'front' | 'back') => void;
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

/** Image chunks received so far, keyed by asset id (module-level: not render state). */
const incomingImages = new Map<string, { parts: Array<string | undefined>; got: number }>();
/** When bytes for an asset were last requested, to avoid duplicate requests. */
const imageRequestedAt = new Map<string, number>();

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

    case MessageType.SHAPE_ADD: {
      const p = op.payload as ShapeAddPayload;
      objects[p.object.id] = { ...p.object, seq: op.seq };
      break;
    }

    case MessageType.IMAGE_ADD: {
      const p = op.payload as ImageAddPayload;
      objects[p.object.id] = { ...p.object, seq: op.seq };
      break;
    }

    case MessageType.OBJECT_UPDATE: {
      const p = op.payload as ObjectUpdatePayload;
      const obj = objects[p.id];
      if (obj) objects[p.id] = applyObjectChanges(obj, p.changes, op.seq, op.ts);
      break;
    }

    case MessageType.OBJECT_DELETE: {
      delete objects[(op.payload as ObjectDeletePayload).id];
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
  persistenceStatus: null,
  accessNotice: null,
  currentUser: null,
  participants: [],

  objects: {},
  liveLocalStroke: null,
  selectedIds: [],
  presentation: { active: false, receivedAt: 0 },
  versions: [],
  versionsOpen: false,
  searchOpen: false,
  imageData: {},
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
  profileSettingsOpen: false,
  clearModalOpen: false,
  isDarkTheme: false,

  setConnectionStatus: (status, error = null) => {
    set({ connectionStatus: status, connectionError: error });
  },

  setActiveTool: (tool) => {
    const { currentUser, roomInfo } = get();
    const canEdit =
      !currentUser ||
      (canMutateCanvas(currentUser.role) && (!roomInfo?.locked || isHost(currentUser.role)));
    if (tool !== 'select' && !canEdit) return;
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

  setProfileSettingsOpen: (open) => {
    set({ profileSettingsOpen: open });
  },

  setClearModalOpen: (open) => {
    set({ clearModalOpen: open });
  },

  dismissAccessNotice: () => {
    set({ accessNotice: null });
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

  sendPermissionChange: (payload) => {
    const { currentUser, roomInfo } = get();
    if (!currentUser || !roomInfo || !isHost(currentUser.role)) return;

    const api = getElectronAPI();
    if (!api) {
      set({ persistenceStatus: 'Room controls are available in the desktop app.' });
      return;
    }

    void api
      .sendMessage(
        createEnvelope(MessageType.PERMISSION_CHANGE, payload, {
          room: roomInfo.code,
          user_id: currentUser.id,
        }),
      )
      .catch((error: unknown) => {
        set({
          persistenceStatus:
            error instanceof Error ? error.message : 'Could not send the room management request.',
        });
      });
  },

  updateUsername: (username) => {
    const trimmedUsername = username.trim();
    const { currentUser, roomInfo, participants } = get();
    if (
      !currentUser ||
      !roomInfo?.allowNameChanges ||
      !trimmedUsername ||
      trimmedUsername === currentUser.username
    ) {
      return;
    }

    const api = getElectronAPI();
    if (!api) {
      set({
        currentUser: { ...currentUser, username: trimmedUsername },
        participants: participants.map((participant) =>
          participant.id === currentUser.id
            ? { ...participant, username: trimmedUsername }
            : participant,
        ),
        profileSettingsOpen: false,
      });
      return;
    }

    void api
      .sendMessage(
        createEnvelope(
          MessageType.UPDATE_USERNAME,
          { username: trimmedUsername } satisfies UpdateUsernamePayload,
          { room: roomInfo.code, user_id: currentUser.id },
        ),
      )
      .then((sent) => {
        if (sent) set({ profileSettingsOpen: false });
        else set({ persistenceStatus: 'Could not send the name change request.' });
      })
      .catch((error: unknown) => {
        set({
          persistenceStatus:
            error instanceof Error ? error.message : 'Could not send the name change request.',
        });
      });
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
    set({ connectionStatus: 'connecting', connectionError: null, accessNotice: null });

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
        accessNotice: null,
        roomInfo: {
          code: mockCode,
          name: options.roomName || 'Demo Whiteboard',
          isHost: options.action === 'create',
          locked: false,
          allowNameChanges: options.action === 'create' && options.allowNameChanges === true,
          createdAt: Date.now(),
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
      persistenceStatus: null,
      currentUser: null,
      accessNotice: null,
      participants: [],
      chatMessages: [],
      objects: {},
      liveLocalStroke: null,
      remoteCursors: {},
      lastAppliedSeq: 0,
    });
  },

  requestSaveState: async () => {
    const { currentUser, roomInfo } = get();
    const api = getElectronAPI();
    if (!currentUser || !roomInfo || !api || !roomInfo.isHost) return;

    set({ persistenceStatus: 'Saving room...' });
    try {
      const sent = await api.sendMessage(
        createEnvelope(
          MessageType.SAVE_STATE,
          {},
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
      if (!sent) set({ persistenceStatus: 'Could not send save request.' });
    } catch (error) {
      set({
        persistenceStatus: error instanceof Error ? error.message : 'Could not send save request.',
      });
    }
  },

  requestLoadState: async () => {
    const { currentUser, roomInfo } = get();
    const api = getElectronAPI();
    if (!currentUser || !roomInfo || !api || !roomInfo.isHost) return;

    set({ persistenceStatus: 'Loading saved room...' });
    try {
      const sent = await api.sendMessage(
        createEnvelope(
          MessageType.LOAD_STATE,
          {},
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
      if (!sent) set({ persistenceStatus: 'Could not send load request.' });
    } catch (error) {
      set({
        persistenceStatus: error instanceof Error ? error.message : 'Could not send load request.',
      });
    }
  },

  exportBoard: async () => {
    const { roomInfo, participants, objects, lastAppliedSeq, chatMessages } = get();
    const api = getElectronAPI();
    if (!roomInfo) return;
    if (!api) {
      set({ persistenceStatus: 'JSON export is available in the desktop app.' });
      return;
    }

    const snapshot: RoomSnapshot = {
      roomCode: roomInfo.code,
      roomName: roomInfo.name,
      seq: lastAppliedSeq,
      objects,
      participants,
      chatHistory: chatMessages,
      locked: roomInfo.locked,
      createdAt: roomInfo.createdAt ?? Date.now(),
    };
    try {
      const result = await api.exportBoard(snapshot);
      if (result.canceled) return;
      set({
        persistenceStatus: result.success
          ? `Exported ${result.filePath ?? 'board JSON'}`
          : (result.error ?? 'Could not export board.'),
      });
    } catch (error) {
      set({
        persistenceStatus: error instanceof Error ? error.message : 'Could not export board.',
      });
    }
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

  setSelectedIds: (ids) => set({ selectedIds: ids }),

  setPresenting: (active) => {
    const { currentUser, roomInfo } = get();
    if (!currentUser || !roomInfo || !isHost(currentUser.role)) return;
    set({ presentation: { active, receivedAt: Date.now() } });
    if (!active) {
      getElectronAPI()?.sendMessage(
        createEnvelope(
          MessageType.PRESENTATION,
          { active: false },
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
    }
    // On start the canvas immediately sends the first viewport (it knows its own size).
  },

  sendPresentationViewport: (x, y, zoom) => {
    const { currentUser, roomInfo, presentation } = get();
    if (!currentUser || !roomInfo || !presentation.active || !isHost(currentUser.role)) return;
    getElectronAPI()?.sendMessage(
      createEnvelope(
        MessageType.PRESENTATION,
        { active: true, viewport: { x, y, zoom } },
        { user_id: currentUser.id, room: roomInfo.code },
      ),
    );
  },

  endStalePresentation: () => {
    const { presentation, currentUser } = get();
    if (!presentation.active || (currentUser && isHost(currentUser.role))) return;
    if (Date.now() - presentation.receivedAt > PRESENTATION_STALE_MS) {
      set({ presentation: { active: false, receivedAt: Date.now() } });
    }
  },

  setVersionsOpen: (open) => {
    set({ versionsOpen: open });
    if (open) get().requestVersions();
  },

  setSearchOpen: (open) => {
    set({ searchOpen: open });
  },

  focusObject: (id: string) => {
    const { objects, zoom } = get();
    const obj = objects[id];
    if (!obj) return;

    let centerX = 0;
    let centerY = 0;

    if (obj.type === 'stroke') {
      if (!obj.points.length) return;
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const p of obj.points) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      centerX = (minX + maxX) / 2;
      centerY = (minY + maxY) / 2;
    } else {
      centerX = obj.x + (obj.width ?? 0) / 2;
      centerY = obj.y + (obj.height ?? 0) / 2;
    }

    const viewportW = typeof window !== 'undefined' ? window.innerWidth : 1200;
    const viewportH = typeof window !== 'undefined' ? window.innerHeight - 56 : 800;
    const nextPanX = viewportW / (2 * zoom) - centerX;
    const nextPanY = viewportH / (2 * zoom) - centerY;

    set({
      panX: Math.round(nextPanX),
      panY: Math.round(nextPanY),
      selectedIds: [id],
      activeTool: 'select',
      searchOpen: false,
    });
  },

  requestVersions: () => {
    const { currentUser, roomInfo } = get();
    if (!currentUser || !roomInfo || !isHost(currentUser.role)) return;
    getElectronAPI()?.sendMessage(
      createEnvelope(
        MessageType.VERSION_LIST,
        {},
        { user_id: currentUser.id, room: roomInfo.code },
      ),
    );
  },

  saveVersion: (name) => {
    const { currentUser, roomInfo } = get();
    if (!currentUser || !roomInfo || !isHost(currentUser.role) || !name.trim()) return;
    getElectronAPI()?.sendMessage(
      createEnvelope(
        MessageType.VERSION_SAVE,
        { name: name.trim().slice(0, MAX_VERSION_NAME_LENGTH) },
        { user_id: currentUser.id, room: roomInfo.code },
      ),
    );
  },

  restoreVersion: (versionId) => {
    const { currentUser, roomInfo } = get();
    if (!currentUser || !roomInfo || !isHost(currentUser.role)) return;
    getElectronAPI()?.sendMessage(
      createEnvelope(
        MessageType.VERSION_RESTORE,
        { versionId },
        { user_id: currentUser.id, room: roomInfo.code },
      ),
    );
  },

  addImage: (image) => {
    const { currentUser, roomInfo, objects } = get();
    if (!currentUser || !roomInfo || !canMutateCanvas(currentUser.role)) return false;
    if (roomInfo.locked && currentUser.role !== Role.HOST) return false;
    const api = getElectronAPI();
    if (!api) return false;

    const meta = { user_id: currentUser.id, room: roomInfo.code };
    // base64 chunk length is a multiple of 4 so every chunk decodes on its own.
    const size = Math.ceil(IMAGE_CHUNK_BYTES / 3) * 4;
    const total = Math.max(1, Math.ceil(image.base64.length / size));
    for (let index = 0; index < total; index++) {
      void api.sendMessage(
        createEnvelope(
          MessageType.IMAGE_UPLOAD,
          {
            assetId: image.assetId,
            mime: image.mime,
            index,
            total,
            data: image.base64.slice(index * size, (index + 1) * size),
          },
          meta,
        ),
      );
    }

    const scale = Math.min(1, 480 / Math.max(image.width, image.height));
    const width = image.width * scale;
    const height = image.height * scale;
    const top = Object.values(objects).reduce((m, o) => Math.max(m, o.zIndex), 0);
    const object: ImageObject = {
      id: generateUuid(),
      type: 'image',
      authorId: currentUser.id,
      seq: 0,
      zIndex: top + 1,
      updatedAt: Date.now(),
      assetId: image.assetId,
      mime: image.mime,
      bytes: image.bytes,
      x: image.centerX - width / 2,
      y: image.centerY - height / 2,
      width,
      height,
    };
    const op_id = generateUuid();
    set((state) => ({
      objects: { ...state.objects, [object.id]: object },
      imageData: {
        ...state.imageData,
        [image.assetId]: `data:${image.mime};base64,${image.base64}`,
      },
      selectedIds: [object.id],
      undoStack: [...state.undoStack, op_id],
      redoStack: [],
    }));
    void api.sendMessage(createEnvelope(MessageType.IMAGE_ADD, { op_id, object }, meta));
    return true;
  },

  ensureImages: () => {
    const { objects, imageData, currentUser, roomInfo } = get();
    const api = getElectronAPI();
    if (!api || !currentUser || !roomInfo) return;
    const now = Date.now();
    for (const obj of Object.values(objects)) {
      if (obj.type !== 'image' || imageData[obj.assetId]) continue;
      const last = imageRequestedAt.get(obj.assetId) ?? 0;
      if (now - last < 8000) continue; // request in flight; retry only if it never completed
      imageRequestedAt.set(obj.assetId, now);
      incomingImages.delete(obj.assetId);
      void api.sendMessage(
        createEnvelope(
          MessageType.IMAGE_REQUEST,
          { assetId: obj.assetId },
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
    }
  },

  addShape: (shape) => {
    const { currentUser, roomInfo, objects } = get();
    if (!currentUser || !roomInfo) return null;
    if (!canMutateCanvas(currentUser.role)) return null;
    if (roomInfo.locked && currentUser.role !== Role.HOST) return null;

    const id = generateUuid();
    const op_id = generateUuid();
    const top = Object.values(objects).reduce((m, o) => Math.max(m, o.zIndex), 0);
    const object: ShapeObject = {
      ...shape,
      id,
      type: 'shape',
      authorId: currentUser.id,
      seq: 0,
      zIndex: top + 1,
      updatedAt: Date.now(),
    };
    set((state) => ({
      objects: { ...state.objects, [id]: object },
      undoStack: [...state.undoStack, op_id],
      redoStack: [],
    }));
    getElectronAPI()?.sendMessage(
      createEnvelope(
        MessageType.SHAPE_ADD,
        { op_id, object },
        { user_id: currentUser.id, room: roomInfo.code },
      ),
    );
    return id;
  },

  updateObjects: (ids, changesFor) => {
    const { currentUser, roomInfo } = get();
    if (!currentUser || !roomInfo || !canMutateCanvas(currentUser.role)) return;
    if (roomInfo.locked && currentUser.role !== Role.HOST) return;

    for (const id of ids) {
      const obj = get().objects[id];
      if (!obj) continue;
      const changes = changesFor(obj);
      if (Object.keys(changes).length === 0) continue;
      const op_id = generateUuid();
      set((state) => ({
        objects: {
          ...state.objects,
          [id]: applyObjectChanges(obj, changes, obj.seq, Date.now()),
        },
        undoStack: [...state.undoStack, op_id],
        redoStack: [],
      }));
      getElectronAPI()?.sendMessage(
        createEnvelope(
          MessageType.OBJECT_UPDATE,
          { op_id, id, changes },
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
    }
  },

  deleteObjects: (ids) => {
    const { currentUser, roomInfo } = get();
    if (!currentUser || !roomInfo || !canMutateCanvas(currentUser.role)) return;
    if (roomInfo.locked && currentUser.role !== Role.HOST) return;

    for (const id of ids) {
      if (!get().objects[id]) continue;
      const op_id = generateUuid();
      set((state) => {
        const nextObjects = { ...state.objects };
        delete nextObjects[id];
        return {
          objects: nextObjects,
          selectedIds: state.selectedIds.filter((s) => s !== id),
          undoStack: [...state.undoStack, op_id],
          redoStack: [],
        };
      });
      getElectronAPI()?.sendMessage(
        createEnvelope(
          MessageType.OBJECT_DELETE,
          { op_id, id },
          { user_id: currentUser.id, room: roomInfo.code },
        ),
      );
    }
  },

  reorderObjects: (ids, direction) => {
    // Absolute zIndex values keep the operation idempotent and last-writer-wins safe.
    const all = Object.values(get().objects);
    if (all.length === 0) return;
    let next =
      direction === 'front'
        ? Math.max(...all.map((o) => o.zIndex))
        : Math.min(...all.map((o) => o.zIndex));
    const ordered = ids
      .map((id) => get().objects[id])
      .filter((o): o is WhiteboardObject => Boolean(o))
      .sort((a, b) => a.zIndex - b.zIndex);
    if (direction === 'back') ordered.reverse();
    const zFor = new Map<string, number>();
    for (const o of ordered) {
      next += direction === 'front' ? 1 : -1;
      zFor.set(o.id, next);
    }
    get().updateObjects(ids, (o) => ({ zIndex: zFor.get(o.id) ?? o.zIndex }));
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
            allowNameChanges: payload.allowNameChanges ?? false,
            createdAt: payload.createdAt,
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
          presentation: { ...(payload.presentation ?? { active: false }), receivedAt: Date.now() },
          lastAppliedSeq: payload.seq || 0,
          undoStack: [],
          redoStack: [],
          remoteCursors: {},
          chatMessages: payload.chatHistory.map(toChatEntry),
          connectModalOpen: false,
        });
        break;
      }

      case MessageType.SAVE_STATE: {
        const payload = envelope.payload as { filename?: string };
        set({
          persistenceStatus: `Saved room${payload.filename ? ` to ${payload.filename}` : ''}.`,
        });
        break;
      }

      case MessageType.LOAD_STATE: {
        const payload = envelope.payload as { filename?: string };
        set({
          persistenceStatus: `Loaded saved room${payload.filename ? ` from ${payload.filename}` : ''}.`,
        });
        break;
      }

      case MessageType.ERROR: {
        const payload = envelope.payload as { message?: string };
        set({ persistenceStatus: payload.message ?? 'The server rejected the request.' });
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

      case MessageType.PARTICIPANT_RENAMED: {
        const payload = envelope.payload as ParticipantRenamedPayload;
        set((state) => ({
          participants: state.participants.map((participant) =>
            participant.id === payload.userId
              ? { ...participant, username: payload.username }
              : participant,
          ),
          currentUser:
            state.currentUser?.id === payload.userId
              ? { ...state.currentUser, username: payload.username }
              : state.currentUser,
          remoteCursors:
            state.remoteCursors[payload.userId] !== undefined
              ? {
                  ...state.remoteCursors,
                  [payload.userId]: {
                    ...state.remoteCursors[payload.userId]!,
                    username: payload.username,
                  },
                }
              : state.remoteCursors,
          chatMessages: [
            ...state.chatMessages,
            {
              id: generateUuid(),
              userId: payload.userId,
              username: payload.username,
              color:
                state.participants.find((participant) => participant.id === payload.userId)
                  ?.color ?? '#94A3B8',
              text: `${state.participants.find((participant) => participant.id === payload.userId)?.username ?? 'A participant'} changed their name to ${payload.username}.`,
              ts: Date.now(),
              isSystem: true,
            },
          ],
        }));
        break;
      }

      case MessageType.PERMISSION_CHANGE: {
        const payload = envelope.payload as PermissionChangePayload;
        const { currentUser } = get();
        if (payload.kick && payload.targetUserId === currentUser?.id) {
          const api = getElectronAPI();
          if (api) {
            void api.disconnect().catch((error: unknown) => {
              set({
                connectionError:
                  error instanceof Error ? error.message : 'Could not leave the kicked session.',
              });
            });
          }
          set({
            accessNotice: {
              title: 'Removed from the room',
              message: payload.reason
                ? `The host removed you from this room: ${payload.reason}`
                : 'The host removed you from this room.',
            },
            connectionStatus: 'disconnected',
            roomInfo: null,
            persistenceStatus: null,
            currentUser: null,
            participants: [],
            chatMessages: [],
            objects: {},
            liveLocalStroke: null,
            remoteCursors: {},
            lastAppliedSeq: 0,
            undoStack: [],
            redoStack: [],
            activeTool: 'select',
          });
          break;
        }

        if (
          currentUser &&
          payload.targetUserId === currentUser.id &&
          payload.newRole === Role.VIEWER &&
          currentUser.role !== Role.VIEWER
        ) {
          set({
            accessNotice: {
              title: 'View-only access',
              message:
                'The host changed your role to Viewer. You can view the board but cannot edit it.',
            },
            activeTool: 'select',
          });
        }

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
            activeTool:
              payload.targetUserId === state.currentUser?.id && payload.newRole === Role.VIEWER
                ? 'select'
                : state.activeTool,
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

      case MessageType.SHAPE_ADD: {
        const payload = envelope.payload as ShapeAddPayload;
        set((state) => ({
          objects: {
            ...state.objects,
            [payload.object.id]: { ...payload.object, seq: envelope.seq },
          },
        }));
        break;
      }

      case MessageType.PRESENTATION: {
        const payload = envelope.payload as PresentationPayload;
        set({ presentation: { ...payload, receivedAt: Date.now() } });
        break;
      }

      case MessageType.VERSION_LIST: {
        const payload = envelope.payload as VersionListPayload;
        set({ versions: payload.versions ?? [] });
        break;
      }

      case MessageType.IMAGE_ADD: {
        const payload = envelope.payload as ImageAddPayload;
        set((state) => ({
          objects: {
            ...state.objects,
            [payload.object.id]: { ...payload.object, seq: envelope.seq },
          },
        }));
        get().ensureImages();
        break;
      }

      case MessageType.IMAGE_DATA: {
        const chunk = envelope.payload as ImageChunkPayload;
        let entry = incomingImages.get(chunk.assetId);
        if (!entry) {
          entry = { parts: new Array<string | undefined>(chunk.total).fill(undefined), got: 0 };
          incomingImages.set(chunk.assetId, entry);
        }
        if (entry.parts[chunk.index] === undefined && chunk.index < entry.parts.length) {
          entry.parts[chunk.index] = chunk.data;
          entry.got += 1;
        }
        if (entry.got === entry.parts.length) {
          incomingImages.delete(chunk.assetId);
          const url = `data:${chunk.mime};base64,${entry.parts.join('')}`;
          set((state) => ({ imageData: { ...state.imageData, [chunk.assetId]: url } }));
        }
        break;
      }

      case MessageType.OBJECT_UPDATE: {
        const payload = envelope.payload as ObjectUpdatePayload;
        set((state) => {
          const obj = state.objects[payload.id];
          if (!obj) return state;
          return {
            objects: {
              ...state.objects,
              [payload.id]: applyObjectChanges(obj, payload.changes, envelope.seq, envelope.ts),
            },
          };
        });
        break;
      }

      case MessageType.OBJECT_DELETE: {
        const payload = envelope.payload as ObjectDeletePayload;
        set((state) => {
          if (!state.objects[payload.id]) return state;
          const nextObjects = { ...state.objects };
          delete nextObjects[payload.id];
          return {
            objects: nextObjects,
            selectedIds: state.selectedIds.filter((id) => id !== payload.id),
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
            const nextParticipants = [...state.participants];
            let nextCurrentUser = state.currentUser;
            for (const op of payload.operations!) {
              if (op.seq > state.lastAppliedSeq) {
                applySequencedOpToObjects(nextObjects, op);
                if (op.type === MessageType.PARTICIPANT_RENAMED) {
                  const renamed = op.payload as ParticipantRenamedPayload;
                  const participantIndex = nextParticipants.findIndex(
                    (participant) => participant.id === renamed.userId,
                  );
                  if (participantIndex !== -1) {
                    nextParticipants[participantIndex] = {
                      ...nextParticipants[participantIndex]!,
                      username: renamed.username,
                    };
                  }
                  if (nextCurrentUser?.id === renamed.userId) {
                    nextCurrentUser = { ...nextCurrentUser, username: renamed.username };
                  }
                }
              }
            }
            return {
              objects: nextObjects,
              participants: nextParticipants,
              currentUser: nextCurrentUser,
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
