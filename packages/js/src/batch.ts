import { IngestOptions, IngestStatus } from './client.js';
import safeStringify from './safeStringify.js';

export type IngestFunction = (
  id: string,
  events: Array<object> | object,
  options?: IngestOptions,
) => Promise<IngestStatus>;

export function createBatchKey(id: string, options?: IngestOptions): string {
  return `${id}:${options?.timestampField || '-'}:${options?.timestampFormat || '-'}:${options?.csvDelimiter || '-'}`;
}

export class Batch {
  ingestFn: IngestFunction;
  id: string;
  options?: IngestOptions;

  events: Array<object> = [];

  activeFlush: Promise<IngestStatus | void> = Promise.resolve();
  nextFlush: NodeJS.Timeout = setTimeout(() => {}, 0);
  lastFlush: Date = new Date();

  constructor(ingestFn: IngestFunction, id: string, options?: IngestOptions) {
    this.ingestFn = ingestFn;
    this.id = id;
    this.options = options;
  }

  ingest = (events: Array<object> | object) => {
    if (Array.isArray(events)) {
      this.events = this.events.concat(events);
    } else {
      this.events.push(events);
    }

    if (this.events.length >= 1000 || this.lastFlush.getTime() < Date.now() - 1000) {
      // We either have more than 1k events or the last flush was more than 1s ago
      clearTimeout(this.nextFlush);
      this.activeFlush = this.flush();
    } else {
      // Create a timeout so we flush remaining events even if no more come in
      clearTimeout(this.nextFlush);
      this.nextFlush = setTimeout(() => {
        this.activeFlush = this.flush();
      }, 1000);
    }
  };

  flush = async (): Promise<IngestStatus | undefined> => {
    const events = this.events.splice(0, this.events.length);

    clearTimeout(this.nextFlush);
    await this.activeFlush;

    if (events.length === 0) {
      this.lastFlush = new Date(); // we tried
      return;
    }

    let res;
    try {
      res = await this.ingestFn(this.id, events, this.options);
    } catch (error) {
      const msg = `Got error when trying to send logs to axiom: ${error instanceof Error && error.message}`;
      console.log(msg);
      const msgWithPayload = `Failed log payload: ${safeStringify(events)}`;
      console.log(msgWithPayload);

      await this.ingestFn(this.id, { _time: Date.now(), level: 'error', msg }, this.options).catch();
      await this.ingestFn(this.id, { _time: Date.now(), level: 'error', msg: msgWithPayload }, this.options).catch();
    }

    this.lastFlush = new Date();
    return res;
  };
}
