/**
 * @fileoverview Electron main process entrypoint.
 *
 * Security Architecture:
 * - contextIsolation: true (prevents renderer from tampering with Electron APIs)
 * - nodeIntegration: false (strictly isolates Node.js APIs from the web renderer)
 * - sandbox: true (enforces OS-level chromium sandboxing for the renderer)
 *
 * All network sockets and low-level TCP connection management are orchestrated
 * here in the main process, never inside the renderer thread.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { app, BrowserWindow, ipcMain } from 'electron';
import type { MessageEnvelope } from '@cn-whiteboard/common';
import type { ConnectOptions } from '../src/types/ipc.js';
import { MainTcpClient } from './tcp-client.js';

let mainWindow: BrowserWindow | null = null;
let tcpClient: MainTcpClient | null = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

function getLanAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];
  for (const key of Object.keys(interfaces)) {
    const netDetails = interfaces[key];
    if (!netDetails) continue;
    for (const detail of netDetails) {
      if (detail.family === 'IPv4' && !detail.internal) {
        addresses.push(detail.address);
      }
    }
  }
  return addresses;
}

/**
 * Creates and initializes the primary application window.
 */
function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 1024,
    minHeight: 600,
    title: 'LAN Collaborative Whiteboard',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    show: false, // Prevents white flash before content loads
  });

  win.once('ready-to-show', () => {
    win.show();
  });

  tcpClient = new MainTcpClient(win);

  if (isDev) {
    const loadUrlWithRetry = async (url: string, attempts = 30) => {
      for (let i = 0; i < attempts; i++) {
        try {
          await win.loadURL(url);
          console.log(`[Main Process] Loaded dev server URL: ${url}`);
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      console.error(`[Main Process] Failed to connect to Vite dev server at ${url}`);
    };

    loadUrlWithRetry(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  win.on('closed', () => {
    tcpClient?.disconnect();
    tcpClient = null;
    mainWindow = null;
  });

  return win;
}

// IPC Handlers
ipcMain.handle('tcp:connect', async (_event, options: ConnectOptions) => {
  if (!tcpClient) {
    return { success: false, error: 'TCP Client uninitialized' };
  }
  return tcpClient.connect(options);
});

ipcMain.handle('tcp:disconnect', async () => {
  tcpClient?.disconnect();
});

ipcMain.handle('tcp:send', async (_event, envelope: MessageEnvelope) => {
  if (!tcpClient) return false;
  return tcpClient.send(envelope);
});

ipcMain.handle('net:get-lan-ips', async () => {
  return getLanAddresses();
});

app.whenReady().then(() => {
  mainWindow = createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
