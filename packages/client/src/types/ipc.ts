/**
 * @fileoverview Type definitions for IPC communication between
 * the Electron Main Process and Renderer Process.
 */

import type { MessageEnvelope, RoomSnapshot } from '@cn-whiteboard/common';

export type ConnectionStatus =
  'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  action: 'create' | 'join';
  roomName?: string;
  roomCode?: string;
  password?: string;
}

export interface ConnectionStatusEvent {
  status: ConnectionStatus;
  error?: string;
  userId?: string;
  sessionId?: string;
  roomCode?: string;
  /**
   * While reconnecting: the 1-based number of the reconnect attempt that is being scheduled.
   */
  attempt?: number;
  /**
   * While reconnecting: milliseconds until the next attempt starts.
   */
  retryInMs?: number;
}

/**
 * Outcome of writing a validated room snapshot from the desktop save dialog.
 */
export interface ExportBoardResult {
  success: boolean;
  canceled?: boolean;
  filePath?: string;
  error?: string;
}

/**
 * Interface exposed on `window.electronAPI` via contextBridge in preload.ts.
 */
export interface ElectronWhiteboardAPI {
  platform: string;
  connect: (options: ConnectOptions) => Promise<{ success: boolean; error?: string }>;
  disconnect: () => Promise<void>;
  sendMessage: (envelope: MessageEnvelope) => Promise<boolean>;
  onMessage: (callback: (envelope: MessageEnvelope) => void) => () => void;
  onStatus: (callback: (status: ConnectionStatusEvent) => void) => () => void;
  exportBoard: (snapshot: RoomSnapshot) => Promise<ExportBoardResult>;
  getLanAddresses?: () => Promise<string[]>;
}

declare global {
  interface Window {
    electronAPI?: ElectronWhiteboardAPI;
  }
}
