import { randomUUID } from "node:crypto";
import { connect } from "@nats-io/transport-node";
import { DeliverPolicy, jetstream, jetstreamManager } from "@nats-io/jetstream";

export type BloodbankEvent = {
  id: string;
  type: string;
  subject?: string;
  time?: string;
  data?: unknown;
  [key: string]: unknown;
};
export type StreamPosition = { name: string; created: string; first: number; last: number };
export type BloodbankDelivery = { stream: string; sequence: number; subject: string; data: Uint8Array; pending?: number };
export type BloodbankConnection = { messages: AsyncIterable<BloodbankDelivery>; close(): Promise<void> };
export interface BloodbankClient {
  connect(options: {
    checkpoint: (stream: StreamPosition) => number;
    onStatus: (state: "live" | "reconnecting") => void;
  }): Promise<BloodbankConnection>;
}

/** Read side only. The ordered consumer resumes from the caller's committed checkpoint. */
export class NatsBloodbankClient implements BloodbankClient {
  constructor(private options: { servers?: string; stream?: string } = {}) {}

  async connect(options: Parameters<BloodbankClient["connect"]>[0]): Promise<BloodbankConnection> {
    const nc = await connect({
      servers: this.options.servers ?? "nats://localhost:4222",
      name: "holocene-event-collector", timeout: 5000,
      maxReconnectAttempts: -1, reconnectTimeWait: 1000,
    });
    try {
      const manager = await jetstreamManager(nc);
      const stream = this.options.stream ?? "BLOODBANK_EVENTS";
      const info = await manager.streams.info(stream);
      const after = options.checkpoint({
        name: stream, created: info.created, first: info.state.first_seq, last: info.state.last_seq,
      });
      const consumer = await jetstream(nc).consumers.get(stream, {
        name_prefix: `holocene_${randomUUID().replaceAll("-", "")}`, filter_subjects: "bloodbank.evt.>",
        deliver_policy: after > 0 ? DeliverPolicy.StartSequence : DeliverPolicy.All,
        ...(after > 0 ? { opt_start_seq: after + 1 } : {}),
        inactive_threshold: 60_000, // OrderedConsumerOptions takes milliseconds.
      });
      const messages = await consumer.consume({ max_messages: 100 });
      void (async () => {
        for await (const status of nc.status()) {
          if (status.type === "disconnect") {
            options.onStatus("reconnecting");
            // Re-open from the durable checkpoint and re-check retention boundaries.
            messages.stop(); await nc.close(); break;
          }
          if (status.type === "reconnect") options.onStatus("live");
        }
      })().catch(() => undefined);
      options.onStatus("live");
      let closed = false;
      return {
        messages: (async function* () {
          for await (const message of messages) {
            yield { stream, sequence: message.seq, subject: message.subject, data: message.data, pending: message.info.pending };
          }
        })(),
        async close() {
          if (closed) return;
          closed = true; messages.stop();
          await consumer.delete().catch(() => undefined);
          await nc.close();
        },
      };
    } catch (error) { await nc.close(); throw error; }
  }
}
