export type ModuleEvent = {
  id: string;
  type: string;
  subject?: string;
  time?: string;
  data?: unknown;
};

export type ModuleMeta = {
  id: string;
  title: string;
  version: string;
  owner?: string;
  tags?: string[];
};

export type ModuleCommand = {
  id: string;
  title: string;
  run: (input?: unknown) => Promise<unknown>;
};

export type ModuleDefinition<TState = unknown> = {
  meta: ModuleMeta;
  subscriptions: string[];
  initialState: TState;
  reduce: (state: TState, event: ModuleEvent) => TState;
  commands?: ModuleCommand[];
};

export function listRegisteredModules(modules: ModuleDefinition<any>[]) {
  return modules;
}
