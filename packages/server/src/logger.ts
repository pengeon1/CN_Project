/**
 * @fileoverview Structured logging utility for the server.
 * Provides timestamped, leveled logs with context tags.
 */

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export class Logger {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private format(level: LogLevel, message: string, details?: unknown): string {
    const timestamp = new Date().toISOString();
    let formatted = `[${timestamp}] [${level}] [${this.context}] ${message}`;
    if (details !== undefined) {
      if (details instanceof Error) {
        formatted += `\n${details.stack || details.message}`;
      } else if (typeof details === 'object') {
        formatted += ` ${JSON.stringify(details)}`;
      } else {
        formatted += ` ${String(details)}`;
      }
    }
    return formatted;
  }

  public debug(message: string, details?: unknown): void {
    if (process.env.DEBUG || process.env.VERBOSE) {
      console.debug(this.format('DEBUG', message, details));
    }
  }

  public info(message: string, details?: unknown): void {
    console.log(this.format('INFO', message, details));
  }

  public warn(message: string, details?: unknown): void {
    console.warn(this.format('WARN', message, details));
  }

  public error(message: string, details?: unknown): void {
    console.error(this.format('ERROR', message, details));
  }
}
