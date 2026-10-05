// 33GOD component kit: window.ThirtyThree. Types as documentation.
import type * as React from 'react';

/** The signal ladder, most urgent first. Shape carries the state; colour confirms it. */
export type SignalState = 'you' | 'broken' | 'stuck' | 'working' | 'quiet' | 'cleared' | 'unknown';
/** stale: older than its budget (rendered with a ~). unobserved: never seen (rendered as no signal). */
export type Freshness = 'fresh' | 'stale' | 'unobserved';
export type IconName = 'copy' | 'check' | 'external' | 'chevronRight' | 'chevronDown' | 'pane' | 'commit' | 'branch' | 'search' | 'x' | 'enter' | 'restart' | 'pause' | 'play' | 'filter' | 'ticket' | 'unit';
export type RefKind = 'ticket' | 'commit' | 'branch' | 'card' | 'worker' | 'pane' | 'session' | 'subject' | 'unit' | 'path';

export interface GlyphProps { state: SignalState; size?: number; title?: string; className?: string }
export interface SignalProps {
  state: SignalState;
  /** Defaults to the ladder word ("Needs you", "Broken", ...). false renders the glyph alone; give it a title. */
  label?: React.ReactNode | false;
  freshness?: Freshness;
  count?: number;
  size?: 'sm' | 'md';
  title?: string;
}
export interface AgeProps {
  /** Elapsed seconds. */
  seconds?: number;
  /** Or a start instant; then the value ticks every second. */
  since?: string | number | Date;
  /** Staleness budget in seconds. Over it, the value turns stuck and says by how much. */
  budget?: number;
  showBudget?: boolean;
  /** "waiting", "held", "updated" */
  verb?: string;
  ago?: boolean;
}
export interface IconProps { name: IconName; size?: number; title?: string }
export interface KbdProps { /** "mod+k", "/", "enter", "esc", "shift+j" */ keys: string }
export interface RefProps {
  kind?: RefKind;
  value: string;
  /** What a click copies, when it differs from the value. */
  copy?: string;
  /** Adds an open-in-new-tab arrow. The chip itself always copies. */
  href?: string;
  /** Middle-truncate past this many characters. Commits default to 7. */
  max?: number;
}
export interface ButtonProps {
  variant?: 'primary' | 'quiet' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Two-step press. The first press arms the button and shows this label for duration-armed. */
  confirm?: string;
  icon?: IconName;
  kbd?: string;
  busy?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  children?: React.ReactNode;
  title?: string;
  type?: 'button' | 'submit';
}
export interface SegmentedOption { value: string; label: React.ReactNode; count?: number }
export interface SegmentedProps {
  options: SegmentedOption[];
  value: string;
  /** Omit for an uncontrolled control. */
  onChange?: (value: string) => void;
  /** Accessible name of the group. */
  label: string;
  size?: 'sm' | 'md';
}
export interface QueryFieldProps {
  value?: string;
  onChange?: (value: string) => void;
  matches?: number;
  suggestions?: string[];
  placeholder?: string;
}
export interface PanelProps {
  title: React.ReactNode;
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  flush?: boolean;
  children?: React.ReactNode;
}
export type NeedsYouKind = 'gate' | 'bell' | 'decision' | 'acknowledge';
export interface NeedsYouProps {
  /** gate: a live process blocked on a permission prompt. bell: a soft ping. decision, acknowledge: ticket states. */
  kind: NeedsYouKind;
  title: React.ReactNode;
  meta?: React.ReactNode;
  /** Seconds waiting. */
  waiting: number;
  action?: { label: string; onPress?: () => void; kbd?: string };
  /** Usually a pane Ref. */
  where?: React.ReactNode;
}
export interface AgentLineProps {
  name: string;
  /** Raw ASM state: awaiting_human | failed | stale | gone | delegating | tool_running | working | starting | idle | unknown */
  state: string;
  doing?: React.ReactNode;
  /** Seconds in this state (held_ms / 1000). */
  held: number;
  /** Phase budget in seconds. A working agent past it reads as stuck. */
  budget?: number;
  cli?: string;
  repo?: string;
  tools?: number;
  subs?: number;
  ticket?: React.ReactNode;
  pane?: React.ReactNode;
  freshness?: Freshness;
}
export interface EventRowProps {
  /** Wall clock with milliseconds, already formatted. */
  time: string;
  /** CloudEvents type, e.g. bloodbank.agent.tool.completed */
  type: string;
  headline: React.ReactNode;
  actor?: string;
  project?: string;
  durationMs?: number;
  failed?: boolean;
  /** Hide the bloodbank. namespace. Default true. */
  compact?: boolean;
}
export interface EventBurstProps {
  count: number;
  type: string;
  from: string;
  to: string;
  /** Seconds between first and last event. */
  span: number;
  breakdown: { label: string; count: number }[];
  actor?: string;
  project?: string;
  rate?: number[];
  /** The individual rows, shown when opened. */
  children?: React.ReactNode;
  defaultOpen?: boolean;
}
export interface Phase {
  id: string;
  label?: string;
  status: 'done' | 'current' | 'next' | 'blocked' | 'skipped';
  /** Seconds spent. */
  spent?: number;
  /** krebs staleness budget in seconds. */
  budget?: number;
  note?: string;
}
export interface LifecycleTrackProps { phases: Phase[]; reason?: React.ReactNode }
export interface TapeSegment { state: SignalState; seconds: number; note?: string }
export interface StateTapeProps { segments: TapeSegment[]; start?: string; end?: string; totals?: SignalState[] }
export interface SparkProps { values: number[]; width?: number; height?: number; state?: SignalState; label?: string }
export interface ReadingProps {
  label: string;
  value: number | string;
  of?: number;
  unit?: string;
  note?: React.ReactNode;
  state?: SignalState;
  trend?: number[];
  /** Seconds since the reading, and the budget past which it is stale. */
  age?: number;
  maxAge?: number;
}
export interface CensusItem { id: string; label: string; state: SignalState; detail?: string }
export interface CensusProps { items: CensusItem[]; noun: string; name?: number; cell?: number }
export interface StrataLayer { id: string; label: string; values: number[] }
export interface StrataMark { at: number; label: string }
export interface StrataProps {
  /** Bottom to top; layer n takes series-n. */
  layers: StrataLayer[];
  /** Own lane, own scale. */
  errors?: number[];
  marks?: StrataMark[];
  buckets: string[];
  unit?: string;
  height?: number;
  marksLabel?: string;
}
export interface Source { name: string; value?: string; age?: number; max?: number; down?: boolean }
export interface SourceStripProps { sources: Source[] }
export interface Check { name: string; result: string; state?: SignalState }
export interface AllClearProps { statement?: React.ReactNode; checks: Check[]; newest: number }

export declare function Glyph(props: GlyphProps): React.ReactElement;
export declare function Signal(props: SignalProps): React.ReactElement;
export declare function Age(props: AgeProps): React.ReactElement;
export declare function Icon(props: IconProps): React.ReactElement;
export declare function Kbd(props: KbdProps): React.ReactElement;
export declare function Ref(props: RefProps): React.ReactElement;
export declare function Button(props: ButtonProps): React.ReactElement;
export declare function Segmented(props: SegmentedProps): React.ReactElement;
export declare function QueryField(props: QueryFieldProps): React.ReactElement;
export declare function Panel(props: PanelProps): React.ReactElement;
export declare function NeedsYou(props: NeedsYouProps): React.ReactElement;
export declare function AgentLine(props: AgentLineProps): React.ReactElement;
export declare function Subject(props: { type: string; compact?: boolean; failed?: boolean }): React.ReactElement;
export declare function EventRow(props: EventRowProps): React.ReactElement;
export declare function EventBurst(props: EventBurstProps): React.ReactElement;
export declare function LifecycleTrack(props: LifecycleTrackProps): React.ReactElement;
export declare function StateTape(props: StateTapeProps): React.ReactElement;
export declare function Spark(props: SparkProps): React.ReactElement;
export declare function Reading(props: ReadingProps): React.ReactElement;
export declare function Census(props: CensusProps): React.ReactElement;
export declare function Strata(props: StrataProps): React.ReactElement;
export declare function SourceStrip(props: SourceStripProps): React.ReactElement;
export declare function AllClear(props: AllClearProps): React.ReactElement;

/** 14s · 12m · 1h 06m · 2h · 4d 02h · 98d */
export declare function formatDuration(seconds: number): string;
/** 312 ms · 1.4 s · 2m 05s */
export declare function formatMs(ms: number): string;
export declare function middleTruncate(value: string, max: number): string;
export declare function signalFromAsm(state: string): SignalState;
export declare const SIGNAL_ORDER: SignalState[];
/** triage 10m · refining 30m · ready · in_progress 2h · review 15m · qa 1h · done */
export declare const KREBS_PHASES: Phase[];

declare global {
  interface Window {
    ThirtyThree: {
      Glyph: typeof Glyph; Signal: typeof Signal; Age: typeof Age; Icon: typeof Icon; Kbd: typeof Kbd; Ref: typeof Ref;
      Button: typeof Button; Segmented: typeof Segmented; QueryField: typeof QueryField; Panel: typeof Panel;
      NeedsYou: typeof NeedsYou; AgentLine: typeof AgentLine; Subject: typeof Subject; EventRow: typeof EventRow; EventBurst: typeof EventBurst;
      LifecycleTrack: typeof LifecycleTrack; StateTape: typeof StateTape; Spark: typeof Spark; Reading: typeof Reading;
      Census: typeof Census; Strata: typeof Strata; SourceStrip: typeof SourceStrip; AllClear: typeof AllClear;
      formatDuration: typeof formatDuration; formatMs: typeof formatMs; middleTruncate: typeof middleTruncate;
      signalFromAsm: typeof signalFromAsm; SIGNAL_ORDER: typeof SIGNAL_ORDER; KREBS_PHASES: typeof KREBS_PHASES;
    };
  }
}
