/**
 * @fileoverview Minimal real-socket test client shared by integration tests.
 */
import * as net from 'node:net';
import {
  createEnvelope,
  encodeFrame,
  FrameDecoder,
  type MessageEnvelope,
  MessageType,
} from '@cn-whiteboard/common';

export class Client {
  queue: MessageEnvelope[] = [];
  userId = '';
  private decoder = new FrameDecoder();
  private waiters: Array<() => void> = [];
  constructor(public socket: net.Socket) {
    socket.on('data', (c) => {
      this.queue.push(...this.decoder.feed(c));
      this.waiters.splice(0).forEach((w) => w());
    });
    socket.on('error', () => undefined);
  }
  static async connect(port: number): Promise<Client> {
    return new Promise((res) => {
      const s = net.createConnection({ port, host: '127.0.0.1' }, () => res(new Client(s)));
    });
  }
  send(type: MessageType, payload: unknown, room?: string): void {
    this.socket.write(encodeFrame(createEnvelope(type, payload, { user_id: this.userId, room })));
  }
  async waitFor(type: MessageType, ms = 3000): Promise<MessageEnvelope> {
    const end = Date.now() + ms;
    for (;;) {
      const i = this.queue.findIndex((m) => m.type === type);
      if (i >= 0) return this.queue.splice(i, 1)[0]!;
      if (Date.now() > end) throw new Error(`Timeout waiting for ${type}`);
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  async hello(name: string): Promise<void> {
    this.send(MessageType.HELLO, { clientVersion: '0.1.0', suggestedUsername: name });
    this.userId = (await this.waitFor(MessageType.AUTH_OK)).payload.userId as string;
  }
}
