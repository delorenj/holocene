# Writes components/<Comp>/preview.html for every 33GOD component.
# Each preview is a small document; the frame preloads tokens.css, fonts,
# bundle.css, React 18 and bundle.js (window.ThirtyThree).
import os, sys

ROOT = os.path.join(os.path.dirname(__file__), '..', 'project', 'components')

BASE_STYLE = """
.pv{padding:16px;display:grid;gap:16px;align-content:start}
.row{display:flex;flex-wrap:wrap;gap:10px 20px;align-items:center}
.cap{font:var(--tt-font-label);letter-spacing:.07em;text-transform:uppercase;color:var(--ink-3)}
.note{font:var(--tt-font-small);color:var(--ink-3);margin:0}
code{font:var(--tt-font-code);font-size:12.5px;color:var(--ink);background:var(--sunken);padding:0 4px;border-radius:var(--radius-2)}
"""

def page(name, marker, script, style=''):
    return f"""<!-- @dsCard {marker} -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{name}</title>
<style>{BASE_STYLE}{style}</style>
</head>
<body>
<div id="root"></div>
<script>
var T = window.ThirtyThree, h = React.createElement;
{script.strip()}
ReactDOM.createRoot(document.getElementById('root')).render(h(App));
</script>
</body>
</html>
"""

P = {}

P['Signal'] = ('group="Signals" height=150 subtitle="Seven states, most urgent first"', r"""
var LADDER = ['you', 'broken', 'stuck', 'working', 'unknown', 'quiet', 'cleared'];
function App() {
  return h('div', { className: 'pv' },
    h('div', { className: 'row' }, LADDER.map(function (s) { return h(T.Signal, { key: s, state: s }); })),
    h('div', { className: 'row' },
      h(T.Signal, { state: 'you', count: 2, label: 'Need you' }),
      h(T.Signal, { state: 'broken', count: 26, label: 'Probes broken', size: 'sm' }),
      h(T.Signal, { state: 'working', freshness: 'stale', label: 'Working, reading 3m old' }),
      h(T.Signal, { state: 'working', freshness: 'unobserved', label: 'No signal in 98d' })),
    h('p', { className: 'note' }, 'Shape carries the state and colour confirms it, so the ladder survives greyscale and colour blindness. A tilde marks a stale reading.'));
}
""")

P['Age'] = ('group="Signals" height=150 subtitle="Durations that know their budget"', r"""
function Item(props) { return h('div', { style: { display: 'grid', gap: '4px' } }, h('span', { className: 'cap' }, props.cap), props.children); }
function App() {
  return h('div', { className: 'pv' },
    h('div', { className: 'row', style: { gap: '12px 32px' } },
      h(Item, { cap: 'tool call' }, h(T.Age, { seconds: 14 })),
      h(Item, { cap: 'gate open' }, h(T.Age, { seconds: 12 * 60, verb: 'waiting' })),
      h(Item, { cap: 'in_progress' }, h(T.Age, { seconds: 108 * 60, budget: 7200, showBudget: true })),
      h(Item, { cap: 'review' }, h(T.Age, { seconds: 51 * 60, budget: 900 })),
      h(Item, { cap: 'lease' }, h(T.Age, { seconds: 4 * 86400 + 2 * 3600 })),
      h(Item, { cap: 'heartbeat' }, h(T.Age, { seconds: 98 * 86400, ago: true })),
      h(Item, { cap: 'live, from since' }, h(T.Age, { since: Date.now() - 41000, verb: 'updated', ago: true }))),
    h('p', { className: 'note' }, '14s, 12m, 1h 48m, 4d 02h, 98d. Over budget, the value turns heather and says by how much. Hover for the absolute time.'));
}
""")

P['SourceStrip'] = ('group="Signals" height=104 subtitle="Every feed this view depends on, and its age"', r"""
var SOURCES = [
  { name: 'sweeper', age: 8, max: 15 },
  { name: 'asm', value: '36/17', age: 12, max: 90 },
  { name: 'candystore', value: '918,762', age: 2, max: 30 },
  { name: 'nats', value: '143,633', age: 1, max: 30 },
  { name: 'probes', age: 190, max: 120 },
  { name: 'fleet', age: 41, max: 60 },
  { name: 'hooks', age: 4, max: 60 },
  { name: 'bridge', down: true },
];
function App() {
  return h('div', { className: 'pv' },
    h(T.SourceStrip, { sources: SOURCES }),
    h('p', { className: 'note' }, 'Fresh sources say nothing extra. Past their interval they turn stuck with a tilde; past twice it, or down, they turn broken.'));
}
""")

P['Ref'] = ('group="Identifiers and input" height=150 subtitle="Click copies; the full value is in the title"', r"""
function App() {
  return h('div', { className: 'pv' },
    h('div', { className: 'row', style: { gap: '8px 10px' } },
      h(T.Ref, { kind: 'ticket', value: 'HOLOC-11', href: 'https://plane.delo.sh/33god/projects/' }),
      h(T.Ref, { kind: 'commit', value: 'f9806dd4b1c27e0a9d55c1f3a8e6b2d7c4f01e9a' }),
      h(T.Ref, { kind: 'branch', value: 'holoc-11-play-version-6' }),
      h(T.Ref, { kind: 'card', value: 't_8f126526' }),
      h(T.Ref, { kind: 'worker', value: 'proc_a91f02' }),
      h(T.Ref, { kind: 'pane', value: 'pane 13' })),
    h('div', { className: 'row', style: { gap: '8px 10px' } },
      h(T.Ref, { kind: 'subject', value: 'bloodbank.agent.invocation.failed' }),
      h(T.Ref, { kind: 'unit', value: 'hermes-holocene-pm-gateway.service', max: 30 }),
      h(T.Ref, { kind: 'path', value: '/tmp/jimb-169-prod-incident-20260901 (deleted)', max: 30 })),
    h('p', { className: 'note' }, 'Commits show seven characters and copy all forty. Long units and paths shorten from the middle so the root and the leaf stay readable.'));
}
""")

P['Kbd'] = ('group="Identifiers and input" height=150 subtitle="Shortcuts, written mod+k"', r"""
var KEYS = [['mod+k', 'Command palette'], ['/', 'Filter events'], ['j', 'Next row'], ['k', 'Previous row'], ['enter', 'Open, or go to pane'], ['esc', 'Close, disarm']];
function App() {
  return h('div', { className: 'pv' },
    h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '10px 24px' } },
      KEYS.map(function (k) {
        return h('div', { key: k[0], style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', font: 'var(--tt-font-small)', color: 'var(--ink-2)' } }, k[1], h(T.Kbd, { keys: k[0] }));
      })),
    h('p', { className: 'note' }, 'mod renders as the platform key: the command glyph on macOS, Ctrl elsewhere.'));
}
""")

P['Button'] = ('group="Identifiers and input" height=176 subtitle="Four voices; destructive actions confirm in place"', r"""
function App() {
  var s = React.useState(false), busy = s[0], setBusy = s[1];
  return h('div', { className: 'pv' },
    h('div', { className: 'row', style: { gap: '10px' } },
      h(T.Button, { variant: 'primary', kbd: 'enter' }, 'Go to pane 21'),
      h(T.Button, { icon: 'restart' }, 'Restart gateway'),
      h(T.Button, { variant: 'ghost' }, 'Show envelope'),
      h(T.Button, { variant: 'danger', confirm: 'Confirm: restart 29 gateways' }, 'Restart all gateways'),
      h(T.Button, { busy: busy, onPress: function () { setBusy(true); setTimeout(function () { setBusy(false); }, 2400); } }, busy ? 'Syncing defaults' : 'Sync defaults')),
    h('div', { className: 'row', style: { gap: '10px' } },
      h(T.Button, { size: 'sm', variant: 'primary' }, 'Approve'),
      h(T.Button, { size: 'sm' }, 'Acknowledge'),
      h(T.Button, { size: 'sm', variant: 'ghost', icon: 'pause' }, 'Pause feed'),
      h(T.Button, { size: 'sm', disabled: true }, 'Clock in')),
    h('p', { className: 'note' }, 'Press the destructive button: it arms in ochre, waits four seconds, then disarms itself. Esc or leaving it also disarms.'));
}
""")

P['Segmented'] = ('group="Identifiers and input" height=128 subtitle="Time windows and lenses"', r"""
function App() {
  return h('div', { className: 'pv' },
    h(T.Segmented, { label: 'Window', value: '24h', options: [{ value: '1h', label: '1h' }, { value: '6h', label: '6h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }] }),
    h(T.Segmented, { label: 'Lens', value: 'decisions', options: [
      { value: 'pm', label: 'PM', count: 177 }, { value: 'decisions', label: 'Decisions', count: 81 },
      { value: 'sessions', label: 'Sessions', count: 221 }, { value: 'tools', label: 'Tools', count: 24583 }, { value: 'errors', label: 'Errors', count: 536 }] }));
}
""")

P['QueryField'] = ('group="Identifiers and input" height=176 subtitle="A NATS subject filter"', r"""
function App() {
  var s = React.useState('bloodbank.agent.*.failed'), v = s[0], set = s[1];
  var matches = v === 'bloodbank.agent.*.failed' ? 536 : v === 'bloodbank.agent.>' ? 23807 : v === 'bloodbank.repo.decision.recorded' ? 81 : 1204;
  return h('div', { className: 'pv', style: { maxWidth: '620px' } },
    h(T.QueryField, { value: v, onChange: set, matches: matches, suggestions: ['bloodbank.agent.>', 'bloodbank.agent.*.failed', 'bloodbank.repo.decision.recorded', 'bloodbank.system.hook.updated'] }),
    h('p', { className: 'note' }, 'Press / anywhere to focus. * matches one token, a trailing > matches the rest. Try typing bloodbank..agent to see the hint.'));
}
""")

P['Panel'] = ('group="Layout" height=236 subtitle="A hairline and a heading, not a box"', r"""
function App() {
  return h('div', { className: 'pv' },
    h(T.Panel, {
      title: 'Waiting on you',
      meta: [h(T.Signal, { key: 's', state: 'you', count: 2, label: false, title: '2 need you' }), h(T.Age, { key: 'a', seconds: 4, verb: 'updated', ago: true })],
      actions: h(T.Segmented, { size: 'sm', label: 'Sort', value: 'oldest', options: [{ value: 'oldest', label: 'Oldest' }, { value: 'urgent', label: 'Most urgent' }] }),
      flush: true,
    }, h('div', { className: 'tt-list', role: 'list' },
      h(T.NeedsYou, { kind: 'gate', title: 'codex wants approval to run git push in skillex', meta: 'codex · skillex', waiting: 12 * 60, where: h(T.Ref, { kind: 'pane', value: 'pane 21' }), action: { label: 'Go to pane', kbd: 'enter' } }),
      h(T.NeedsYou, { kind: 'decision', title: 'JIMB-277 · Normalize the attention bell/gate split', meta: 'james-brennan-pm', waiting: 2 * 86400 + 3 * 3600, action: { label: 'Decide' } }))));
}
""")

P['NeedsYou'] = ('group="Rows" height=330 subtitle="What is waiting on you, for how long, and the way in"', r"""
function App() {
  return h('div', { className: 'pv', style: { gap: '0' } },
    h('div', { className: 'tt-list', role: 'list' },
      h(T.NeedsYou, { kind: 'gate', title: h(React.Fragment, null, 'codex wants approval to run ', h('code', null, 'git push --force-with-lease')),
        meta: [h('span', { key: 1 }, 'codex · holocene'), h(T.Ref, { key: 2, kind: 'worker', value: 'proc_470ce5' })],
        waiting: 12 * 60, where: h(T.Ref, { kind: 'pane', value: 'pane 21' }), action: { label: 'Go to pane', kbd: 'enter' } }),
      h(T.NeedsYou, { kind: 'decision', title: 'Normalize the attention bell/gate split',
        meta: [h(T.Ref, { key: 1, kind: 'ticket', value: 'JIMB-277' }), h('span', { key: 2 }, 'james-brennan-pm')],
        waiting: 2 * 86400 + 3 * 3600, action: { label: 'Decide' } }),
      h(T.NeedsYou, { kind: 'bell', title: 'holocene-pm asks whether HOLOC-8 should land as one PR or three',
        meta: [h('span', { key: 1 }, 'hermes · holocene'), h(T.Ref, { key: 2, kind: 'ticket', value: 'HOLOC-8' })],
        waiting: 41 * 60, action: { label: 'Reply' } }),
      h(T.NeedsYou, { kind: 'acknowledge', title: 'AAOS feasibility spike closed with PASS',
        meta: [h(T.Ref, { key: 1, kind: 'ticket', value: 'HOLOC-9' }), h('span', { key: 2 }, 'close gate pass · review held 0')],
        waiting: 5 * 3600 + 12 * 60, action: { label: 'Acknowledge' } })));
}
""")

P['AgentLine'] = ('group="Rows" height=300 subtitle="Who is working on what, in two lines"', r"""
function App() {
  return h('div', { className: 'tt-list', role: 'list', style: { padding: '8px 0' } },
    h(T.AgentLine, { name: 'skillex-pm', state: 'awaiting_human', doing: 'Waiting on your approval to push the skill index', held: 12 * 60, cli: 'codex', repo: 'skillex', tools: 241, pane: h(T.Ref, { kind: 'pane', value: 'pane 21' }) }),
    h(T.AgentLine, { name: '33god-pm', state: 'delegating', doing: 'Handing BB-138 to an opencode worker', held: 2 * 3600 + 36 * 60, budget: 7200, cli: 'hermes', repo: '33GOD', tools: 412, subs: 3, ticket: h(T.Ref, { kind: 'ticket', value: 'BB-138' }) }),
    h(T.AgentLine, { name: 'james-brennan-pm', state: 'tool_running', doing: 'Running the tp_band projection tests', held: 14, cli: 'claude', repo: 'james-brennan', tools: 3, ticket: h(T.Ref, { kind: 'ticket', value: 'JIMB-284' }), pane: h(T.Ref, { kind: 'pane', value: 'pane 13' }) }),
    h(T.AgentLine, { name: 'holocene-pm', state: 'idle', doing: 'Completed the reconciliation pass without claiming work.', held: 80 * 60, cli: 'hermes', repo: 'holocene' }),
    h(T.AgentLine, { name: 'delodocs-pm', state: 'working', freshness: 'stale', doing: 'Last reported working, on a heartbeat from June', held: 98 * 86400, cli: 'hermes', repo: 'delodocs' }));
}
""")

EVENTS = r"""
var ROWS = [
  { time: '14:22:11.481', type: 'bloodbank.agent.tool.completed', headline: 'Bash · redis-cli ZCARD asm:live', actor: 'claude', project: 'holocene', durationMs: 31 },
  { time: '14:21:44.032', type: 'bloodbank.agent.invocation.failed', headline: 'Worker exited 1, no evidence file written', actor: 'james-brennan-pm', project: 'james-brennan', durationMs: 412800, failed: true },
  { time: '14:20:03.118', type: 'bloodbank.repo.decision.recorded', headline: 'Keep the ticket sentinel as command plane; Kanban executes with WIP 1', actor: 'holocene-pm', project: 'holocene' },
  { time: '14:19:58.640', type: 'bloodbank.conversation.turn.completed', headline: 'Turn 14 completed', actor: 'claude', project: 'james-brennan', durationMs: 48200 },
  { time: '14:19:02.007', type: 'bloodbank.agent.session.started', headline: 'Session started in .worktrees/holoc-11-play-version-6', actor: 'codex', project: 'holocene' },
  { time: '14:18:30.912', type: 'bloodbank.repo.task.updated', headline: 'HOLOC-11 moved to In Progress', actor: 'plane', project: 'holocene' },
];
"""

P['EventRow'] = ('group="Rows" height=244 subtitle="When, what kind, what happened, how long"', EVENTS + r"""
function App() {
  return h('div', { className: 'tt-log', role: 'table', 'aria-label': 'Events', style: { padding: '8px 0' } },
    ROWS.map(function (r) { return h(T.EventRow, Object.assign({ key: r.time }, r)); }));
}
""")

P['EventBurst'] = ('group="Rows" height=300 subtitle="Hundreds of tool calls, folded into one row"', EVENTS + r"""
var RATE = [3, 5, 4, 8, 12, 9, 6, 2, 0, 1, 7, 14, 18, 11, 9, 13, 16, 12, 10, 8, 15, 19, 11, 18];
function App() {
  return h('div', { className: 'tt-log', role: 'table', 'aria-label': 'Events', style: { padding: '8px 0' } },
    h(T.EventRow, ROWS[2]),
    h(T.EventBurst, { count: 241, type: 'bloodbank.agent.tool.completed', from: '13:16:09', to: '14:22:11', span: 66 * 60 + 2,
      breakdown: [{ label: 'Bash', count: 180 }, { label: 'Edit', count: 41 }, { label: 'Read', count: 14 }, { label: 'Grep', count: 6 }],
      actor: 'codex', project: 'skillex', rate: RATE, defaultOpen: true },
      h(T.EventRow, { time: '14:22:11.204', type: 'bloodbank.agent.tool.completed', headline: 'Bash · pnpm --filter @skillex/index build', durationMs: 18400 }),
      h(T.EventRow, { time: '14:21:52.771', type: 'bloodbank.agent.tool.completed', headline: 'Edit · src/index/registry.ts', durationMs: 42 }),
      h(T.EventRow, { time: '14:21:50.118', type: 'bloodbank.agent.tool.completed', headline: 'Read · src/index/registry.ts', durationMs: 9 })),
    h(T.EventRow, ROWS[4]));
}
""")

P['LifecycleTrack'] = ('group="Progress" height=232 subtitle="Where a ticket is in krebs, against each phase budget"', r"""
function phases(spec) {
  return T.KREBS_PHASES.map(function (p) { return Object.assign({}, p, spec[p.id] || {}); });
}
function Ticket(props) {
  return h('div', { style: { display: 'grid', gap: '10px' } },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, h(T.Ref, { kind: 'ticket', value: props.id }), h('span', { style: { font: 'var(--tt-font-strong)' } }, props.title)),
    h(T.LifecycleTrack, { phases: props.phases, reason: props.reason }));
}
function App() {
  return h('div', { className: 'pv', style: { gap: '24px' } },
    h(Ticket, { id: 'HOLOC-11', title: 'Ship the v6 internal-testing bundle', phases: phases({
      triage: { status: 'done', spent: 240 }, refining: { status: 'done', spent: 22 * 60 }, ready: { status: 'done', spent: 70 * 60 },
      in_progress: { status: 'done', spent: 108 * 60 }, review: { status: 'done', spent: 9 * 60 },
      qa: { status: 'current', spent: 72 * 60, note: 'retry 1/3' } }) }),
    h(Ticket, { id: 'BB-138', title: 'Fix hermes-agent non-UUID correlation IDs', reason: 'review-required: the reviewer must not be the implementer', phases: phases({
      triage: { status: 'done', spent: 180 }, refining: { status: 'skipped' }, ready: { status: 'done', spent: 15 * 60 },
      in_progress: { status: 'done', spent: 46 * 60 }, review: { status: 'blocked', spent: 3 * 3600 } }) }));
}
""")

P['StateTape'] = ('group="Progress" height=150 subtitle="Six hours of one agent; leads with time spent on you"', r"""
var SEGS = [
  { state: 'working', seconds: 50 * 60 }, { state: 'you', seconds: 22 * 60, note: 'gate: git push' },
  { state: 'working', seconds: 90 * 60 }, { state: 'you', seconds: 42 * 60, note: 'gate: rm -rf build' },
  { state: 'quiet', seconds: 30 * 60 }, { state: 'working', seconds: 40 * 60 },
  { state: 'stuck', seconds: 18 * 60, note: 'tool_running past 15m' }, { state: 'working', seconds: 28 * 60 }, { state: 'quiet', seconds: 40 * 60 },
];
function App() {
  return h('div', { className: 'pv' },
    h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px' } }, h('span', { style: { font: 'var(--tt-font-strong)' } }, 'skillex-pm'), h('span', { className: 'note' }, 'codex · skillex')),
    h(T.StateTape, { segments: SEGS }));
}
""")

P['Reading'] = ('group="Readings" height=236 subtitle="A value, what normal is, and how old the reading is"', r"""
function App() {
  return h('div', { className: 'pv', style: { gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '24px 32px' } },
    h(T.Reading, { label: 'HTTP probes broken', value: 26, of: 80, state: 'broken', note: '3 new since 09:00', age: 190, maxAge: 120 }),
    h(T.Reading, { label: 'Dead letters, last 7 days', value: 285, state: 'stuck', note: 'Growing, +41 today', trend: [24, 55, 84, 122, 174, 244, 285] }),
    h(T.Reading, { label: 'Failed units', value: 9, of: 476, state: 'broken', note: 'The same 9 for 2 days' }),
    h(T.Reading, { label: 'Events in Candystore', value: 918762, note: '+21,408 today', trend: [880100, 884900, 889300, 896200, 902800, 911000, 918762], age: 2, maxAge: 30 }));
}
""")

P['Spark'] = ('group="Readings" height=112 subtitle="A trend without axes"', r"""
function App() {
  function S(label, values, state) { return h('div', { style: { display: 'grid', gap: '4px' } }, h('span', { className: 'note' }, label), h(T.Spark, { values: values, state: state, width: 140, height: 32 })); }
  return h('div', { className: 'pv' }, h('div', { className: 'row', style: { gap: '16px 40px' } },
    S('Events per hour', [820, 940, 1210, 1830, 2950, 2410, 1650, 1420, 1980, 2240], 'quiet'),
    S('Errors per hour', [12, 9, 14, 11, 22, 18, 35, 61, 48, 74], 'broken'),
    S('Live scopes', [31, 33, 36, 34, 36, 38, 36], 'working')));
}
""")

P['Census'] = ('group="Readings" height=280 subtitle="A whole population at a glance, the problems named"', r"""
var NAMES = 'plane plane-api plane-minio-service n8n holocene-web holocene-api candystore hs-api grafana prometheus alertmanager loki ntfy traefik whoami naipkins minio-api minio-console fileshare svgme vault docs delodocs keepy-money tonnybox skillex pjangler srvls deckard event-toaster vox voxxy heyma wax orca codegraph hindsight-ui pgadmin redis-insight nats-monitor jetstream-ui portainer dozzle uptime glances homepage paperless immich jellyfin audiobookshelf calibre syncthing gitea registry buildkit cache-proxy pihole unbound wg-easy tailscale-derp searxng freshrss linkding wallabag excalidraw drawio stirling-pdf it-tools cyberchef ollama-ui comfy litellm vikunja kuma ntfy-web openwebui langfuse phoenix mlflow label-studio'.split(' ');
var BROKEN = { 'minio-api': '403', 'fileshare': '404', 'plane-minio-service': '403', 'svgme': '502', 'docs': '404', 'pgadmin': '502', 'jetstream-ui': '503', 'paperless': '502', 'calibre': '404', 'registry': '401', 'buildkit': 'timeout', 'wg-easy': '502', 'searxng': '503', 'wallabag': '500', 'drawio': '404', 'comfy': '502', 'langfuse': '500', 'phoenix': 'timeout', 'mlflow': '502', 'label-studio': '404', 'cache-proxy': '503', 'gitea': '502', 'linkding': '404', 'stirling-pdf': '502', 'audiobookshelf': '404', 'redis-insight': '401' };
var UNKNOWN = { 'tailscale-derp': 1, 'unbound': 1, 'pihole': 1, 'syncthing': 1, 'excalidraw': 1 };
var ITEMS = NAMES.map(function (n) {
  return { id: n, label: n + '.delo.sh', state: BROKEN[n] ? 'broken' : UNKNOWN[n] ? 'unknown' : 'quiet', detail: BROKEN[n] ? BROKEN[n] : UNKNOWN[n] ? 'never probed' : '200' };
});
function App() { return h('div', { className: 'pv', style: { maxWidth: '560px' } }, h(T.Census, { items: ITEMS, noun: 'probes', cell: 14 })); }
""")

P['Strata'] = ('group="Readings" height=320 subtitle="Event volume as stacked sediment, with decisions on a rail"', r"""
var HOURS = []; for (var i = 0; i < 24; i++) HOURS.push(String((15 + i) % 24).padStart(2, '0') + ':00');
var CLAUDE = [620, 540, 410, 220, 120, 60, 40, 30, 20, 30, 60, 140, 380, 720, 980, 1210, 1340, 1180, 1290, 1420, 1510, 1380, 1260, 1190];
var CODEX = [410, 380, 300, 260, 240, 180, 150, 120, 90, 110, 140, 220, 410, 560, 690, 820, 910, 840, 880, 960, 1040, 990, 900, 860];
var HERMES = [180, 170, 160, 150, 150, 140, 140, 130, 130, 130, 150, 170, 210, 240, 260, 280, 290, 270, 280, 300, 310, 300, 280, 270];
var OTHER = [20, 18, 12, 6, 4, 2, 2, 0, 0, 0, 4, 10, 30, 44, 52, 60, 64, 58, 60, 70, 80, 72, 60, 56];
var ERR = [14, 18, 12, 9, 22, 140, 96, 34, 12, 8, 10, 14, 18, 22, 20, 26, 30, 28, 24, 36, 41, 30, 26, 22];
var MARKS = [0.3, 1.6, 2.2, 4.5, 9.1, 12.4, 12.8, 13.3, 14.1, 14.6, 15.2, 15.7, 16.4, 17.1, 17.9, 18.5, 19.2, 19.8, 20.6, 21.3, 22.1, 22.8, 23.4]
  .map(function (a, i) { return { at: a, label: i % 3 ? 'holocene-pm · decision recorded' : '33god-pm · intake triaged' }; });
function App() {
  return h('div', { className: 'pv' }, h(T.Strata, {
    buckets: HOURS, errors: ERR, marks: MARKS,
    layers: [{ id: 'claude', label: 'claude', values: CLAUDE }, { id: 'codex', label: 'codex', values: CODEX }, { id: 'hermes', label: 'hermes', values: HERMES }, { id: 'other', label: 'other CLIs', values: OTHER }],
  }));
}
""")

P['AllClear'] = ('group="Empty states" height=330 subtitle="An empty state that proves it is empty"', r"""
var CHECKS = [
  { name: 'gates', result: '0 open, 17 scopes observed' },
  { name: 'bells', result: '0 unanswered' },
  { name: 'decisions', result: '0 awaiting, across 12 boards' },
  { name: 'wedged', result: '0 over budget' },
  { name: 'leases', result: '16 held, each with a live worker' },
  { name: 'blind hooks', result: '6 of 6 CLIs reporting' },
  { name: 'dead letters', result: '0 in the last hour' },
  { name: 'probes', result: '80 of 80 answering' },
  { name: 'units', result: '0 of 476 failed' },
];
function App() { return h('div', { className: 'pv', style: { padding: '32px 24px' } }, h(T.AllClear, { checks: CHECKS, newest: 4 })); }
""")


P['Home'] = ('group="Pages" page width=1280 height=1450 subtitle="The kit assembled: the operator home"', r"""
var MARK = function (size) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { display: 'block', flex: 'none' } },
    h('path', { d: 'M11 1.5A5.25 5.25 0 0 0 11 12ZM11 12a5.25 5.25 0 0 0 0 10.5ZM13 1.5A5.25 5.25 0 0 1 13 12Z', style: { fill: 'var(--ink)' } }),
    h('path', { d: 'M13 12a5.25 5.25 0 0 1 0 10.5Z', style: { fill: 'var(--ochre)' } }));
};
var HOURS = []; for (var i = 0; i < 24; i++) HOURS.push(String((15 + i) % 24).padStart(2, '0') + ':00');
var CLAUDE = [620, 540, 410, 220, 120, 60, 40, 30, 20, 30, 60, 140, 380, 720, 980, 1210, 1340, 1180, 1290, 1420, 1510, 1380, 1260, 1190];
var CODEX = [410, 380, 300, 260, 240, 180, 150, 120, 90, 110, 140, 220, 410, 560, 690, 820, 910, 840, 880, 960, 1040, 990, 900, 860];
var HERMES = [180, 170, 160, 150, 150, 140, 140, 130, 130, 130, 150, 170, 210, 240, 260, 280, 290, 270, 280, 300, 310, 300, 280, 270];
var OTHER = [20, 18, 12, 6, 4, 2, 2, 0, 0, 0, 4, 10, 30, 44, 52, 60, 64, 58, 60, 70, 80, 72, 60, 56];
var ERR = [14, 18, 12, 9, 22, 140, 96, 34, 12, 8, 10, 14, 18, 22, 20, 26, 30, 28, 24, 36, 41, 30, 26, 22];
var MARKS = [0.3, 1.6, 2.2, 4.5, 9.1, 12.4, 12.8, 13.3, 14.1, 14.6, 15.2, 15.7, 16.4, 17.1, 17.9, 18.5, 19.2, 19.8, 20.6, 21.3, 22.1, 22.8, 23.4].map(function (a) { return { at: a, label: 'holocene-pm · decision recorded' }; });
var PROBES = 'plane plane-api plane-minio-service n8n holocene-web holocene-api candystore hs-api grafana prometheus alertmanager loki ntfy traefik whoami naipkins minio-api minio-console fileshare svgme vault docs delodocs keepy-money tonnybox skillex pjangler srvls deckard event-toaster vox voxxy heyma wax orca codegraph hindsight-ui pgadmin redis-insight nats-monitor jetstream-ui portainer dozzle uptime glances homepage paperless immich jellyfin audiobookshelf calibre syncthing gitea registry buildkit cache-proxy pihole unbound wg-easy tailscale-derp searxng freshrss linkding wallabag excalidraw drawio stirling-pdf it-tools cyberchef ollama-ui comfy litellm vikunja kuma ntfy-web openwebui langfuse phoenix mlflow label-studio'.split(' ');
var BROKEN = { 'minio-api': '403', 'fileshare': '404', 'plane-minio-service': '403', 'svgme': '502', 'docs': '404', 'pgadmin': '502', 'jetstream-ui': '503', 'paperless': '502', 'calibre': '404', 'registry': '401', 'buildkit': 'timeout', 'wg-easy': '502', 'searxng': '503', 'wallabag': '500', 'drawio': '404', 'comfy': '502', 'langfuse': '500', 'phoenix': 'timeout', 'mlflow': '502', 'label-studio': '404', 'cache-proxy': '503', 'gitea': '502', 'linkding': '404', 'stirling-pdf': '502', 'audiobookshelf': '404', 'redis-insight': '401' };
var UNKNOWN = { 'tailscale-derp': 1, 'unbound': 1, 'pihole': 1, 'syncthing': 1, 'excalidraw': 1 };
var ITEMS = PROBES.map(function (n) { return { id: n, label: n + '.delo.sh', state: BROKEN[n] ? 'broken' : UNKNOWN[n] ? 'unknown' : 'quiet', detail: BROKEN[n] || (UNKNOWN[n] ? 'never probed' : '200') }; });
function App() {
  return h('div', { className: 'home' },
    h('header', { className: 'bar' },
      h('div', { className: 'brand' }, MARK(18), h('span', { className: 'word' }, '33GOD'), h('span', { className: 'app' }, 'Holocene')),
      h(T.SourceStrip, { sources: [
        { name: 'sweeper', age: 8, max: 15 }, { name: 'asm', value: '36/17', age: 12, max: 90 }, { name: 'candystore', value: '918,762', age: 2, max: 30 },
        { name: 'nats', value: '143,633', age: 1, max: 30 }, { name: 'probes', age: 190, max: 120 }, { name: 'fleet', age: 41, max: 60 }, { name: 'bridge', down: true }] }),
      h(T.Button, { variant: 'ghost', size: 'sm', icon: 'search', kbd: 'mod+k' }, 'Jump to')),
    h('section', { className: 'lead' },
      h('h1', { className: 'tt-display' }, 'Two things need you.'),
      h('p', { className: 'sub' }, 'One agent is stuck past its budget and 26 probes are broken. Everything else is moving.')),
    h('div', { className: 'tt-list needs', role: 'list' },
      h(T.NeedsYou, { kind: 'gate', title: h(React.Fragment, null, 'codex wants approval to run ', h('code', null, 'git push --force-with-lease')),
        meta: [h('span', { key: 1 }, 'codex · holocene'), h(T.Ref, { key: 2, kind: 'branch', value: 'holoc-11-play-version-6' })],
        waiting: 12 * 60, where: h(T.Ref, { kind: 'pane', value: 'pane 21' }), action: { label: 'Go to pane', kbd: 'enter' } }),
      h(T.NeedsYou, { kind: 'decision', title: 'Normalize the attention bell/gate split',
        meta: [h(T.Ref, { key: 1, kind: 'ticket', value: 'JIMB-277' }), h('span', { key: 2 }, 'james-brennan-pm')],
        waiting: 2 * 86400 + 3 * 3600, action: { label: 'Decide' } })),
    h('div', { className: 'cols' },
      h(T.Panel, { title: 'Working now', meta: [h(T.Signal, { key: 1, state: 'working', count: 3, label: false, title: '3 working' }), h(T.Signal, { key: 2, state: 'stuck', count: 1, label: false, title: '1 stuck' })], flush: true,
        actions: h(T.Segmented, { size: 'sm', label: 'Show', value: 'live', options: [{ value: 'live', label: 'Live', count: 5 }, { value: 'all', label: 'All PMs', count: 29 }] }) },
        h('div', { className: 'tt-list', role: 'list' },
          h(T.AgentLine, { name: '33god-pm', state: 'delegating', doing: 'Handing BB-138 to an opencode worker', held: 2 * 3600 + 36 * 60, budget: 7200, cli: 'hermes', repo: '33GOD', tools: 412, subs: 3, ticket: h(T.Ref, { kind: 'ticket', value: 'BB-138' }) }),
          h(T.AgentLine, { name: 'holocene-pm', state: 'tool_running', doing: 'Bumping the Play internal bundle to version 6', held: 66 * 60, budget: 7200, cli: 'codex', repo: 'holocene', tools: 241, ticket: h(T.Ref, { kind: 'ticket', value: 'HOLOC-11' }), pane: h(T.Ref, { kind: 'pane', value: 'pane 21' }) }),
          h(T.AgentLine, { name: 'james-brennan-pm', state: 'tool_running', doing: 'Running the tp_band projection tests', held: 14, cli: 'claude', repo: 'james-brennan', tools: 3, ticket: h(T.Ref, { kind: 'ticket', value: 'JIMB-284' }), pane: h(T.Ref, { kind: 'pane', value: 'pane 13' }) }),
          h(T.AgentLine, { name: 'skillex-pm', state: 'working', doing: 'Rebuilding the skill index after the registry edit', held: 4 * 60, cli: 'codex', repo: 'skillex', tools: 58 }),
          h(T.AgentLine, { name: 'candystore-pm', state: 'idle', doing: 'Completed the reconciliation pass without claiming work.', held: 80 * 60, cli: 'hermes', repo: 'candystore' }))),
      h(T.Panel, { title: 'Readings', meta: 'host and feeds' },
        h('div', { className: 'readings' },
          h(T.Reading, { label: 'HTTP probes broken', value: 26, of: 80, state: 'broken', note: '3 new since 09:00', age: 190, maxAge: 120 }),
          h(T.Reading, { label: 'Dead letters, last 7 days', value: 285, state: 'stuck', note: 'Growing, +41 today', trend: [24, 55, 84, 122, 174, 244, 285] }),
          h(T.Reading, { label: 'Failed units', value: 9, of: 476, state: 'broken', note: 'The same 9 for 2 days' })))),
    h(T.Panel, { title: 'Last 24 hours', meta: '21,408 events', actions: h(T.Segmented, { size: 'sm', label: 'Window', value: '24h', options: [{ value: '1h', label: '1h' }, { value: '6h', label: '6h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }] }) },
      h(T.Strata, { buckets: HOURS, errors: ERR, marks: MARKS, height: 140,
        layers: [{ id: 'claude', label: 'claude', values: CLAUDE }, { id: 'codex', label: 'codex', values: CODEX }, { id: 'hermes', label: 'hermes', values: HERMES }, { id: 'other', label: 'other CLIs', values: OTHER }] })),
    h('div', { className: 'cols' },
      h(T.Panel, { title: 'Recent events', meta: 'tool calls folded', flush: true, actions: h('div', { style: { width: '300px' } }, h(T.QueryField, { placeholder: 'bloodbank.agent.>' })) },
        h('div', { className: 'tt-log', role: 'table', 'aria-label': 'Recent events' },
          h(T.EventRow, { time: '14:22:11.481', type: 'bloodbank.agent.invocation.failed', headline: 'Worker exited 1, no evidence file written', actor: 'james-brennan-pm', durationMs: 412800, failed: true }),
          h(T.EventBurst, { count: 241, type: 'bloodbank.agent.tool.completed', from: '13:16:09', to: '14:22:11', span: 3962, breakdown: [{ label: 'Bash', count: 180 }, { label: 'Edit', count: 41 }, { label: 'Read', count: 14 }, { label: 'Grep', count: 6 }], actor: 'codex', project: 'holocene', rate: [3, 5, 4, 8, 12, 9, 6, 2, 0, 1, 7, 14, 18, 11, 9, 13, 16, 12, 10, 8] }),
          h(T.EventRow, { time: '14:20:03.118', type: 'bloodbank.repo.decision.recorded', headline: 'Keep the ticket sentinel as command plane; Kanban executes with WIP 1', actor: 'holocene-pm' }),
          h(T.EventRow, { time: '14:19:02.007', type: 'bloodbank.agent.session.started', headline: 'Session started in .worktrees/holoc-11-play-version-6', actor: 'codex' }),
          h(T.EventRow, { time: '14:18:30.912', type: 'bloodbank.repo.task.updated', headline: 'HOLOC-11 moved to In Progress', actor: 'plane' }))),
      h(T.Panel, { title: 'HTTP probes', meta: 'traefik-deathwatch' }, h(T.Census, { items: ITEMS, noun: 'probes', cell: 12, name: 3 }))));
}
""", """
.home{padding:0 32px 40px;display:grid;gap:28px;max-width:1280px;box-sizing:border-box}
.bar{display:flex;align-items:center;gap:24px;padding:14px 0;border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;flex:none}
.word{font:500 19px/1 var(--font-display);letter-spacing:-.005em;font-variation-settings:'opsz' 24}
.app{font:var(--tt-font-small);color:var(--ink-3);padding-left:10px;border-left:1px solid var(--line)}
.bar .tt-sources{flex:1;justify-content:flex-end}
.lead{display:grid;gap:6px;padding-top:12px}
.sub{margin:0;font:var(--tt-font-body);color:var(--ink-2)}
.needs{margin-top:-8px}
.cols{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:32px;align-items:start}
.readings{display:grid;gap:22px}
""")

def main():
    for name, spec in P.items():
        marker, script = spec[0], spec[1]
        style = spec[2] if len(spec) > 2 else ''
        d = os.path.join(ROOT, name)
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'preview.html'), 'w') as f:
            f.write(page(name, marker, script, style))
    print('wrote', len(P), 'previews')

if __name__ == '__main__':
    main()
