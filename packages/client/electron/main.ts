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
import * as fs from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { RoomSnapshotSchema, type MessageEnvelope, type RoomSnapshot } from '@cn-whiteboard/common';
import type { ConnectOptions, ExportBoardResult } from '../src/types/ipc.js';
import { MainTcpClient, type TcpClientSink } from './tcp-client.js';

// Optimize Chromium rasterization for crisp subpixel font rendering and high-DPI displays
app.commandLine.appendSwitch('enable-font-antialiasing');
app.commandLine.appendSwitch('high-dpi-support', '1');

let mainWindow: BrowserWindow | null = null;
let tcpClient: MainTcpClient | null = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';

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
 * Adapts a BrowserWindow into the sink the TCP client delivers its (already ordered and
 * de-duplicated) output to. The renderer only ever sees this sink's output.
 */
function createWindowSink(win: BrowserWindow): TcpClientSink {
  return {
    status: (event) => {
      if (!win.isDestroyed()) win.webContents.send('tcp:status', event);
    },
    message: (envelope) => {
      if (!win.isDestroyed()) win.webContents.send('tcp:message', envelope);
    },
  };
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
    backgroundColor: '#0F172A',
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

  tcpClient = new MainTcpClient(createWindowSink(win));

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

ipcMain.handle(
  'board:export',
  async (_event, snapshot: RoomSnapshot): Promise<ExportBoardResult> => {
    const parsedSnapshot = RoomSnapshotSchema.safeParse(snapshot);
    if (!parsedSnapshot.success) {
      return { success: false, error: 'The current board snapshot is invalid.' };
    }

    if (!mainWindow || mainWindow.isDestroyed()) {
      return { success: false, error: 'The whiteboard window is unavailable.' };
    }

    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Export whiteboard',
      defaultPath: `${parsedSnapshot.data.roomName.replace(/[\\/:*?"<>|]/g, '_')}.json`,
      filters: [{ name: 'JSON files', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) {
      return { success: true, canceled: true };
    }

    const filePath =
      path.extname(result.filePath).toLowerCase() === '.json'
        ? result.filePath
        : `${result.filePath}.json`;
    const exportedBoard = {
      schemaVersion: 1,
      exportedAt: Date.now(),
      ...parsedSnapshot.data,
    };

    try {
      await fs.writeFile(filePath, `${JSON.stringify(exportedBoard, null, 2)}\n`, 'utf8');
      return { success: true, filePath };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown file write error';
      console.error(`[Main Process] Failed to export whiteboard: ${message}`);
      return { success: false, error: `Could not write the export file: ${message}` };
    }
  },
);

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
