/**
 * @fileoverview Main entrypoint for @cn-whiteboard/server.
 * Parses CLI configuration, initializes WhiteboardServer, and binds TCP socket listeners.
 */

import { parseConfig, type ServerConfig } from './config.js';
import { Logger } from './logger.js';
import { WhiteboardServer } from './server.js';

export * from './config.js';
export * from './logger.js';
export * from './session.js';
export * from './room.js';
export * from './room-persistence.js';
export * from './room-manager.js';
export * from './discovery.js';
export * from './server.js';

const logger = new Logger('Main');

/**
 * Starts the server given an optional configuration override.
 */
export async function startServer(configOverride?: Partial<ServerConfig>): Promise<{
  server: WhiteboardServer;
  port: number;
  host: string;
}> {
  const config: ServerConfig = {
    ...parseConfig(process.argv),
    ...configOverride,
  };

  const server = new WhiteboardServer({
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    heartbeatTimeoutMs: config.heartbeatTimeoutMs,
    discoveryPort: config.discoveryPort,
  });

  const { port, host } = await server.listen();
  return { server, port, host };
}

// Execute standalone when invoked directly from CLI
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  startServer()
    .then(({ server }) => {
      const shutdown = async (signal: string) => {
        logger.info(`Received ${signal}. Shutting down server gracefully...`);
        await server.close();
        process.exit(0);
      };

      process.on('SIGINT', () => shutdown('SIGINT'));
      process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch((err) => {
      logger.error('Fatal startup error:', err);
      process.exit(1);
    });
}
