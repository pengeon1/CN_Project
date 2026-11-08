import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, encodeFrame, FrameDecoder, MessageType } from '@cn-whiteboard/common';
import { parseConfig, WhiteboardServer } from '../src/index.js';
import { closeIsolatedServer, startIsolatedServer } from './helpers/isolated-server.js';

describe('Server CLI & Smoke Suite', () => {
  let activeServer: WhiteboardServer | undefined;

  afterEach(async () => {
    if (activeServer) {
      await closeIsolatedServer(activeServer);
      activeServer = undefined;
    }
  });

  it('correctly parses CLI flags (--host, --port, --data-dir, --verbose)', () => {
    const config = parseConfig([
      'node',
      'server.js',
      '--host',
      '192.168.1.100',
      '--port',
      '8080',
      '--data-dir',
      './my-data',
      '--verbose',
    ]);
    expect(config.host).toBe('192.168.1.100');
    expect(config.port).toBe(8080);
    expect(config.dataDir).toContain('my-data');
    expect(config.verbose).toBe(true);
  });

  it('detects system LAN addresses or returns array', () => {
    const addresses = WhiteboardServer.getLanAddresses();
    expect(Array.isArray(addresses)).toBe(true);
    for (const ip of addresses) {
      expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    }
  });

  it('starts TCP server and handles a framed PING message with PONG response', async () => {
    const { server, port, host } = await startIsolatedServer({ host: '127.0.0.1', port: 0 });
    activeServer = server;

    expect(port).toBeGreaterThan(0);
    expect(host).toBe('127.0.0.1');

    const clientSocket = net.createConnection({ host: '127.0.0.1', port });
    const decoder = new FrameDecoder();

    const pongReceived = await new Promise<boolean>((resolve, reject) => {
      clientSocket.on('connect', () => {
        const pingEnvelope = createEnvelope(MessageType.PING, { nonce: 9999 });
        clientSocket.write(encodeFrame(pingEnvelope));
      });

      clientSocket.on('data', (chunk) => {
        const messages = decoder.feed(chunk);
        for (const msg of messages) {
          if (msg.type === MessageType.PONG) {
            const payload = msg.payload as { nonce: number; serverTs: number };
            expect(payload.nonce).toBe(9999);
            expect(payload.serverTs).toBeGreaterThan(0);
            clientSocket.end();
            resolve(true);
            return;
          }
        }
      });

      clientSocket.on('error', (err) => reject(err));
    });

    expect(pongReceived).toBe(true);
  });
});
