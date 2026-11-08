import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ServerConfig } from '../../src/config.js';
import { startServer, type WhiteboardServer } from '../../src/index.js';

const serverDataDirs = new WeakMap<WhiteboardServer, string>();

export async function startIsolatedServer(config: Partial<ServerConfig>) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cn-whiteboard-server-test-'));
  try {
    const instance = await startServer({ ...config, dataDir });
    serverDataDirs.set(instance.server, dataDir);
    return instance;
  } catch (error) {
    await fs.rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}

export async function closeIsolatedServer(server: WhiteboardServer): Promise<void> {
  const dataDir = serverDataDirs.get(server);
  try {
    await server.close();
  } finally {
    if (dataDir) {
      serverDataDirs.delete(server);
      await fs.rm(dataDir, { recursive: true, force: true });
    }
  }
}
