/**
 * @fileoverview CLI argument parser and server configuration loader.
 */

import * as path from 'node:path';
import { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, DISCOVERY_PORT } from '@cn-whiteboard/common';

/**
 * Server runtime configuration options.
 */
export interface ServerConfig {
  host: string;
  port: number;
  dataDir: string;
  verbose: boolean;
  /** UDP port for LAN discovery, or undefined when disabled with --no-discovery. */
  discoveryPort?: number;
  /**
   * Interval of the liveness sweep that drops silent clients. Defaults to HEARTBEAT_INTERVAL_MS.
   * Not exposed as a CLI flag; tests shorten it to exercise timeouts quickly.
   */
  heartbeatIntervalMs?: number;
  /**
   * Silence after which a client is considered dead. Defaults to HEARTBEAT_TIMEOUT_MS.
   */
  heartbeatTimeoutMs?: number;
}

/**
 * Parses command-line arguments to construct ServerConfig.
 *
 * Supported flags:
 * - `--host <ip>`: Bind address (default: 0.0.0.0)
 * - `--port <number>`: TCP port to listen on (default: 4000)
 * - `--data-dir <path>`: Directory for persistence files (default: ./data)
 * - `--discovery-port <number>`: UDP port answering LAN discovery probes (default: 45454)
 * - `--no-discovery`: Do not answer LAN discovery probes
 * - `--verbose` or `-v`: Enable verbose debug logging
 *
 * @param argv Command line argument array (defaults to process.argv)
 */
export function parseConfig(argv: string[] = process.argv): ServerConfig {
  let host = DEFAULT_SERVER_HOST;
  let port = DEFAULT_SERVER_PORT;
  let dataDir = path.resolve(process.cwd(), 'data');
  let verbose = false;
  let discoveryPort: number | undefined = DISCOVERY_PORT;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--host' && argv[i + 1]) {
      host = argv[i + 1]!;
      i++;
    } else if (arg === '--port' && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 65535) {
        port = parsed;
      }
      i++;
    } else if (arg === '--data-dir' && argv[i + 1]) {
      dataDir = path.resolve(process.cwd(), argv[i + 1]!);
      i++;
    } else if (arg === '--discovery-port' && argv[i + 1]) {
      const parsed = parseInt(argv[i + 1]!, 10);
      if (!Number.isNaN(parsed) && parsed >= 0 && parsed <= 65535) {
        discoveryPort = parsed;
      }
      i++;
    } else if (arg === '--no-discovery') {
      discoveryPort = undefined;
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true;
    }
  }

  return { host, port, dataDir, verbose, discoveryPort };
}
