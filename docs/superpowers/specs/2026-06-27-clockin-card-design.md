# Clock-In/Out Card Design

Date: 2026-06-27
Project: Holocene / Orwell

## Goal
Add a simple, self-contained Clock-In/Out card to the Holocene Fleet tab that lets the user trigger clock-in or clock-out actions through a secure Holocene API proxy to the existing n8n webhook workflow.

## Decisions Made

- **UI placement:** Fleet tab (`apps/web/app/page.tsx`)
- **Communication:** Holocene API proxies calls to n8n webhooks (keeps `Authorization` header value server-side)
- **Webhook style:** Two separate webhook paths, `clockin` and `clockout`, in the same n8n workflow
- **State caching:** Browser `localStorage` under key `holocene-clock-state`

## n8n Workflow Changes

Workflow: `Clock-In/Out Toggle` (`1cBLVlb8q55K4Tu7`)

### Nodes

1. **clock-in** Webhook (existing)
   - Path: `clockin`
   - Method: `POST`
   - Authentication: Header Auth (`Authorization`)
   - Response Mode: `lastNode`
2. **clock-out** Webhook (new)
   - Path: `clockout`
   - Same authentication and response mode
3. **Clock In Action** — Orwell node
   - `operation`: `in`
4. **Clock Out Action** — Orwell node
   - `operation`: `out`
5. **Get State** — Orwell node
   - `operation`: `state`
6. **Respond to Webhook** — returns JSON response

### Flow

```
clock-in webhook  → Clock In Action → Get State → Respond to Webhook
clock-out webhook → Clock Out Action → Get State → Respond to Webhook
```

### Response Contract

On success:

```json
{
  "success": true,
  "action": "in" | "out",
  "state": "clocked_in" | "clocked_out" | "unknown",
  "timestamp": "2026-06-27T12:34:56Z"
}
```

On failure:

```json
{
  "success": false,
  "error": "Action failed: ...",
  "state": "unknown"
}
```

## Holocene API Changes

File: `apps/api/src/server.ts`

Add two POST routes:

- `POST /api/clock/in`
- `POST /api/clock/out`

Each route:

1. Forwards a `POST` to `https://n8n.delo.sh/webhook/clockin` or `https://n8n.delo.sh/webhook/clockout`
2. Adds header `Authorization: <N8N_WEBHOOK_AUTH_HEADER>`
3. Parses and returns the n8n JSON response
4. On upstream failure, returns `{success: false, error: "..."}` with appropriate HTTP status

### Environment Variables

- `N8N_WEBHOOK_BASE_URL` (default: `https://n8n.delo.sh`)
- `N8N_WEBHOOK_AUTH_HEADER` (sourced from 1Password `n8n` item, field `Main Header Auth`)

## Holocene Frontend Changes

### New Component

File: `apps/web/app/clock-card.tsx`

A client component with three states:

1. **Idle**
   - Shows two buttons: **Clock In**, **Clock Out**
   - Beneath buttons: cached last state text (e.g., "Last state: clocked_in")
2. **Loading**
   - Buttons disabled
   - Spinner replaces status text
3. **Result**
   - Green checkmark + new state on success
   - Red X + error message on failure
   - After a short delay (e.g., 3s), returns to Idle with updated cached state

### State Machine

```
Idle → loading on button click
Loading → success / error on response
Success / Error → Idle (after timeout) with updated cache
```

### Storage

- Key: `holocene-clock-state`
- Value: JSON `{state: string, updatedAt: string}`
- Read on mount; write on successful response

### Styling

- Reuse existing Holocene CSS patterns (utility classes, no new component library)
- Match Fleet tab visual style

### Integration

Import and render `<ClockCard />` near the top of `apps/web/app/page.tsx` (Fleet tab).

## Error Handling

- Network errors from API show red X with message
- n8n-level failures return `success: false` and are displayed as red X
- Orwell action failures are surfaced through n8n response
- Spinner remains until API response is received (synchronous call)

## Testing / Verification

1. n8n workflow validates and activates successfully
2. API routes respond correctly when called directly with `curl`
3. Frontend card renders on Fleet tab
4. Button clicks trigger spinner and show correct final state
5. localStorage cache updates after successful action
6. Error state renders correctly on forced failure

## Open Questions / Future Work

- Consider polling or refreshing state automatically when idle for a long period
- Consider adding last action timestamp to UI
