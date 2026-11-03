import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { getLanAddresses, parseArgs, startServer } from '../src/index.js';

describe('Server core smoke test suite', () => {
  let activeServer: net.Server | undefined;

  afterEach(async () => {
    if (activeServer) {
      await new Promise<void>((resolve) => activeServer!.close(() => resolve()));
      activeServer = undefined;
    }
  });

  it('correctly parses CLI flags', () => {
    const config = parseArgs(['node', 'server.js', '--host', '192.168.1.100', '--port', '8080']);
    expect(config.host).toBe('192.168.1.100');
    expect(config.port).toBe(8080);
  });

  it('detects system LAN addresses or returns array', () => {
    const addresses = getLanAddresses();
    expect(Array.isArray(addresses)).toBe(true);
    for (const ip of addresses) {
      // Must be a valid IPv4 format
      expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    }
  });

  it('starts a TCP server on an ephemeral port and handles raw socket connections', async () => {
    const { server, port, host } = await startServer({ host: '127.0.0.1', port: 0 });
    activeServer = server;

    expect(port).toBeGreaterThan(0);
    expect(host).toBe('127.0.0.1');

    // Create a real TCP client connection using Node's net module
    const clientSocket = net.createConnection({ host: '127.0.0.1', port });

    const receivedChunks: Buffer[] = [];

    await new Promise<void>((resolve, reject) => {
      clientSocket.on('connect', () => {
        clientSocket.write('HELLO_TCP_SERVER');
      });

      clientSocket.on('data', (chunk) => {
        receivedChunks.push(chunk);
        clientSocket.end();
      });

      clientSocket.on('end', () => {
        resolve();
      });

      clientSocket.on('error', (err) => {
        reject(err);
      });
    });

    const fullResponse = Buffer.concat(receivedChunks).toString('utf-8');
    expect(fullResponse).toContain('ACK:16');
  });
});
