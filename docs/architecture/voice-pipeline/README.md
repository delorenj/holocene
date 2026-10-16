# Voice memo pipeline: C4 diagrams

Date: 2026-10-16. Covers the whole path from a spoken memo on the Honda to an agent answering aloud, including the per-turn wall clock on the interactive lane (300 s default).

## Files

| File | What it is |
| --- | --- |
| [`workspace.dsl`](workspace.dsl) | Structurizr DSL C4 model and views: System Context, Container (Auto, Watcher, Hermes, Bloodbank), Component (Holocene Auto app, Hermes gateway plugin), Dynamic (one memo, 17 numbered steps). Source of truth for the model. |
| [`voice-pipeline-c4.html`](voice-pipeline-c4.html) | Self-contained page (inline SVG, Google Fonts only external). Level 1 context, level 2 containers with 13 numbered hops, level 3a car app, 3b gateway plugin, 3c timeout path, the dynamic swimlane with event and observability evidence per step, a container table and known gaps. Light and dark via `prefers-color-scheme`; the diagrams scroll horizontally on a phone. |
| [`voice-pipeline.excalidraw`](voice-pipeline.excalidraw) | The container view as an Excalidraw v2 scene (rectangles with bound text, arrows bound to elements). Open it at https://draw.delo.sh (File, Open, or drag it in). |
| [`png/`](png) | Renders of each HTML section: `01-context`, `02-containers`, `03a-auto-components`, `03b-gateway-components`, `03c-timeout-path`, `04-dynamic-memo`, plus `00-page-top`. |
| [`build/`](build) | The generator for the HTML (`python3 build/build.py`) and the Excalidraw scene (`python3 build/excalidraw.py`). Edit the section modules, rerun, and re-render PNGs. |

## What was verified, and how

Live on 2026-10-16 (about 16:30Z, host big-chungus):

- Containers, systemd units and ports: agent-pad-web, agent-pad-upload, Traefik, MinIO bucket `holocene-auto`, bloodbank-nats, candystore (+daprd, postgres), holocene-web, vox engines, ntfy-router, Prometheus (host port 9472) and Alertmanager were up; `holocene-inbox-watcher.service`, `hermes-gateway.service` and `holocene-api.service` were running.
- NATS streams and consumers via the monitor (`jsz`): both gateway durables (interactive: filter invoke, max_ack_pending 2, max_deliver 8; batch: filter start, 4, 5) with ack_pending 0.
- The dynamic view is a real run: memo `657e81ba-6c53-5f05-9e12-c4d2e196a996` (agent 33god-pm, interactive lane), COMPLETE in 65.0 s, reconstructed from `mise run memo:trace`, Candystore (`:8683/events?correlationid=`), the gateway journal and the upload proxy log.
- The per-turn timeout was proved live before this was drawn: hung turns closed `turn_timeout` at their deadline, the next command took the freed slot 37 ms later, and a real memo asking for `sleep 1000` was stopped at 300.1 s.
- `workspace.dsl` validated with `docker run --rm -v "$PWD":/w structurizr/cli validate -workspace /w/workspace.dsl` (exit 0) and exported to Mermaid without error. That CLI image is deprecated upstream in favour of Structurizr vNext, but it parses this DSL.
- HTML and PNGs: rendered in headless Chromium (light and dark, and a 390 px viewport with no page-level horizontal scroll) and inspected for overlapping labels.

Read from code and docs only, not confirmed live: the Android app internals (component names, CarHost fail-closed behaviour), n8n and PM producers of `invocation.start`, Hermes core `/stop` semantics.

Not verified (also listed on the page): how Agent Pad lists and fetches `replies/` (upload proxy GET versus direct s3.delo.sh), what the Honda actually has installed (repo says v10, the dev emulator runs v9, Play was not checked), the 51 resident messages in BLOODBANK_COMMANDS with no matching consumer, and any Mac-side component (none was found).

The Excalidraw scene was checked structurally (all arrow bindings resolve) and previewed with a small custom renderer, not in the Excalidraw editor itself, so open it once and nudge anything that renders slightly differently.
