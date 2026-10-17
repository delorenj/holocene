#!/usr/bin/env bash
# Install + enable the Agent Pad roster timer as systemd user units, run it once now. Idempotent.
# Usage: services/pad-roster/install.sh
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
mkdir -p "$HOME/.config/systemd/user" "$HOME/.local/share/holocene-auto/pad-roster/avatars"
for unit in holocene-pad-roster.service holocene-pad-roster.timer; do
  ln -sfn "$here/$unit" "$HOME/.config/systemd/user/$unit"
done
systemctl --user daemon-reload
systemctl --user enable --now holocene-pad-roster.timer >/dev/null
systemctl --user start holocene-pad-roster.service
systemctl --user --no-pager list-timers holocene-pad-roster.timer | head -3
journalctl --user -u holocene-pad-roster.service -n 3 -o cat --no-pager
echo "roster: https://agent-pad.delo.sh/roster/roster.json"
