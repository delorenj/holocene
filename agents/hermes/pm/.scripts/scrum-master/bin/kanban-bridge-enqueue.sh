#!/usr/bin/env bash
# Enqueue (or retrieve via idempotency) a Hermes Kanban execution card for a
# provider issue. Keeps ticket-provider ownership in tp while giving the
# dispatcher a durable worker task.
#
# Usage:
#   kanban-bridge-enqueue.sh ISSUE_ID ASSIGNEE_PROFILE [--workspace worktree|scratch|dir:<path>] [--tenant TENANT] [--dry-run]
#
# Output:
#   JSON summary with issue + kanban task identity.
set -euo pipefail

if [[ "${1:-}" == "" || "${2:-}" == "" ]]; then
  printf 'Usage: %s ISSUE_ID ASSIGNEE_PROFILE [--workspace <kind>] [--tenant <tenant>] [--dry-run]\n' "$0" >&2
  exit 2
fi

ISSUE_ID="$1"
ASSIGNEE_PROFILE="$2"
shift 2

WORKSPACE_KIND="${KANBAN_BRIDGE_WORKSPACE:-worktree}"
TENANT_VALUE="${HERMES_TENANT:-}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace)
      WORKSPACE_KIND="${2:-}"
      shift 2
      ;;
    --tenant)
      TENANT_VALUE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    *)
      printf 'Unknown option: %s\n' "$1" >&2
      exit 2
      ;;
  esac
done

case "$ISSUE_ID" in
  *[!A-Za-z0-9_-]*)
    printf 'Invalid issue id: %s\n' "$ISSUE_ID" >&2
    exit 2
    ;;
esac

BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENGINE_DIR="$(cd "$BIN_DIR/.." && pwd)"
SCRIPTS_DIR="$(cd "$ENGINE_DIR/.." && pwd)"
ROLE_DIR="$(cd "$SCRIPTS_DIR/.." && pwd)"
ROLE_YAML="$ROLE_DIR/role.yaml"

# shellcheck source=../lib/ticket-provider.sh
source "$SCRIPTS_DIR/lib/ticket-provider.sh"

# Prefer the role wrapper so runtime/profile wiring stays consistent.
HERMES_CLI="${HERMES_BIN:-$ROLE_DIR/hermes}"

# Extract provider name from role.yaml through adapter resolver.
PROVIDER="$(tp_provider_name)"

ISSUE_JSON="$(tp get_issue "$ISSUE_ID")"
MILESTONE_JSON="$(tp active_milestone || echo '{}')"

readarray -t EXTRACT < <(
  python3 - "$ISSUE_JSON" "$MILESTONE_JSON" <<'PYEOF'
import json, sys
issue = json.loads(sys.argv[1])
milestone = json.loads(sys.argv[2])
issue_key = str(issue.get("key") or issue.get("id") or "")
issue_title = str(issue.get("title") or "Untitled issue")
issue_desc = str(issue.get("description") or "")
issue_acceptance = str(issue.get("acceptance") or issue_desc)
milestone_id = str(milestone.get("id") or "")
milestone_name = str(milestone.get("name") or "")
print(issue_key)
print(issue_title)
print(issue_desc)
print(issue_acceptance)
print(milestone_id)
print(milestone_name)
PYEOF
)

ISSUE_KEY="${EXTRACT[0]}"
ISSUE_TITLE="${EXTRACT[1]}"
ISSUE_DESC="${EXTRACT[2]}"
ISSUE_ACCEPTANCE="${EXTRACT[3]}"
MILESTONE_ID="${EXTRACT[4]}"
MILESTONE_NAME="${EXTRACT[5]}"

if [[ -z "$ISSUE_KEY" ]]; then
  printf 'Unable to resolve issue key for %s\n' "$ISSUE_ID" >&2
  exit 1
fi

TASK_TITLE="[${PROVIDER^^} ${ISSUE_KEY}] ${ISSUE_TITLE}"
IDEMPOTENCY_KEY="provider:${PROVIDER}:issue:${ISSUE_ID}"
EVIDENCE_FILE="_bmad-output/implementation-artifacts/issue-evidence/${ISSUE_ID}.md"

TASK_BODY=$(cat <<EOF
Provider issue bridge card.

Provider metadata:
- provider: ${PROVIDER}
- provider_issue_id: ${ISSUE_ID}
- provider_issue_key: ${ISSUE_KEY}
- milestone_id: ${MILESTONE_ID}
- milestone_name: ${MILESTONE_NAME}
- evidence_file: ${EVIDENCE_FILE}
- implementer_profile: ${ASSIGNEE_PROFILE}
- wip_slot: implementation-1

Execution instructions:
1. Implement acceptance criteria for provider issue ${ISSUE_KEY}.
2. Keep changes bounded to current issue scope.
3. Report completion summary and verification evidence.
4. If blocked on human decision, call kanban_block with explicit reason.

Acceptance criteria snapshot:
${ISSUE_ACCEPTANCE}

Issue description snapshot:
${ISSUE_DESC}
EOF
)

if [[ "$DRY_RUN" -eq 1 ]]; then
  python3 - "$TASK_TITLE" "$IDEMPOTENCY_KEY" "$WORKSPACE_KIND" "$TENANT_VALUE" "$ASSIGNEE_PROFILE" "$PROVIDER" "$ISSUE_ID" "$ISSUE_KEY" "$MILESTONE_ID" "$EVIDENCE_FILE" <<'PYEOF'
import json, sys
print(json.dumps({
  "mode": "dry-run",
  "task_title": sys.argv[1],
  "idempotency_key": sys.argv[2],
  "workspace": sys.argv[3],
  "tenant": sys.argv[4],
  "assignee": sys.argv[5],
  "bridge_metadata": {
    "provider": sys.argv[6],
    "provider_issue_id": sys.argv[7],
    "provider_issue_key": sys.argv[8],
    "milestone_id": sys.argv[9],
    "evidence_file": sys.argv[10],
    "implementer_profile": sys.argv[5],
    "wip_slot": "implementation-1",
  }
}, indent=2))
PYEOF
  exit 0
fi

CREATE_ARGS=(kanban create "$TASK_TITLE" --assignee "$ASSIGNEE_PROFILE" --body "$TASK_BODY" --workspace "$WORKSPACE_KIND" --idempotency-key "$IDEMPOTENCY_KEY" --created-by "scrum-master-bridge" --json)
if [[ -n "$TENANT_VALUE" ]]; then
  CREATE_ARGS+=(--tenant "$TENANT_VALUE")
fi

CREATE_OUTPUT="$($HERMES_CLI "${CREATE_ARGS[@]}")"

TASK_ID="$(python3 - "$CREATE_OUTPUT" <<'PYEOF'
import json, re, sys
raw = sys.argv[1]
try:
    data = json.loads(raw)
except Exception:
    data = {}
for key in ("task_id", "id", "task"):
    v = data.get(key)
    if isinstance(v, str) and v:
        print(v)
        raise SystemExit(0)
if isinstance(data.get("task"), dict):
    tid = data["task"].get("id")
    if isinstance(tid, str) and tid:
        print(tid)
        raise SystemExit(0)
m = re.search(r"\b(t_[a-zA-Z0-9]+)\b", raw)
if m:
    print(m.group(1))
PYEOF
)"

python3 - "$TASK_ID" "$ISSUE_ID" "$ISSUE_KEY" "$PROVIDER" "$MILESTONE_ID" "$ASSIGNEE_PROFILE" "$WORKSPACE_KIND" "$IDEMPOTENCY_KEY" <<'PYEOF'
import json, sys
print(json.dumps({
  "task_id": sys.argv[1],
  "provider_issue_id": sys.argv[2],
  "provider_issue_key": sys.argv[3],
  "provider": sys.argv[4],
  "milestone_id": sys.argv[5],
  "assignee": sys.argv[6],
  "workspace": sys.argv[7],
  "idempotency_key": sys.argv[8],
}, indent=2))
PYEOF
