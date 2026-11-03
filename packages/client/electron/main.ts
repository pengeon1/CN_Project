/**
 * @fileoverview Electron main process entrypoint.
 *
 * Security Architecture:
 * - contextIsolation: true (prevents renderer from tampering with Electron APIs)
 * - nodeIntegration: false (strictly isolates Node.js APIs from the web renderer)
 * - sandbox: true (enforces OS-level chromium sandboxing for the renderer)
 *
 * All network sockets and low-level TCP connection management will be orchestrated
 * here in the main process, never inside the renderer thread.
 */

import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';

let mainWindow: BrowserWindow | null = null;

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';

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

  if (isDev) {
    // Retry connecting to Vite dev server in case it is still booting
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
    // Load built production static assets
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  win.on('closed', () => {
    mainWindow = null;
  });

  return win;
}

app.whenReady().then(() => {
  mainWindow = createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS applications typically stay active until user explicitly quits (Cmd+Q)
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Returns the active main BrowserWindow instance, or null if uninitialized/closed.
 */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
