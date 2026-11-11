/**
 * @fileoverview Entry point of the standalone server executable (built with pkg).
 * Handles --help / --version, otherwise starts the server unconditionally.
 */

import { APP_NAME, APP_VERSION } from '@cn-whiteboard/common';
import { runCli } from './index.js';

const HELP = `${APP_NAME} server ${APP_VERSION}

Usage: whiteboard-server [options]

  --host <ip>              Address to bind (default 0.0.0.0, all interfaces)
  --port <number>          TCP port clients connect to (default 4000)
  --data-dir <path>        Where rooms are saved (default ./data)
  --discovery-port <n>     UDP port for LAN discovery (default 45454)
  --no-discovery           Do not answer LAN discovery probes
  -v, --verbose            Verbose logging
  -h, --help               Show this help
  --version                Show the version

Needs no internet. Allow the TCP port (and UDP 45454 for discovery) through the firewall.
`;

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(HELP);
} else if (args.includes('--version')) {
  console.log(APP_VERSION);
} else {
  runCli();
}
