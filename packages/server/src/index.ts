/**
 * @fileoverview Main entrypoint for the LAN Whiteboard TCP server.
 * Uses Node.js native 'net' module for raw TCP socket communication.
 * No HTTP frameworks, WebSocket libraries, or cloud dependencies.
 */

import * as net from 'node:net';
import * as os from 'node:os';
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT } from '@cn-whiteboard/common';

/**
 * Configuration options for the TCP Server instance.
 */
export interface ServerConfig {
  /**
   * Host address or interface to bind against (e.g. '0.0.0.0').
   */
  host: string;
  /**
   * TCP port to listen on. Port 0 allows the OS to assign an ephemeral port.
   */
  port: number;
}

/**
 * Gathers and returns a list of non-internal IPv4 addresses assigned to the host.
 * This is vital on a LAN so the host knows which IP to share with peers.
 *
 * @returns Array of IPv4 LAN address strings.
 */
export function getLanAddresses(): string[] {
  const interfaces = os.networkInterfaces();
  const addresses: string[] = [];

  for (const interfaceKey of Object.keys(interfaces)) {
    const netDetails = interfaces[interfaceKey];
    if (!netDetails) continue;

    for (const detail of netDetails) {
      // Filter for IPv4 and skip internal loopback (127.0.0.1)
      if (detail.family === 'IPv4' && !detail.internal) {
        addresses.push(detail.address);
      }
    }
  }

  return addresses;
}

/**
 * Creates and configures the raw TCP server instance with connection handling.
 *
 * @param config Optional configuration overriding host and port.
 * @returns An initialized net.Server instance.
 */
export function createTcpServer(): net.Server {
  const activeSockets = new Set<net.Socket>();

  const server = net.createServer((socket: net.Socket) => {
    const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    activeSockets.add(socket);
    console.log(
      `[TCP Server] Client connected from ${remoteAddress} (Total active: ${activeSockets.size})`,
    );

    // Disable Nagle's algorithm for low-latency interactive drawing data
    socket.setNoDelay(true);

    socket.on('data', (data: Buffer) => {
      // In Phase 0, we verify socket duplex read/write
      console.log(`[TCP Server] Received ${data.length} bytes from ${remoteAddress}`);
      // Echo or acknowledge for connection testing
      socket.write(Buffer.from(`ACK:${data.length}\n`, 'utf-8'));
    });

    socket.on('error', (err: Error) => {
      console.warn(`[TCP Server] Socket error from ${remoteAddress}:`, err.message);
    });

    socket.on('close', (hadError: boolean) => {
      activeSockets.delete(socket);
      console.log(
        `[TCP Server] Connection closed from ${remoteAddress} (hadError=${hadError}, Total active: ${activeSockets.size})`,
      );
    });
  });

  return server;
}

/**
 * Parses command-line arguments to extract host and port configurations.
 * Supports flags: --host <address>, --port <number>
 *
 * @param argv Command line arguments array (e.g. process.argv)
 * @returns Parsed ServerConfig
 */
export function parseArgs(argv: string[]): ServerConfig {
  let host = DEFAULT_SERVER_HOST;
  let port = DEFAULT_SERVER_PORT;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host' && argv[i + 1]) {
      host = argv[i + 1]!;
      i++;
    } else if (arg === '--port' && argv[i + 1]) {
      const parsedPort = parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(parsedPort) && parsedPort >= 0 && parsedPort <= 65535) {
        port = parsedPort;
      }
      i++;
    }
  }

  return { host, port };
}

/**
 * Starts the TCP server and outputs operational networking details.
 */
export async function startServer(config?: Partial<ServerConfig>): Promise<{
  server: net.Server;
  port: number;
  host: string;
}> {
  const resolvedConfig: ServerConfig = {
    host: config?.host ?? DEFAULT_SERVER_HOST,
    port: config?.port ?? DEFAULT_SERVER_PORT,
  };

  const server = createTcpServer();

  return new Promise((resolve, reject) => {
    server.on('error', (err) => {
      reject(err);
    });

    server.listen(resolvedConfig.port, resolvedConfig.host, () => {
      const addressInfo = server.address() as net.AddressInfo;
      const boundPort = addressInfo.port;
      const boundHost = addressInfo.address;

      console.log('========================================================');
      console.log(`  LAN Collaborative Whiteboard - TCP Server (Phase 0)  `);
      console.log('========================================================');
      console.log(`[TCP Server] Bound and listening on ${boundHost}:${boundPort}`);

      const lanIps = getLanAddresses();
      if (lanIps.length > 0) {
        console.log('[TCP Server] Accessible on your Local Area Network via:');
        for (const ip of lanIps) {
          console.log(`  -> tcp://${ip}:${boundPort}`);
        }
      } else {
        console.log('[TCP Server] No external LAN interface detected (listening on localhost)');
      }
      console.log('--------------------------------------------------------');

      resolve({ server, port: boundPort, host: boundHost });
    });
  });
}

// Execute standalone when invoked directly from CLI
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
  const config = parseArgs(process.argv);
  startServer(config).catch((err) => {
    console.error('[TCP Server] Fatal startup failure:', err);
    process.exit(1);
  });
}
