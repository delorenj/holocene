# Holocene

Holocene is a 33GOD control-plane dashboard that surfaces live fleet, tooling,
and pipeline health from API services, Redis-backed stats, and SSE/polling
feeds. Its UI is built around generic live data components, where specific
panels like Hook Health are just collection renderers over structured backend
payloads.

Holocene Auto and Agent Pad: the simulator iteration loop is in [apps/auto/DEV.md](apps/auto/DEV.md).
