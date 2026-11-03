/**
 * @fileoverview Electron Preload script.
 * Safely exposes a restricted, typed API to the renderer process via contextBridge.
 * Follows the principle of least privilege: no Node.js primitives or socket handles
 * are ever exposed to the renderer window.
 */

import { contextBridge, ipcRenderer } from 'electron';

/**
 * Interface representing the exposed Electron API bridge in the window object.
 */
export interface ElectronAPI {
  /**
   * Returns current application platform ('win32' | 'darwin' | 'linux').
   */
  platform: string;
  /**
   * Ping IPC channel for sanity verification.
   */
  ping: () => Promise<string>;
}

const api: ElectronAPI = {
  platform: process.platform,
  ping: () => ipcRenderer.invoke('app:ping'),
};

contextBridge.exposeInMainWorld('electronAPI', api);
