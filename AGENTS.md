# Holocene — Agent Guide

Mission control dashboard for the 33GOD Agentic Development Pipeline.

## Tech Stack

- **Framework:** React 18 + Vite
- **Language:** TypeScript
- **Package Manager:** pnpm
- **State:** Zustand
- **Data Fetching:** TanStack React Query
- **Visualization:** XYFlow (React Flow), Recharts
- **Styling:** Tailwind CSS
- **Deployment:** Docker

## Commands (mise)

| Task | Command |
|------|---------|
| Dev Server | `mise run dev` (Vite hot reload) |
| Build | `mise run build` (pnpm + Vite + Docker) |
| Deploy | `mise run deploy` |
| Test | `mise run test` (vitest) |
| Lint | `mise run lint` (eslint) |
| Logs | `mise run logs` |

## Key Scripts

- `schemas:sync` — Syncs Holyfields event schemas before dev/build
- `typecheck` — `tsc --noEmit`
- `format` — Prettier

## Conventions

- React Query for all server state; Zustand for client-only state
- Schemas auto-synced from Holyfields before dev/build (`predev`, `prebuild`)
- Components in `src/components/`, pages in `src/pages/`

## Anti-Patterns

- Never fetch data outside React Query hooks
- Never store server state in Zustand
- Never skip schema sync before building
