# Clock-In/Out Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing n8n `Clock-In/Out Toggle` workflow to handle both clock-in and clock-out webhooks, proxy them through the Holocene API, and render a control card on the Fleet tab.

**Architecture:** The n8n workflow exposes two Header Auth webhooks (`clockin`, `clockout`). Each webhook triggers an Orwell action (`in`/`out`) and then a state check, returning JSON. The Holocene API adds `POST /api/clock/in` and `POST /api/clock/out` routes that forward requests to n8n with the auth header stored server-side. The Fleet tab renders a new client `ClockCard` that calls the Holocene API, shows a spinner while waiting, and caches the last state in `localStorage`.

**Tech Stack:** n8n (webhooks + Orwell node), Fastify (Holocene API), React/Next.js (Holocene web), TypeScript.

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `workflows/orwell-clock-in-out.json` | Modify | Source-controlled n8n workflow backup (already synced in prior fix) |
| n8n workflow `1cBLVlb8q55K4Tu7` (via MCP / API) | Modify | Live webhook workflow with clock-in/out webhooks and Orwell actions |
| `apps/api/src/server.ts` | Modify | Fastify routes that proxy to n8n webhooks |
| `apps/web/app/clock-card.tsx` | Create | Client React card component with buttons, spinner, status |
| `apps/web/app/page.tsx` | Modify | Import and render `<ClockCard apiBase={apiBase} />` on Fleet tab |
| `.env` / `.env.op` / `.env.holocene-web` | Modify | Add `N8N_WEBHOOK_BASE_URL` and `N8N_WEBHOOK_AUTH_HEADER` |

---

### Task 1: Extend the n8n webhook workflow

**Files:**
- Modify: n8n workflow `1cBLVlb8q55K4Tu7` (use `n8n_update_partial_workflow` or direct API)
- Test: `curl -X POST https://n8n.delo.sh/webhook/clockin -H "Authorization: $AUTH"`

The workflow currently contains only one Webhook node (`clock-in`). Add the remaining nodes and connections.

- [ ] **Step 1: Add `clock-out` webhook node**

```json
{
  "id": "c8f8e8b0-5e9c-4b6e-9f8e-123456789abc",
  "name": "clock-out",
  "type": "n8n-nodes-base.webhook",
  "typeVersion": 2,
  "position": [900, 300],
  "webhookId": "clockout",
  "parameters": {
    "path": "clockout",
    "responseMode": "lastNode",
    "httpMethod": "POST",
    "options": {}
  },
  "credentials": {
    "httpHeaderAuth": {
      "id": "uhECgIL4sJJqgHaJ",
      "name": "Header Auth account"
    }
  }
}
```

- [ ] **Step 2: Add Orwell action nodes**

`Clock In Action`:

```json
{
  "id": "a1b2c3d4-5e6f-7a8b-9c0d-ef1234567890",
  "name": "Clock In Action",
  "type": "n8n-nodes-orwell.orwell",
  "typeVersion": 1,
  "position": [700, 100],
  "parameters": {
    "operation": "in",
    "repoPath": "/home/delorenj/code/clockin",
    "pythonPath": "/home/delorenj/code/clockin/.venv/bin/python",
    "timeoutSeconds": 60
  }
}
```

`Clock Out Action`:

```json
{
  "id": "b2c3d4e5-6f7a-8b9c-0d1e-f23456789012",
  "name": "Clock Out Action",
  "type": "n8n-nodes-orwell.orwell",
  "typeVersion": 1,
  "position": [1100, 300],
  "parameters": {
    "operation": "out",
    "repoPath": "/home/delorenj/code/clockin",
    "pythonPath": "/home/delorenj/code/clockin/.venv/bin/python",
    "timeoutSeconds": 60
  }
}
```

`Get State`:

```json
{
  "id": "c3d4e5f6-7a8b-9c0d-1e2f-345678901234",
  "name": "Get State",
  "type": "n8n-nodes-orwell.orwell",
  "typeVersion": 1,
  "position": [900, 100],
  "parameters": {
    "operation": "state",
    "repoPath": "/home/delorenj/code/clockin",
    "pythonPath": "/home/delorenj/code/clockin/.venv/bin/python",
    "timeoutSeconds": 60
  }
}
```

`Respond to Webhook`:

```json
{
  "id": "d4e5f6a7-8b9c-0d1e-2f34-567890123456",
  "name": "Respond to Webhook",
  "type": "n8n-nodes-base.respondToWebhook",
  "typeVersion": 1.1,
  "position": [1100, 100],
  "parameters": {
    "options": {},
    "respondWith": "json",
    "responseBody": "={{ JSON.stringify({\n  success: true,\n  action: $json.action,\n  state: $json.state?.derived_status ?? $json.state ?? 'unknown',\n  timestamp: new Date().toISOString()\n}) }}"
  }
}
```

- [ ] **Step 3: Wire connections**

```json
{
  "clock-in": {
    "main": [
      [
        {
          "node": "Clock In Action",
          "type": "main",
          "index": 0
        }
      ]
    ]
  },
  "Clock In Action": {
    "main": [
      [
        {
          "node": "Get State",
          "type": "main",
          "index": 0
        }
      ]
    ]
  },
  "clock-out": {
    "main": [
      [
        {
          "node": "Clock Out Action",
          "type": "main",
          "index": 0
        }
      ]
    ]
  },
  "Clock Out Action": {
    "main": [
      [
        {
          "node": "Get State",
          "type": "main",
          "index": 0
        }
      ]
    ]
  },
  "Get State": {
    "main": [
      [
        {
          "node": "Respond to Webhook",
          "type": "main",
          "index": 0
        }
      ]
    ]
  }
}
```

- [ ] **Step 4: Activate the workflow**

Use `n8n_update_partial_workflow` with operation `activateWorkflow`.

- [ ] **Step 5: Test the webhooks directly**

```bash
AUTH="5362baf-c777-4d57-a609-6eaf1f9e87f6"
curl -X POST https://n8n.delo.sh/webhook/clockin -H "Authorization: $AUTH" -i
curl -X POST https://n8n.delo.sh/webhook/clockout -H "Authorization: $AUTH" -i
```

Expected: HTTP 200 with JSON response containing `success`, `action`, `state`, `timestamp`.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/plans/2026-06-27-clockin-card.md
git commit -m "feat(n8n): add clock-out webhook and response wiring"
```

---

### Task 2: Add Holocene API proxy routes

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `.env` / `.env.op`
- Test: `curl -X POST http://localhost:4000/api/clock/in`

- [ ] **Step 1: Add environment variable reads at the top of `server.ts`**

After the existing import block, add:

```typescript
const N8N_WEBHOOK_BASE_URL = (process.env.N8N_WEBHOOK_BASE_URL ?? "https://n8n.delo.sh").replace(/\/$/, "");
const N8N_WEBHOOK_AUTH_HEADER = process.env.N8N_WEBHOOK_AUTH_HEADER ?? "";

if (!N8N_WEBHOOK_AUTH_HEADER) {
  app.log.warn("N8N_WEBHOOK_AUTH_HEADER is not set; /api/clock routes will fail.");
}
```

- [ ] **Step 2: Add a helper function for forwarding to n8n**

Before `app.listen`, add:

```typescript
async function forwardClockAction(action: "in" | "out") {
  const url = `${N8N_WEBHOOK_BASE_URL}/webhook/clock${action}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: N8N_WEBHOOK_AUTH_HEADER,
      Accept: "application/json"
    }
  });

  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      body
    };
  }

  return {
    ok: true,
    status: res.status,
    body
  };
}
```

- [ ] **Step 3: Add `/api/clock/in` and `/api/clock/out` routes**

After the `/health` route, add:

```typescript
app.post("/api/clock/in", async (_req, reply) => {
  const result = await forwardClockAction("in");
  if (!result.ok) {
    return reply.status(result.status || 502).send({
      success: false,
      error: "Upstream n8n call failed",
      upstream: result.body
    });
  }
  return reply.send(result.body);
});

app.post("/api/clock/out", async (_req, reply) => {
  const result = await forwardClockAction("out");
  if (!result.ok) {
    return reply.status(result.status || 502).send({
      success: false,
      error: "Upstream n8n call failed",
      upstream: result.body
    });
  }
  return reply.send(result.body);
});
```

- [ ] **Step 4: Update environment files**

Add to `.env` and `.env.op`:

```bash
N8N_WEBHOOK_BASE_URL=https://n8n.delo.sh
N8N_WEBHOOK_AUTH_HEADER=5362baf-c777-4d57-a609-6eaf1f9e87f6
```

- [ ] **Step 5: Restart the API and test**

```bash
cd /home/delorenj/code/33GOD/holocene
pm2 restart holocene-api 2>/dev/null || npm run dev --workspace=apps/api
```

Test:

```bash
curl -X POST http://localhost:4000/api/clock/in -i
curl -X POST http://localhost:4000/api/clock/out -i
```

Expected: HTTP 200 with the same JSON shape returned by n8n.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/server.ts .env .env.op
git commit -m "feat(api): add /api/clock/in and /api/clock/out proxy routes"
```

---

### Task 3: Create the ClockCard React component

**Files:**
- Create: `apps/web/app/clock-card.tsx`
- Test: Render in isolation or via Next.js dev server

- [ ] **Step 1: Create `apps/web/app/clock-card.tsx`**

```typescript
"use client";

import { useCallback, useEffect, useState } from "react";

type ClockStatus = "idle" | "loading" | "success" | "error";

type ClockState = {
  state: string;
  updatedAt: string;
};

type ClockResponse = {
  success: boolean;
  action?: string;
  state?: string;
  error?: string;
};

const STORAGE_KEY = "holocene-clock-state";
const RESULT_DISPLAY_MS = 3000;

function loadCachedState(): ClockState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ClockState;
    if (typeof parsed.state === "string" && typeof parsed.updatedAt === "string") return parsed;
    return null;
  } catch {
    return null;
  }
}

function saveCachedState(state: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state, updatedAt: new Date().toISOString() })
    );
  } catch {
    // ignore storage errors
  }
}

export function ClockCard({ apiBase }: { apiBase: string }) {
  const [status, setStatus] = useState<ClockStatus>("idle");
  const [message, setMessage] = useState<string>("");
  const [cachedState, setCachedState] = useState<ClockState | null>(loadCachedState);

  useEffect(() => {
    setCachedState(loadCachedState);
  }, []);

  const invoke = useCallback(
    async (action: "in" | "out") => {
      if (status === "loading") return;
      setStatus("loading");
      setMessage("");

      try {
        const res = await fetch(`${apiBase}/api/clock/${action}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          cache: "no-store"
        });

        const body = (await res.json().catch(() => ({}))) as ClockResponse;

        if (!res.ok || !body.success) {
          throw new Error(body.error ?? `Clock ${action} failed (${res.status})`);
        }

        const newState = body.state ?? "unknown";
        saveCachedState(newState);
        setCachedState({ state: newState, updatedAt: new Date().toISOString() });
        setStatus("success");
        setMessage(newState);
      } catch (err) {
        setStatus("error");
        setMessage(err instanceof Error ? err.message : "Unexpected error");
      }

      window.setTimeout(() => {
        setStatus((current) => (current === "success" || current === "error" ? "idle" : current));
      }, RESULT_DISPLAY_MS);
    },
    [apiBase, status]
  );

  const stateLabel = cachedState
    ? `Last state: ${cachedState.state} · ${new Date(cachedState.updatedAt).toLocaleTimeString()}`
    : "Last state: unknown";

  return (
    <section className="clock-card" aria-label="Clock in / out">
      <div className="clock-card-header">
        <h2>Orwell</h2>
        <p className="section-note">Manual clock-in / clock-out control.</p>
      </div>
      <div className="clock-card-actions">
        <button
          className="clock-btn clock-btn-in"
          disabled={status === "loading"}
          onClick={() => void invoke("in")}
          type="button"
        >
          Clock In
        </button>
        <button
          className="clock-btn clock-btn-out"
          disabled={status === "loading"}
          onClick={() => void invoke("out")}
          type="button"
        >
          Clock Out
        </button>
      </div>
      <div className="clock-card-status" aria-live="polite">
        {status === "idle" ? <span>{stateLabel}</span> : null}
        {status === "loading" ? <span className="clock-spinner" aria-label="Loading" /> : null}
        {status === "success" ? (
          <span className="clock-status clock-status-success">
            <span aria-hidden>✓</span> {message}
          </span>
        ) : null}
        {status === "error" ? (
          <span className="clock-status clock-status-error">
            <span aria-hidden>✕</span> {message}
          </span>
        ) : null}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/clock-card.tsx
git commit -m "feat(web): add ClockCard component"
```

---

### Task 4: Integrate ClockCard into the Fleet tab

**Files:**
- Modify: `apps/web/app/page.tsx`

- [ ] **Step 1: Import and render the card**

At the top of `apps/web/app/page.tsx`, add:

```typescript
import { ClockCard } from "./clock-card";
```

Inside the Fleet tab panel (the `tab === "fleet"` branch), near the top before the existing `summary-grid`, add:

```tsx
<ClockCard apiBase={apiBase} />
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/page.tsx
git commit -m "feat(web): render ClockCard on Fleet tab"
```

---

### Task 5: Add CSS for the card

**Files:**
- Modify: `apps/web/app/globals.css`

- [ ] **Step 1: Append clock card styles**

Add to the end of `apps/web/app/globals.css`:

```css
.clock-card {
  background: var(--surface, #1e1e2e);
  border: 1px solid var(--border, #313244);
  border-radius: 12px;
  padding: 1rem 1.25rem;
  margin-bottom: 1.5rem;
}

.clock-card-header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.clock-card-header h2 {
  margin: 0;
  font-size: 1.1rem;
}

.clock-card-actions {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.clock-btn {
  flex: 1;
  padding: 0.6rem 1rem;
  border: none;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  color: #fff;
}

.clock-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.clock-btn-in {
  background: #a6da95;
  color: #1e1e2e;
}

.clock-btn-out {
  background: #ed8796;
  color: #1e1e2e;
}

.clock-card-status {
  min-height: 1.5rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.9rem;
  color: var(--muted, #a6adc8);
}

.clock-spinner {
  width: 1rem;
  height: 1rem;
  border: 2px solid var(--border, #313244);
  border-top-color: var(--accent, #8aadf4);
  border-radius: 50%;
  animation: clock-spin 1s linear infinite;
}

@keyframes clock-spin {
  to {
    transform: rotate(360deg);
  }
}

.clock-status-success {
  color: #a6da95;
}

.clock-status-error {
  color: #ed8796;
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/app/globals.css
git commit -m "feat(web): add ClockCard styles"
```

---

### Task 6: End-to-end verification

- [ ] **Step 1: Restart all services**

```bash
cd /home/delorenj/code/33GOD/holocene
pm2 restart holocene-api 2>/dev/null
npm run dev --workspace=apps/web
```

- [ ] **Step 2: Test API proxy**

```bash
curl -X POST http://localhost:4000/api/clock/in -i
curl -X POST http://localhost:4000/api/clock/out -i
```

Expected: HTTP 200 with JSON containing `success: true`, `action`, `state`, `timestamp`.

- [ ] **Step 3: Test UI in browser**

Open `http://localhost:3000`, switch to the Fleet tab, click **Clock In** and **Clock Out**. Verify:

- Buttons disable during the call.
- Spinner appears in the status area.
- Green checkmark and new state appear after success.
- Red X and error message appear after failure.
- Last state persists after page reload.

- [ ] **Step 4: Verify n8n workflow is active**

```bash
curl -sS -H "X-N8N-API-KEY: $N8N_API_KEY" \
  https://n8n.delo.sh/api/v1/workflows/1cBLVlb8q55K4Tu7 | jq '{name, active}'
```

Expected: `active: true`.

- [ ] **Step 5: Final commit and tag**

```bash
git add docs/superpowers/plans/2026-06-27-clockin-card.md
git commit -m "feat: finish clock-in/out webhook card and n8n workflow wiring"
```

---

## Self-Review Checklist

- **Spec coverage:**
  - n8n workflow extends with clock-out webhook and response → Task 1
  - Holocene API proxies to n8n → Task 2
  - Frontend card with two buttons, spinner, status, cache → Tasks 3-5
  - Verification → Task 6
- **Placeholder scan:** No TBD/TODO; exact env var values are included from 1Password; UUIDs in n8n nodes are explicit v4 placeholders — they must be regenerated to real UUIDs before creating nodes.
- **Type consistency:** `ClockResponse`, `ClockState`, and `forwardClockAction` all use the same response shape (`success`, `action`, `state`, `error`).

## Notes / Risks

- **UUIDs:** The n8n node IDs in this plan are illustrative. Generate real UUID v4 values when creating nodes (e.g., `crypto.randomUUID()` or an online generator).
- **Auth exposure:** The auth header lives in Holocene API env vars and is never sent to the browser.
- **Manual clock actions:** Testing the buttons will perform real clock-in/out actions against the live system.
- **MCP validator:** The n8n MCP validator may reject the workflow due to unknown custom node types or cron-trigger detection issues; use the direct n8n PUT API if needed (see previous Hindsight memory).
