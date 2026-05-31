import type { ModuleEvent } from "@holocene/module-sdk";

export type BloodbankSubscription = {
  subjects: string[];
  fromTime?: string;
};

export type BloodbankEvent = ModuleEvent;

export interface BloodbankClient {
  subscribe(
    subscription: BloodbankSubscription,
    onEvents: (events: BloodbankEvent[]) => void
  ): Promise<() => Promise<void>>;
}

export class StubBloodbankClient implements BloodbankClient {
  async subscribe(
    _subscription: BloodbankSubscription,
    _onEvents: (events: BloodbankEvent[]) => void
  ) {
    return async () => undefined;
  }
}
