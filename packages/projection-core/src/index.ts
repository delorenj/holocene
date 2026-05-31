import type { ModuleEvent } from "@holocene/module-sdk";

export class ProjectionEngine<TState> {
  constructor(
    private state: TState,
    private readonly reducer: (state: TState, event: ModuleEvent) => TState
  ) {}

  apply(events: ModuleEvent[]) {
    for (const event of events) this.state = this.reducer(this.state, event);
    return this.state;
  }

  snapshot() {
    return this.state;
  }
}
