#!/usr/bin/env bash
# Install the Agent Pad roster systemd user units and run the service once now. Idempotent.
# The .timer is retired: candybar owns the every-2-min schedule (33GOD/candybar, story 7.8).
# Usage: services/pad-roster/install.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/share/holocene-auto/pad-roster/avatars"
for unit in holocene-pad-roster.service holocene-pad-roster.timer; do
  ln -sfn "$here/$unit" "$HOME/.config/systemd/user/$unit"
done
systemctl --user daemon-reload
# Scheduling is owned by candybar (33GOD/candybar deploy/migration/ledger.yaml,
# id systemd:holocene-pad-roster.timer): the .timer is RETIRED, never re-enable it.
if systemctl --user is-enabled holocene-pad-roster.timer >/dev/null 2>&1; then
  echo "WARNING: holocene-pad-roster.timer is retired — disable it:" >&2
  echo "  systemctl --user disable --now holocene-pad-roster.timer" >&2
fi
systemctl --user start holocene-pad-roster.service
journalctl --user -u holocene-pad-roster.service -n 3 -o cat --no-pager
echo "roster: https://agent-pad.delo.sh/roster/roster.json"
