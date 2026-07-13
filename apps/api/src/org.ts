import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { load } from "js-yaml";
import { merge } from "@holocene/org-model";
import type { LiveAgentState, OrgConfig, OrgTree, RegistryAgent } from "@holocene/org-model";
import { getFleetSnapshot } from "./fleet.js";

// The org chart is the fleet snapshot (P1 data path) arranged into the real
// reporting hierarchy the operator declares in ~/.hermes/org.yaml. All IO lives
// here; the pure resolver is @holocene/org-model.merge().
const ORG_PATH = process.env.HERMES_ORG_PATH ?? join(homedir(), ".hermes", "org.yaml");
const REGISTRY_PATH = process.env.HERMES_REGISTRY_PATH ?? join(homedir(), ".hermes", "agents-registry.yaml");

function readOrgConfig(): OrgConfig | undefined {
  if (!existsSync(ORG_PATH)) return undefined;
  const parsed = load(readFileSync(ORG_PATH, "utf8")) as OrgConfig | null | undefined;
  return parsed ?? undefined;
}

function readRegistryAgents(): RegistryAgent[] {
  if (!existsSync(REGISTRY_PATH)) return [];
  const parsed = load(readFileSync(REGISTRY_PATH, "utf8")) as
    | { agents?: Record<string, Record<string, any>> }
    | null
    | undefined;
  const agents = parsed?.agents ?? {};
  return Object.entries(agents).map(([agentId, cfg]) => ({
    agentId,
    repo: typeof cfg?.repo === "string" ? cfg.repo : "",
    displayName: typeof cfg?.display_name === "string" ? cfg.display_name : agentId,
    projectPath: typeof cfg?.project_path === "string" ? cfg.project_path : "",
    botUsername: cfg?.telegram?.bot_username || undefined,
    planeIdentifier: cfg?.plane?.identifier || undefined
  }));
}

export async function getOrgTree(): Promise<OrgTree> {
  const config = readOrgConfig();
  const agents = readRegistryAgents();
  const snapshot = await getFleetSnapshot();

  const live: Record<string, LiveAgentState> = {};
  for (const a of snapshot.agents) {
    live[a.agent_id] = {
      agentId: a.agent_id,
      busyState: a.busy_state,
      activeWork: {
        status: a.active_work?.status,
        issueId: a.active_work?.issue_id,
        summary: a.active_work?.summary,
        reason: a.active_work?.reason,
        lastHeartbeatAt: a.active_work?.last_heartbeat_at,
        ageSeconds: a.active_work?.age_seconds
      },
      updatedAt: a.active_work?.updated_at
    };
  }

  return merge({ config, agents, live, generatedAt: snapshot.generatedAt, source: ORG_PATH });
}
