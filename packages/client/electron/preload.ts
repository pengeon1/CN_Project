/**
 * @fileoverview Electron Preload script.
 * Exposes a strongly-typed, secure bridge to the renderer process.
 * Renderer has no access to Node.js primitives or socket handles.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { MessageEnvelope, RoomSnapshot } from '@cn-whiteboard/common';
import type {
  ConnectOptions,
  ConnectionStatusEvent,
  ElectronWhiteboardAPI,
} from '../src/types/ipc.js';

const api: ElectronWhiteboardAPI = {
  platform: process.platform,

  connect: (options: ConnectOptions) => ipcRenderer.invoke('tcp:connect', options),

  disconnect: () => ipcRenderer.invoke('tcp:disconnect'),

  sendMessage: (envelope: MessageEnvelope) => ipcRenderer.invoke('tcp:send', envelope),

  exportBoard: (snapshot: RoomSnapshot) => ipcRenderer.invoke('board:export', snapshot),

  onMessage: (callback: (envelope: MessageEnvelope) => void) => {
    const handler = (_event: IpcRendererEvent, envelope: MessageEnvelope) => callback(envelope);
    ipcRenderer.on('tcp:message', handler);
    return () => {
      ipcRenderer.removeListener('tcp:message', handler);
    };
  },

  onStatus: (callback: (status: ConnectionStatusEvent) => void) => {
    const handler = (_event: IpcRendererEvent, status: ConnectionStatusEvent) => callback(status);
    ipcRenderer.on('tcp:status', handler);
    return () => {
      ipcRenderer.removeListener('tcp:status', handler);
    };
  },

  getLanAddresses: () => ipcRenderer.invoke('net:get-lan-ips'),

  discoverServers: () => ipcRenderer.invoke('net:discover'),
};

contextBridge.exposeInMainWorld('electronAPI', api);
