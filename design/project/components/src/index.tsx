// 33GOD component kit. Compiled by scripts/build.mjs into components/bundle.js,
// a classic script that reads window.React / window.ReactDOM and assigns
// window.ThirtyThree. Every colour, size and duration comes from tokens.css.

const React: any = (window as any).React;
const { useState, useEffect, useRef, useMemo, useCallback, useId } = React;

type Node = any;
const cx = (...parts: any[]) => parts.filter(Boolean).join(' ');

/* ------------------------------------------------------------------ */
/* Signal ladder                                                       */
/* ------------------------------------------------------------------ */

export type SignalState = 'you' | 'broken' | 'stuck' | 'working' | 'quiet' | 'cleared' | 'unknown';
export type Freshness = 'fresh' | 'stale' | 'unobserved';

const SIGNAL_LABEL: Record<SignalState, string> = {
  you: 'Needs you',
  broken: 'Broken',
  stuck: 'Stuck',
  working: 'Working',
  quiet: 'Quiet',
  cleared: 'Cleared',
  unknown: 'No signal',
};

// Severity order, most urgent first. Lists sort by this, then by age.
export const SIGNAL_ORDER: SignalState[] = ['you', 'broken', 'stuck', 'working', 'unknown', 'quiet', 'cleared'];

// ASM process states → the ladder. The raw state stays visible as data.
const ASM_TO_SIGNAL: Record<string, SignalState> = {
  awaiting_human: 'you',
  failed: 'broken',
  stale: 'stuck',
  gone: 'unknown',
  delegating: 'working',
  tool_running: 'working',
  working: 'working',
  starting: 'working',
  idle: 'quiet',
  unknown: 'unknown',
};
export const signalFromAsm = (state: string): SignalState => ASM_TO_SIGNAL[state] ?? 'unknown';

export interface GlyphProps { state: SignalState; size?: number; title?: string; className?: string }

/** The seven state shapes. Shape carries the meaning; colour confirms it. */
export function Glyph({ state, size = 10, title, className }: GlyphProps) {
  const common = {
    width: size, height: size, viewBox: '0 0 10 10',
    className: cx('tt-glyph', 'tt-sig--' + state, className),
    role: title ? 'img' : undefined,
    'aria-hidden': title ? undefined : true,
    'aria-label': title,
  };
  switch (state) {
    case 'you':
      return <svg {...common}><path d="M5 .55 9.45 5 5 9.45.55 5Z" fill="currentColor" /></svg>;
    case 'broken':
      return <svg {...common}><rect x="1" y="1" width="8" height="8" rx=".6" fill="currentColor" /></svg>;
    case 'stuck':
      return <svg {...common}><path d="M1.2 1h7.6L5 4.85ZM1.2 9h7.6L5 5.15Z" fill="currentColor" /></svg>;
    case 'working':
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="3.7" fill="none" stroke="currentColor" strokeWidth="1.3" opacity=".32" />
          <g className="tt-orbit"><path d="M5 1.3a3.7 3.7 0 0 1 3.7 3.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></g>
        </svg>
      );
    case 'quiet':
      return <svg {...common}><rect x="1.4" y="4.25" width="7.2" height="1.5" rx=".75" fill="currentColor" /></svg>;
    case 'cleared':
      return <svg {...common}><circle cx="5" cy="5" r="4" fill="currentColor" /></svg>;
    default:
      return <svg {...common}><circle cx="5" cy="5" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.45 1.35" /></svg>;
  }
}

export interface SignalProps {
  state: SignalState;
  /** Override the default word. Pass false for a glyph alone (then give it a title). */
  label?: Node | false;
  /** stale: last reading is older than its budget. unobserved: never seen. */
  freshness?: Freshness;
  /** Shown after the label, e.g. a count. */
  count?: number;
  size?: 'sm' | 'md';
  title?: string;
}

/** A state glyph and its word. The atom every status in 33GOD is built from. */
export function Signal({ state, label, freshness = 'fresh', count, size = 'md', title }: SignalProps) {
  const shown: SignalState = freshness === 'unobserved' ? 'unknown' : state;
  const word = label === false ? null : label ?? SIGNAL_LABEL[shown];
  return (
    <span className={cx('tt-signal', 'tt-signal--' + size, freshness !== 'fresh' && 'is-' + freshness)} title={title}>
      <Glyph state={shown} size={size === 'sm' ? 8 : 10} title={label === false ? title ?? SIGNAL_LABEL[shown] : undefined} />
      {word != null && <span className="tt-signal-label">{freshness === 'stale' ? '~' : ''}{word}</span>}
      {count != null && <span className="tt-signal-count">{count.toLocaleString('en-US')}</span>}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Time                                                                */
/* ------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, '0');

/** 14s · 12m · 1h 06m · 2h · 4d 02h · 98d. Compact, unambiguous, sortable by eye. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? h + 'h ' + pad(m % 60) + 'm' : h + 'h';
  const d = Math.floor(h / 24);
  if (d < 7) return h % 24 ? d + 'd ' + pad(h % 24) + 'h' : d + 'd';
  return d + 'd';
}

/** 312 ms · 1.4 s · 2m 05s. Matches how the hook hub reports handler time. */
export function formatMs(ms: number): string {
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s';
  const s = Math.round(ms / 1000);
  return Math.floor(s / 60) + 'm ' + pad(s % 60) + 's';
}

const toDate = (v: any): Date | null => (v == null ? null : v instanceof Date ? v : new Date(v));

function useNow(live: boolean, everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [live, everyMs]);
  return now;
}

export interface AgeProps {
  /** Elapsed seconds, when you already have them (held_ms / 1000). */
  seconds?: number;
  /** Or a start instant; the age then ticks every second. */
  since?: string | number | Date;
  /** Seconds allowed before this becomes stuck (krebs staleness budgets). */
  budget?: number;
  /** Show "of 2h" after the value when a budget is set. */
  showBudget?: boolean;
  /** Word before the value: "waiting", "held", "updated". */
  verb?: string;
  /** Suffix "ago" for instants in the past. */
  ago?: boolean;
}

/** A duration that knows its budget. Turns heather, and says by how much, when over. */
export function Age({ seconds, since, budget, showBudget, verb, ago }: AgeProps) {
  const start = toDate(since);
  const now = useNow(!!start && seconds == null);
  const value = seconds ?? (start ? (now - start.getTime()) / 1000 : 0);
  const over = budget != null && value > budget;
  const iso = start ? start.toISOString() : undefined;
  const title = [start ? start.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'medium' }) : null,
    budget != null ? `budget ${formatDuration(budget)}` : null].filter(Boolean).join(' · ') || undefined;
  return (
    <time className={cx('tt-age', over && 'is-over')} dateTime={iso ?? 'PT' + Math.round(value) + 'S'} title={title}>
      {verb && <span className="tt-age-verb">{verb} </span>}
      <span className="tt-age-value">{formatDuration(value)}</span>
      {ago && <span className="tt-age-verb"> ago</span>}
      {budget != null && showBudget && !over && <span className="tt-age-of"> of {formatDuration(budget)}</span>}
      {over && <span className="tt-age-over"> · {formatDuration(value - (budget as number))} over</span>}
    </time>
  );
}

/* ------------------------------------------------------------------ */
/* Icons (Lucide, ISC licence) and small atoms                         */
/* ------------------------------------------------------------------ */

const ICONS: Record<string, Node> = {
  copy: <><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  external: <><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></>,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  pane: <><path d="m7 11 2-2-2-2" /><path d="M11 13h4" /><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /></>,
  commit: <><circle cx="12" cy="12" r="3" /><line x1="3" x2="9" y1="12" y2="12" /><line x1="15" x2="21" y1="12" y2="12" /></>,
  branch: <><line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></>,
  search: <><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></>,
  x: <><path d="M18 6 6 18" /><path d="m6 6 12 12" /></>,
  enter: <><polyline points="9 10 4 15 9 20" /><path d="M20 4v7a4 4 0 0 1-4 4H4" /></>,
  restart: <><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>,
  pause: <><rect x="14" y="4" width="4" height="16" rx="1" /><rect x="6" y="4" width="4" height="16" rx="1" /></>,
  play: <polygon points="6 3 20 12 6 21 6 3" />,
  filter: <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />,
  ticket: <><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" /><path d="M13 5v2" /><path d="M13 17v2" /><path d="M13 11v2" /></>,
  unit: <><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" /><path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" /></>,
};
export type IconName = keyof typeof ICONS;

export interface IconProps { name: IconName; size?: number; title?: string }
/** Lucide outline icons at a 1.75 stroke. 14px in rows, 16px in controls. */
export function Icon({ name, size = 14, title }: IconProps) {
  return (
    <svg className="tt-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round"
      role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      {ICONS[name]}
    </svg>
  );
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const KEY_GLYPH: Record<string, string> = { enter: '↵', esc: 'Esc', shift: '⇧', alt: isMac() ? '⌥' : 'Alt', up: '↑', down: '↓', left: '←', right: '→', tab: 'Tab', space: 'Space', backspace: '⌫' };

export interface KbdProps { keys: string; }
/** A shortcut, written "mod+k". mod is ⌘ on macOS and Ctrl elsewhere. */
export function Kbd({ keys }: KbdProps) {
  const parts = keys.split('+').map(k => k.trim().toLowerCase());
  return (
    <span className="tt-kbd-group" aria-label={keys.replace('mod', isMac() ? 'Command' : 'Control')}>
      {parts.map((k, i) => (
        <kbd key={i} className="tt-kbd">{k === 'mod' ? (isMac() ? '⌘' : 'Ctrl') : KEY_GLYPH[k] ?? k.toUpperCase()}</kbd>
      ))}
    </span>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e2) { return false; }
  }
}

export type RefKind = 'ticket' | 'commit' | 'branch' | 'card' | 'worker' | 'pane' | 'session' | 'subject' | 'unit' | 'path';
const REF_ICON: Partial<Record<RefKind, IconName>> = { commit: 'commit', branch: 'branch', pane: 'pane', unit: 'unit', ticket: 'ticket' };
const REF_NOUN: Record<RefKind, string> = { ticket: 'ticket', commit: 'commit', branch: 'branch', card: 'Kanban card', worker: 'worker', pane: 'zellij pane', session: 'session', subject: 'subject', unit: 'unit', path: 'path' };

/** Shorten from the middle so both the root and the leaf stay readable. */
export function middleTruncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const keep = max - 1;
  const head = Math.ceil(keep * 0.45);
  return value.slice(0, head) + '…' + value.slice(value.length - (keep - head));
}

export interface RefProps {
  kind?: RefKind;
  value: string;
  /** What the click copies, when it differs from the value (a full SHA, a focus command). */
  copy?: string;
  /** Opens in a new tab from the trailing arrow. The chip itself always copies. */
  href?: string;
  /** Middle-truncate past this many characters. Commits default to 7. */
  max?: number;
}

/** An identifier a machine wrote. Click copies it; the full value is always in the title. */
export function Ref({ kind = 'ticket', value, copy, href, max }: RefProps) {
  const [copied, setCopied] = useState(false);
  const shown = kind === 'commit' && !max ? value.slice(0, 7) : max ? middleTruncate(value, max) : value;
  const target = copy ?? value;
  const onClick = useCallback(async () => {
    if (await copyText(target)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  }, [target]);
  const icon = REF_ICON[kind];
  return (
    <span className={cx('tt-ref', 'tt-ref--' + kind, copied && 'is-copied')}>
      <button type="button" className="tt-ref-chip" onClick={onClick} title={`Copy ${REF_NOUN[kind]} ${target}`}>
        {(icon || copied) && <Icon name={copied ? 'check' : (icon as IconName)} size={12} />}
        <span className="tt-ref-value">{shown}</span>
      </button>
      {href && (
        <a className="tt-ref-open" href={href} target="_blank" rel="noreferrer" title={`Open ${value}`}>
          <Icon name="external" size={12} />
        </a>
      )}
      <span className="tt-sr" aria-live="polite">{copied ? 'Copied' : ''}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Controls                                                            */
/* ------------------------------------------------------------------ */

export interface ButtonProps {
  variant?: 'primary' | 'quiet' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  /** Two-step press: the first arms the button and shows this label, the second acts. */
  confirm?: string;
  icon?: IconName;
  /** Shortcut hint, shown inside the button. */
  kbd?: string;
  busy?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  children?: Node;
  title?: string;
  type?: 'button' | 'submit';
}

/** One button, four voices. Primary at most once per view; destructive actions confirm in place. */
export function Button({ variant = 'quiet', size = 'md', confirm, icon, kbd, busy, disabled, onPress, children, title, type = 'button' }: ButtonProps) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(null as any);
  useEffect(() => () => clearTimeout(timer.current), []);
  const disarm = () => { clearTimeout(timer.current); setArmed(false); };
  const onClick = () => {
    if (busy || disabled) return;
    if (confirm && !armed) {
      setArmed(true);
      const ms = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--duration-armed')) || 4000;
      timer.current = setTimeout(() => setArmed(false), ms);
      return;
    }
    disarm();
    onPress && onPress();
  };
  return (
    <button
      type={type}
      className={cx('tt-btn', 'tt-btn--' + variant, 'tt-btn--' + size, armed && 'is-armed', busy && 'is-busy')}
      onClick={onClick}
      onBlur={armed ? disarm : undefined}
      onKeyDown={(e: any) => { if (e.key === 'Escape' && armed) disarm(); }}
      disabled={disabled}
      aria-busy={busy || undefined}
      title={title}
    >
      {busy ? <Glyph state="working" size={12} /> : icon && <Icon name={icon} size={size === 'sm' ? 13 : 15} />}
      <span className="tt-btn-label">{armed ? confirm : children}</span>
      {kbd && !armed && <Kbd keys={kbd} />}
      {armed && <span className="tt-btn-fuse" aria-hidden="true" />}
    </button>
  );
}

export interface SegmentedOption { value: string; label: Node; count?: number }
export interface SegmentedProps { options: SegmentedOption[]; value: string; onChange?: (value: string) => void; label: string; size?: 'sm' | 'md' }

/** Mutually exclusive views of the same data: time windows, lenses. Arrow keys move. */
export function Segmented({ options, value, onChange, label, size = 'md' }: SegmentedProps) {
  const [inner, setInner] = useState(value);
  const current = onChange ? value : inner;
  const set = (v: string) => (onChange ? onChange(v) : setInner(v));
  const refs = useRef([] as any[]);
  const onKey = (e: any, i: number) => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const n = (i + d + options.length) % options.length;
    set(options[n].value);
    refs.current[n] && refs.current[n].focus();
  };
  return (
    <div className={cx('tt-seg', 'tt-seg--' + size)} role="radiogroup" aria-label={label}>
      {options.map((o, i) => {
        const on = o.value === current;
        return (
          <button key={o.value} ref={(el: any) => (refs.current[i] = el)} type="button" role="radio" aria-checked={on}
            tabIndex={on ? 0 : -1} className={cx('tt-seg-opt', on && 'is-on')} onClick={() => set(o.value)} onKeyDown={(e: any) => onKey(e, i)}>
            {o.label}
            {o.count != null && <span className="tt-seg-count">{o.count.toLocaleString('en-US')}</span>}
          </button>
        );
      })}
    </div>
  );
}

export interface QueryFieldProps {
  value?: string;
  onChange?: (value: string) => void;
  /** Matching events in the current window, when known. */
  matches?: number;
  suggestions?: string[];
  placeholder?: string;
}

const SUBJECT_RE = /^([A-Za-z0-9_-]+|\*)(\.([A-Za-z0-9_-]+|\*))*(\.>)?$|^>$/;

/** A NATS subject filter. * matches one token, > matches the rest. Slash focuses it. */
export function QueryField({ value, onChange, matches, suggestions = [], placeholder = 'bloodbank.agent.>' }: QueryFieldProps) {
  const [inner, setInner] = useState(value ?? '');
  const v = onChange ? value ?? '' : inner;
  const set = (s: string) => (onChange ? onChange(s) : setInner(s));
  const input = useRef(null as any);
  const id = useId();
  useEffect(() => {
    const onKey = (e: any) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) {
        e.preventDefault();
        input.current && input.current.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const invalid = v.trim() !== '' && !SUBJECT_RE.test(v.trim());
  return (
    <div className={cx('tt-query', invalid && 'is-invalid')}>
      <label className="tt-query-box" htmlFor={id}>
        <Icon name="filter" size={14} />
        <span className="tt-query-key">subject</span>
        <input id={id} ref={input} className="tt-query-input" value={v} placeholder={placeholder} spellCheck={false}
          autoComplete="off" onChange={(e: any) => set(e.target.value)} aria-invalid={invalid || undefined}
          aria-describedby={invalid ? id + '-hint' : undefined}
          onKeyDown={(e: any) => { if (e.key === 'Escape') { set(''); (e.target as any).blur(); } }} />
        {matches != null && !invalid && <span className="tt-query-count">{matches.toLocaleString('en-US')} match{matches === 1 ? '' : 'es'}</span>}
        {!v && <Kbd keys="/" />}
      </label>
      {invalid && <p className="tt-query-hint" id={id + '-hint'}>Subjects are dot-separated tokens. Use * for one token and a trailing &gt; for the rest.</p>}
      {suggestions.length > 0 && (
        <div className="tt-query-suggest">
          {suggestions.map(s => (
            <button key={s} type="button" className={cx('tt-query-chip', s === v && 'is-on')} onClick={() => set(s)}>{s}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Containers                                                          */
/* ------------------------------------------------------------------ */

export interface PanelProps {
  title: Node;
  /** Freshness or counts, beside the title. */
  meta?: Node;
  /** Controls on the right of the header. */
  actions?: Node;
  /** Remove body padding, for lists that run edge to edge. */
  flush?: boolean;
  children?: Node;
}

/** A titled region. A hairline and a heading, not a box: panels sit on the ground. */
export function Panel({ title, meta, actions, flush, children }: PanelProps) {
  const id = useId();
  return (
    <section className={cx('tt-panel', flush && 'is-flush')} aria-labelledby={id}>
      <header className="tt-panel-head">
        <h2 className="tt-panel-title" id={id}>{title}</h2>
        {meta && <div className="tt-panel-meta">{meta}</div>}
        {actions && <div className="tt-panel-actions">{actions}</div>}
      </header>
      <div className="tt-panel-body">{children}</div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

export type NeedsYouKind = 'gate' | 'bell' | 'decision' | 'acknowledge';
const NEEDS_KIND: Record<NeedsYouKind, string> = {
  gate: 'Permission prompt',
  bell: 'Asked for you',
  decision: 'Awaiting decision',
  acknowledge: 'Complete, unacknowledged',
};

export interface NeedsYouProps {
  /** gate: a live process is blocked on a prompt. bell: a soft ping. decision / acknowledge: a ticket state. */
  kind: NeedsYouKind;
  /** One sentence, subject first. */
  title: Node;
  /** Who and where, as data: cli · repo · refs. */
  meta?: Node;
  /** Seconds it has been waiting. */
  waiting: number;
  /** The one thing to do. */
  action?: { label: string; onPress?: () => void; kbd?: string };
  /** A ref the operator jumps to (usually a pane). */
  where?: Node;
}

/** One thing that is waiting on the operator, with how long and the way in. */
export function NeedsYou({ kind, title, meta, waiting, action, where }: NeedsYouProps) {
  return (
    <div className={cx('tt-needs', 'tt-needs--' + kind)} role="listitem">
      <span className="tt-needs-glyph"><Glyph state="you" size={kind === 'gate' ? 12 : 10} /></span>
      <div className="tt-needs-main">
        <div className="tt-needs-title">{title}</div>
        <div className="tt-needs-meta">
          <span className="tt-needs-kind">{NEEDS_KIND[kind]}</span>
          {meta && <><span className="tt-dot" aria-hidden="true">·</span>{meta}</>}
        </div>
      </div>
      <div className="tt-needs-side">
        <Age seconds={waiting} verb="waiting" />
        <div className="tt-needs-actions">
          {where}
          {action && <Button size="sm" variant={kind === 'gate' ? 'primary' : 'quiet'} kbd={action.kbd} onPress={action.onPress}>{action.label}</Button>}
        </div>
      </div>
    </div>
  );
}

export interface AgentLineProps {
  name: string;
  /** Raw ASM state: awaiting_human, failed, stale, gone, delegating, tool_running, working, starting, idle. */
  state: string;
  /** What it is doing, in a sentence. */
  doing?: Node;
  /** How long it has held this state, in seconds. */
  held: number;
  /** Phase budget in seconds; past it the age turns stuck. */
  budget?: number;
  cli?: string;
  repo?: string;
  tools?: number;
  subs?: number;
  ticket?: Node;
  pane?: Node;
  freshness?: Freshness;
}

/** Who is working on what, in two lines: a sentence, then the facts. */
export function AgentLine({ name, state, doing, held, budget, cli, repo, tools, subs, ticket, pane, freshness = 'fresh' }: AgentLineProps) {
  const raw = signalFromAsm(state);
  // Stuck is derived from time: a working agent past its phase budget is stuck, whatever it reports.
  const sig: SignalState = raw === 'working' && budget != null && held > budget ? 'stuck' : raw;
  const facts = [cli, repo, tools != null ? `${tools.toLocaleString('en-US')} tools` : null, subs ? `${subs} subs` : null].filter(Boolean);
  return (
    <div className={cx('tt-agent', 'tt-agent--' + sig, freshness !== 'fresh' && 'is-' + freshness)} role="listitem">
      <span className="tt-agent-glyph"><Glyph state={freshness === 'unobserved' ? 'unknown' : sig} title={state} /></span>
      <div className="tt-agent-line">
        <span className="tt-agent-name">{name}</span>
        {doing && <span className="tt-agent-doing">{doing}</span>}
      </div>
      <div className="tt-agent-held"><Age seconds={held} budget={budget} /></div>
      <div className="tt-agent-facts">
        <span className="tt-agent-state">{freshness === 'stale' ? '~' : ''}{state}</span>
        {facts.map((f, i) => <span key={i} className="tt-agent-fact">{f}</span>)}
        {ticket}
        {pane}
      </div>
    </div>
  );
}

export interface EventRowProps {
  /** Wall clock with milliseconds, already formatted: 14:22:11.481 */
  time: string;
  /** Full CloudEvents type, e.g. bloodbank.agent.tool.completed */
  type: string;
  headline: Node;
  actor?: string;
  project?: string;
  durationMs?: number;
  failed?: boolean;
  /** Hide the bloodbank. prefix (the default inside Holocene). */
  compact?: boolean;
}

/** The subject, weighted: namespace faint, entity readable, verb strongest. */
export function Subject({ type, compact = true, failed }: { type: string; compact?: boolean; failed?: boolean }) {
  const parts = type.split('.');
  let ns: string[] = [];
  if (parts[0] === 'bloodbank') ns = parts.splice(0, parts[1] === 'v1' ? 2 : 1);
  const action = parts.pop();
  return (
    <span className="tt-subject" title={type}>
      {ns.length > 0 && !compact && <span className="tt-subject-ns">{ns.join('.')}.</span>}
      {parts.length > 0 && <span className="tt-subject-path">{parts.join('.')}.</span>}
      <span className={cx('tt-subject-verb', failed && 'is-failed')}>{action}</span>
    </span>
  );
}

/** One Bloodbank event. Reads left to right: when, what kind, what happened, how long. */
export function EventRow({ time, type, headline, actor, project, durationMs, failed, compact = true }: EventRowProps) {
  return (
    <div className={cx('tt-event', failed && 'is-failed')} role="row">
      <span className="tt-event-time" role="cell">{time}</span>
      <span className="tt-event-type" role="cell"><Subject type={type} compact={compact} failed={failed} /></span>
      <span className="tt-event-head" role="cell">
        {failed && <Glyph state="broken" size={8} title="Failed" />}
        <span className="tt-event-headline">{headline}</span>
        {(actor || project) && <span className="tt-event-who">{[actor, project].filter(Boolean).join(' · ')}</span>}
      </span>
      <span className="tt-event-dur" role="cell">{durationMs != null ? formatMs(durationMs) : ''}</span>
    </div>
  );
}

export interface EventBurstProps {
  count: number;
  /** The shared type of the collapsed events. */
  type: string;
  /** First and last wall-clock times in the burst. */
  from: string;
  to: string;
  /** Seconds between first and last. */
  span: number;
  /** Top contributors, largest first. */
  breakdown: { label: string; count: number }[];
  actor?: string;
  project?: string;
  /** Events per bucket across the burst, for the rate strip. */
  rate?: number[];
  children?: Node;
  defaultOpen?: boolean;
}

/** Many events of one kind from one session, folded into a single row you can open. */
export function EventBurst({ count, type, from, to, span, breakdown, actor, project, rate, children, defaultOpen }: EventBurstProps) {
  const [open, setOpen] = useState(!!defaultOpen);
  const top = breakdown.slice(0, 3);
  const rest = breakdown.slice(3).reduce((a, b) => a + b.count, 0);
  const max = rate ? Math.max(...rate, 1) : 1;
  return (
    <div className={cx('tt-burst', open && 'is-open')}>
      <button type="button" className="tt-event tt-burst-row" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tt-event-time">{from}</span>
        <span className="tt-event-type"><Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} /><Subject type={type} /></span>
        <span className="tt-event-head">
          <span className="tt-burst-count">{count.toLocaleString('en-US')} events</span>
          <span className="tt-burst-span">over {formatDuration(span)}, to {to}</span>
          <span className="tt-burst-break">
            {top.map(b => <span key={b.label}>{b.label} <b>{b.count.toLocaleString('en-US')}</b></span>)}
            {rest > 0 && <span>other <b>{rest.toLocaleString('en-US')}</b></span>}
          </span>
          {(actor || project) && <span className="tt-event-who">{[actor, project].filter(Boolean).join(' · ')}</span>}
        </span>
        <span className="tt-event-dur">
          {rate && (
            <span className="tt-burst-rate" aria-hidden="true">
              {rate.map((r, i) => <i key={i} style={{ height: Math.max(1, Math.round((r / max) * 14)) + 'px' }} />)}
            </span>
          )}
        </span>
      </button>
      {open && children && <div className="tt-burst-body">{children}</div>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export interface Phase {
  id: string;
  label?: string;
  status: 'done' | 'current' | 'next' | 'blocked' | 'skipped';
  /** Seconds spent in this phase (done or current). */
  spent?: number;
  /** krebs staleness budget in seconds. */
  budget?: number;
  /** e.g. "retry 1/3" on qa. */
  note?: string;
}

export const KREBS_PHASES: Phase[] = [
  { id: 'triage', status: 'next', budget: 600 },
  { id: 'refining', status: 'next', budget: 1800 },
  { id: 'ready', status: 'next' },
  { id: 'in_progress', label: 'in progress', status: 'next', budget: 7200 },
  { id: 'review', status: 'next', budget: 900 },
  { id: 'qa', status: 'next', budget: 3600 },
  { id: 'done', status: 'next' },
];

export interface LifecycleTrackProps { phases: Phase[]; /** Why it is blocked, when a phase is blocked. */ reason?: Node }

/** Where a ticket is in krebs, how long each phase took, and whether the current one is over budget. */
export function LifecycleTrack({ phases, reason }: LifecycleTrackProps) {
  return (
    <div className="tt-track">
      <ol className="tt-track-list">
        {phases.map(p => {
          const over = p.budget != null && p.spent != null && p.spent > p.budget;
          const fill = p.status === 'current' && p.budget && p.spent != null ? Math.min(1, p.spent / p.budget) : p.status === 'done' ? 1 : 0;
          return (
            <li key={p.id} className={cx('tt-phase', 'is-' + p.status, over && 'is-over')} aria-current={p.status === 'current' ? 'step' : undefined}>
              <span className="tt-phase-bar"><i style={{ width: fill * 100 + '%' }} /></span>
              <span className="tt-phase-label">
                {p.status === 'blocked' && <Glyph state="broken" size={8} />}
                {p.status === 'current' && <Glyph state={over ? 'stuck' : 'working'} size={8} />}
                {p.label ?? p.id}
              </span>
              <span className="tt-phase-time">
                {p.spent != null && (p.status === 'current'
                  ? <Age seconds={p.spent} budget={p.budget} showBudget />
                  : formatDuration(p.spent))}
                {p.spent == null && p.status !== 'skipped' && p.budget != null && p.status === 'next' && <span className="tt-phase-budget" title="staleness budget">≤ {formatDuration(p.budget)}</span>}
                {p.status === 'skipped' && 'skipped'}
              </span>
              {p.note && <span className="tt-phase-note">{p.note}</span>}
            </li>
          );
        })}
      </ol>
      {reason && <p className="tt-track-reason"><Glyph state="broken" size={8} /> {reason}</p>}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Time-in-state                                                       */
/* ------------------------------------------------------------------ */

export interface TapeSegment { state: SignalState; seconds: number; note?: string }
export interface StateTapeProps {
  segments: TapeSegment[];
  /** Label for the right edge. */
  end?: string;
  /** Label for the left edge. */
  start?: string;
  /** States to total under the tape, in this order. */
  totals?: SignalState[];
}

const TOTAL_WORD: Record<SignalState, string> = {
  you: 'Waiting on you', broken: 'Broken', stuck: 'Stuck', working: 'Working', quiet: 'Idle', cleared: 'Cleared', unknown: 'No signal',
};

/** An agent's last hours as one strip. The total it leads with is time spent waiting on you. */
export function StateTape({ segments, start = '6h ago', end = 'now', totals = ['you', 'working', 'stuck'] }: StateTapeProps) {
  const total = segments.reduce((a, s) => a + s.seconds, 0) || 1;
  const sums = useMemo(() => {
    const m: Record<string, number> = {};
    segments.forEach(s => (m[s.state] = (m[s.state] || 0) + s.seconds));
    return m;
  }, [segments]);
  return (
    <figure className="tt-tape">
      <div className="tt-tape-strip" role="img" aria-label={totals.map(t => `${TOTAL_WORD[t]} ${formatDuration(sums[t] || 0)}`).join(', ')}>
        {segments.map((s, i) => (
          <span key={i} className={cx('tt-tape-seg', 'tt-sig--' + s.state)} style={{ flexGrow: s.seconds / total }}
            title={`${TOTAL_WORD[s.state]} · ${formatDuration(s.seconds)}${s.note ? ' · ' + s.note : ''}`} />
        ))}
      </div>
      <div className="tt-tape-axis"><span>{start}</span><span>{end}</span></div>
      <figcaption className="tt-tape-totals">
        {totals.filter(t => sums[t]).map(t => (
          <span key={t} className="tt-tape-total"><Glyph state={t} size={8} />{TOTAL_WORD[t]} <b>{formatDuration(sums[t])}</b></span>
        ))}
      </figcaption>
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Readings                                                            */
/* ------------------------------------------------------------------ */

export interface SparkProps {
  values: number[];
  width?: number;
  height?: number;
  /** Colours the endpoint only; the line stays ink-3. */
  state?: SignalState;
  label?: string;
}

/** A trend without axes: the line recedes, the latest value is the only coloured mark. */
export function Spark({ values, width = 120, height = 28, state = 'quiet', label }: SparkProps) {
  const pad = 4;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => pad + (i * (width - pad * 2)) / Math.max(1, values.length - 1);
  const y = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / span);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(values.length - 1).toFixed(1)} ${height - pad} L${x(0).toFixed(1)} ${height - pad} Z`;
  const last = values.length - 1;
  return (
    <svg className={cx('tt-spark', 'tt-sig--' + state)} width={width} height={height} viewBox={`0 0 ${width} ${height}`}
      role="img" aria-label={label ?? `Trend, latest ${values[last]}`}>
      <path className="tt-spark-area" d={area} />
      <path className="tt-spark-line" d={line} />
      <circle className="tt-spark-end" cx={x(last)} cy={y(values[last])} r="3" />
    </svg>
  );
}

export interface ReadingProps {
  /** Sentence case, no colon: "Dead letters, last 7 days". */
  label: string;
  value: number | string;
  /** Turns the value into "x of y" with a proportion bar. */
  of?: number;
  unit?: string;
  /** What the value means right now: "growing, +41 today". */
  note?: Node;
  state?: SignalState;
  trend?: number[];
  /** Seconds since the reading was taken, and the budget after which it is stale. */
  age?: number;
  maxAge?: number;
}

/** One instrument reading: the value, what normal is, and how old the reading is. */
export function Reading({ label, value, of, unit, note, state = 'quiet', trend, age, maxAge }: ReadingProps) {
  const stale = age != null && maxAge != null && age > maxAge;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return (
    <div className={cx('tt-reading', stale && 'is-stale')}>
      <div className="tt-reading-label">{label}</div>
      <div className="tt-reading-value">
        <span className="tt-reading-figure">{stale ? '~' : ''}{typeof value === 'number' ? value.toLocaleString('en-US') : value}</span>
        {of != null && <span className="tt-reading-of">of {of.toLocaleString('en-US')}</span>}
        {unit && <span className="tt-reading-unit">{unit}</span>}
      </div>
      {of != null && (
        <div className={cx('tt-meter', 'tt-sig--' + state)} role="meter" aria-valuemin={0} aria-valuemax={of} aria-valuenow={n} aria-label={label}>
          <i style={{ width: Math.min(100, (n / of) * 100) + '%' }} />
        </div>
      )}
      {trend && <Spark values={trend} state={state} width={140} height={28} label={`${label} trend`} />}
      {(note || age != null) && (
        <div className="tt-reading-note">
          {note && (state === 'quiet' ? <span className="tt-reading-plain">{note}</span> : <Signal state={state} label={note} size="sm" />)}
          {age != null && <span className="tt-reading-age">{stale ? 'stale, ' : ''}read {formatDuration(age)} ago</span>}
        </div>
      )}
    </div>
  );
}

export interface CensusItem { id: string; label: string; state: SignalState; detail?: string }
export interface CensusProps {
  items: CensusItem[];
  /** Noun for the population: "probes", "units", "agents". */
  noun: string;
  /** How many problem items to name before "and N more". */
  name?: number;
  /** Cell edge in px. */
  cell?: number;
}

/** A whole population at a glance: one cell each, problems first, the problems named. */
export function Census({ items, noun, name = 4, cell = 10 }: CensusProps) {
  const [hover, setHover] = useState(null as CensusItem | null);
  const sorted = useMemo(() => [...items].sort((a, b) => SIGNAL_ORDER.indexOf(a.state) - SIGNAL_ORDER.indexOf(b.state) || a.label.localeCompare(b.label)), [items]);
  const counts = useMemo(() => {
    const m: Partial<Record<SignalState, number>> = {};
    items.forEach(i => (m[i.state] = (m[i.state] || 0) + 1));
    return m;
  }, [items]);
  const problems = sorted.filter(i => i.state === 'broken' || i.state === 'stuck' || i.state === 'you');
  const order = SIGNAL_ORDER.filter(s => counts[s]);
  return (
    <div className="tt-census">
      <div className="tt-census-field" style={{ ['--cell' as any]: cell + 'px' }} onMouseLeave={() => setHover(null)}>
        {sorted.map(i => (
          <span key={i.id} className={cx('tt-census-cell', 'tt-sig--' + i.state)} onMouseEnter={() => setHover(i)} title={`${i.label}${i.detail ? ' · ' + i.detail : ''}`} />
        ))}
      </div>
      <div className="tt-census-key">
        {order.map(s => <Signal key={s} state={s} count={counts[s]} size="sm" label={s === 'quiet' ? 'Healthy' : undefined} />)}
        <span className="tt-census-total">{items.length.toLocaleString('en-US')} {noun}</span>
      </div>
      <div className="tt-census-hover" aria-live="polite">{hover ? <><b>{hover.label}</b>{hover.detail ? ' · ' + hover.detail : ''}</> : ' '}</div>
      {problems.length > 0 && (
        <ul className="tt-census-list">
          {problems.slice(0, name).map(p => (
            <li key={p.id}><Glyph state={p.state} size={8} /><span className="tt-census-name">{p.label}</span>{p.detail && <span className="tt-census-detail">{p.detail}</span>}</li>
          ))}
          {problems.length > name && <li className="tt-census-more">and {problems.length - name} more</li>}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Strata: activity over time                                          */
/* ------------------------------------------------------------------ */

export interface StrataLayer { id: string; label: string; values: number[] }
export interface StrataMark { at: number; label: string }
export interface StrataProps {
  /** Bottom to top. Each takes the next series token, in order. */
  layers: StrataLayer[];
  /** Failed events per bucket. Drawn in their own lane with their own scale, never stacked on volume. */
  errors?: number[];
  /** Sparse events worth seeing one by one (PM decisions), on a rail. at = bucket index, fractional allowed. */
  marks?: StrataMark[];
  /** Label for each bucket, e.g. "14:00". */
  buckets: string[];
  unit?: string;
  /** Height of the volume plot in px. */
  height?: number;
  marksLabel?: string;
}

const niceStep = (max: number, ticks = 3) => {
  const raw = max / ticks;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
};

/** Event volume as stacked sediment, with errors and PM decisions in lanes beneath on their own scales. */
export function Strata({ layers, errors, marks = [], buckets, unit = 'events / h', height = 150, marksLabel = 'PM decisions' }: StrataProps) {
  const wrap = useRef(null as any);
  const [w, setW] = useState(640);
  const [hover, setHover] = useState(null as number | null);
  const [table, setTable] = useState(false);
  useEffect(() => {
    if (!wrap.current) return undefined;
    const ro = new ResizeObserver(([e]: any) => setW(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, []);
  const n = buckets.length;
  const totals = buckets.map((_, i) => layers.reduce((a, l) => a + (l.values[i] || 0), 0));
  const step = niceStep(Math.max(...totals, 1));
  const top = Math.ceil(Math.max(...totals, 1) / step) * step;
  const left = 44, right = 112, padTop = 8;
  const plotW = Math.max(120, w - left - right);
  const bw = plotW / n;
  const base = padTop + height;
  const y = (v: number) => padTop + height * (1 - v / top);
  const errTop = base + 12, errH = 26;
  const errMax = errors ? Math.max(...errors, 1) : 1;
  const railY = errors ? errTop + errH + 14 : base + 14;
  const axisY = railY + 22;
  const svgH = axisY + 6;
  const ticks: number[] = [];
  for (let t = 0; t <= top + 1e-9; t += step) ticks.push(t);
  const seriesVar = (li: number) => `var(--series-${li + 1})`;
  // stepped bands; a 2px surface gap separates each layer from the one below
  const bands = layers.map((l, li) => {
    let d = '';
    for (let i = 0; i < n; i++) {
      const below = layers.slice(0, li).reduce((a, s) => a + (s.values[i] || 0), 0);
      const v = l.values[i] || 0;
      if (v <= 0) continue;
      const x0 = left + i * bw, x1 = x0 + bw;
      const y0 = y(below) - (below > 0 ? 1 : 0), y1 = y(below + v) + 1;
      if (y0 - y1 < 0.5) continue;
      d += `M${x0.toFixed(1)} ${y0.toFixed(1)}H${x1.toFixed(1)}V${y1.toFixed(1)}H${x0.toFixed(1)}Z`;
    }
    return d;
  });
  const lastIdx = n - 1;
  const fmt = (v: number) => v.toLocaleString('en-US');
  const labelPos = useMemo(() => {
    const pos = layers.map((l, li) => {
      const below = layers.slice(0, li).reduce((a, s) => a + (s.values[lastIdx] || 0), 0);
      const mid = y(below + (l.values[lastIdx] || 0) / 2);
      return { l, li, mid, ly: mid };
    });
    for (let i = 0; i < pos.length; i++) {
      pos[i].ly = i === 0 ? Math.min(pos[i].ly, base - 5) : Math.min(pos[i].ly, pos[i - 1].ly - 15);
    }
    const overflow = padTop + 4 - Math.min(...pos.map(p => p.ly));
    if (overflow > 0) pos.forEach(p => (p.ly += overflow));
    return pos;
  }, [layers.map(l => l.values[lastIdx]).join(','), w, height, top]);
  const hx = hover != null ? left + hover * bw + bw / 2 : 0;
  const peakErr = errors ? errors.indexOf(errMax) : -1;
  return (
    <figure className="tt-strata" ref={wrap}>
      <svg width={w} height={svgH} viewBox={`0 0 ${w} ${svgH}`} role="img"
        aria-label={`${unit} by source, peak ${fmt(Math.max(...totals))}${errors ? `; errors peak ${fmt(errMax)} at ${buckets[peakErr]}` : ''}`}
        onMouseMove={(e: any) => {
          const r = e.currentTarget.getBoundingClientRect();
          const i = Math.floor((e.clientX - r.left - left) / bw);
          setHover(i >= 0 && i < n ? i : null);
        }}
        onMouseLeave={() => setHover(null)}>
        {ticks.map(t => (
          <g key={t}>
            <line className="tt-strata-grid" x1={left} x2={left + plotW} y1={y(t)} y2={y(t)} />
            <text className="tt-strata-tick" x={left - 8} y={y(t) + 4} textAnchor="end">{t >= 1000 ? (t / 1000).toFixed(t % 1000 ? 1 : 0) + 'k' : t}</text>
          </g>
        ))}
        {bands.map((d, li) => <path key={layers[li].id} d={d} style={{ fill: seriesVar(li) }} />)}
        {labelPos.map(({ l, li, mid, ly }) => (
          <g key={l.id} className="tt-strata-dl">
            {Math.abs(ly - mid) > 1 && <path className="tt-strata-leader" d={`M${left + plotW + 1} ${mid.toFixed(1)}H${left + plotW + 4}L${left + plotW + 7} ${ly.toFixed(1)}`} />}
            <rect x={left + plotW + 8} y={ly - 4} width="8" height="8" rx="2" style={{ fill: seriesVar(li) }} />
            <text x={left + plotW + 22} y={ly + 4}>{l.label}</text>
          </g>
        ))}
        {errors && (
          <g className="tt-strata-errlane">
            <line className="tt-strata-grid" x1={left} x2={left + plotW} y1={errTop + errH} y2={errTop + errH} />
            {errors.map((v, i) => {
              const hgt = v > 0 ? Math.max(1, (v / errMax) * errH) : 0;
              return hgt ? <rect key={i} className="tt-strata-err" x={left + i * bw + 1} y={errTop + errH - hgt} width={Math.max(1, bw - 2)} height={hgt} rx={Math.min(2, hgt / 2)} /> : null;
            })}
            <text className="tt-strata-tick" x={left - 8} y={errTop + 8} textAnchor="end">{fmt(errMax)}</text>
            <rect x={left + plotW + 8} y={errTop + errH / 2 - 4} width="8" height="8" rx="2" className="tt-strata-err" />
            <text className="tt-strata-lane" x={left + plotW + 22} y={errTop + errH / 2 + 4}>Errors</text>
          </g>
        )}
        <line className="tt-strata-rail" x1={left} x2={left + plotW} y1={railY} y2={railY} />
        {marks.map((m, i) => <rect key={i} className="tt-strata-mark" x={left + m.at * bw - 1} y={railY - 5} width="2" height="10" rx="1"><title>{m.label}</title></rect>)}
        <rect x={left + plotW + 11} y={railY - 5} width="2" height="10" rx="1" className="tt-strata-mark" />
        <text className="tt-strata-lane" x={left + plotW + 22} y={railY + 4}>{marksLabel}</text>
        {buckets.map((b, i) => (i % Math.ceil(n / 6) === 0 || i === lastIdx) && (
          <text key={i} className="tt-strata-tick" x={left + i * bw + bw / 2} y={axisY} textAnchor="middle">{b}</text>
        ))}
        {hover != null && <line className="tt-strata-cross" x1={hx} x2={hx} y1={padTop} y2={railY + 5} />}
      </svg>
      {hover != null && (
        <div className="tt-tip" style={{ left: Math.min(w - 184, hx + 12) + 'px', top: '8px' }}>
          <div className="tt-tip-head">{buckets[hover]} <span>{fmt(totals[hover])} {unit}</span></div>
          {[...layers].map((l, li) => ({ l, li })).reverse().map(({ l, li }) => (
            <div key={l.id} className="tt-tip-row"><i style={{ background: seriesVar(li) }} />{l.label}<b>{fmt(l.values[hover] || 0)}</b></div>
          ))}
          {errors && <div className="tt-tip-row"><i className="tt-strata-err" />Errors<b>{fmt(errors[hover] || 0)}</b></div>}
          {marks.filter(m => Math.floor(m.at) === hover).map((m, i) => <div key={i} className="tt-tip-mark">{m.label}</div>)}
        </div>
      )}
      <figcaption className="tt-strata-foot">
        <span>{unit}{errors ? `; errors on their own scale, peak ${fmt(errMax)} at ${buckets[peakErr]}` : ''}</span>
        <button type="button" className="tt-linkish" aria-expanded={table} onClick={() => setTable(!table)}>{table ? 'Hide table' : 'Show as table'}</button>
      </figcaption>
      {table && (
        <div className="tt-strata-table">
          <table>
            <thead><tr><th scope="col">Hour</th>{layers.map(l => <th key={l.id} scope="col">{l.label}</th>)}<th scope="col">Total</th>{errors && <th scope="col">Errors</th>}<th scope="col">{marksLabel}</th></tr></thead>
            <tbody>{buckets.map((b, i) => (
              <tr key={b}><th scope="row">{b}</th>{layers.map(l => <td key={l.id}>{fmt(l.values[i] || 0)}</td>)}<td>{fmt(totals[i])}</td>
                {errors && <td>{fmt(errors[i] || 0)}</td>}<td>{marks.filter(m => Math.floor(m.at) === i).length}</td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Trust                                                               */
/* ------------------------------------------------------------------ */

export interface Source {
  name: string;
  /** A count or ratio worth showing: "36/17", "918,762". */
  value?: string;
  /** Seconds since this source last reported. */
  age?: number;
  /** Seconds after which it is stale; past twice this it is expired. */
  max?: number;
  /** Down overrides age. */
  down?: boolean;
}

/** Every feed the view depends on, and how old it is. Read it before trusting the page. */
export function SourceStrip({ sources }: { sources: Source[] }) {
  return (
    <ul className="tt-sources" aria-label="Data sources">
      {sources.map(s => {
        const state = s.down ? 'expired' : s.age != null && s.max != null ? (s.age > s.max * 2 ? 'expired' : s.age > s.max ? 'stale' : 'fresh') : 'fresh';
        return (
          <li key={s.name} className={cx('tt-source', 'is-' + state)}
            title={s.down ? `${s.name} is down` : s.age != null ? `${s.name} reported ${formatDuration(s.age)} ago${s.max ? `, expected every ${formatDuration(s.max)}` : ''}` : s.name}>
            {state !== 'fresh' && <Glyph state={state === 'stale' ? 'stuck' : 'broken'} size={8} />}
            <span className="tt-source-name">{s.name}</span>
            {s.down ? <span className="tt-source-val">down</span> : (
              <span className="tt-source-val">{state === 'stale' ? '~' : ''}{s.value ?? (s.age != null ? formatDuration(s.age) : '')}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface Check { name: string; result: string; state?: SignalState }
export interface AllClearProps {
  /** Defaults to "Nothing needs you." */
  statement?: Node;
  checks: Check[];
  /** Seconds since the newest check ran. */
  newest: number;
}

/** An empty state that proves it is empty: every detector that ran, and what it found. */
export function AllClear({ statement = 'Nothing needs you.', checks, newest }: AllClearProps) {
  return (
    <div className="tt-clear">
      <p className="tt-clear-statement">{statement}</p>
      <p className="tt-clear-sub">{checks.length} detectors evaluated, newest {formatDuration(newest)} ago.</p>
      <dl className="tt-clear-receipt">
        {checks.map(c => (
          <div key={c.name} className="tt-clear-row">
            <dt>{c.name}</dt>
            <dd><Glyph state={c.state ?? 'quiet'} size={8} />{c.result}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
