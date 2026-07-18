"use client";

import {
  missingLifecycleProjection,
  normalizeLifecycleProjection,
  type LifecycleFrontierItem,
  type LifecycleProjection
} from "@holocene/lifecycle-client";
import { useCallback, useEffect, useState } from "react";
import { LifecycleDetails } from "./lifecycle-details";

export function LifecycleSurface({ lifecycleId }: { lifecycleId: string }) {
  const [projection, setProjection] = useState<LifecycleProjection>(() =>
    missingLifecycleProjection(lifecycleId, new Date().toISOString(), "Loading projection")
  );
  const [actorId, setActorId] = useState("");
  const [capabilityId, setCapabilityId] = useState("");
  const [busyFrontierId, setBusyFrontierId] = useState<string>();
  const [commandMessage, setCommandMessage] = useState<string>();
  const [commandError, setCommandError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/lifecycle/${encodeURIComponent(lifecycleId)}`, {
        cache: "no-store"
      });
      if (!response.ok) throw new Error(`Lifecycle API returned ${response.status}`);
      const next = normalizeLifecycleProjection(await response.json(), lifecycleId);
      setProjection(next);
      const firstGrant = next.capabilities[0];
      if (firstGrant) {
        setActorId((current) => current || firstGrant.actor_id);
        setCapabilityId((current) =>
          next.capabilities.some((grant) => grant.capability_id === current)
            ? current
            : firstGrant.capability_id
        );
      }
    } catch (error) {
      setProjection(
        missingLifecycleProjection(
          lifecycleId,
          new Date().toISOString(),
          error instanceof Error ? error.message : "Lifecycle API unavailable"
        )
      );
    }
  }, [lifecycleId]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const submit = async (frontier: LifecycleFrontierItem) => {
    if (
      projection.projection_status !== "current" ||
      !projection.state_version ||
      !projection.source?.event_id ||
      !projection.source.correlation_id ||
      !frontier.allowed ||
      frontier.expected_state_version !== projection.state_version ||
      !projection.legal_frontier.some(
        (item) =>
          item.id === frontier.id &&
          item.allowed &&
          item.expected_state_version === projection.state_version
      )
    ) {
      setCommandError("Lifecycle action is not in the current allowed frontier.");
      return;
    }
    if (frontier.action === "resolve_gate") {
      setCommandError("Gate resolution is disabled until a resolution choice is selected.");
      return;
    }
    const grant = projection.capabilities.find(
      (item) => item.capability_id === capabilityId && item.actor_id === actorId
    );
    if (!grant) {
      setCommandError("Select the authoritative capability grant for this actor.");
      return;
    }
    if (
      frontier.reason_code === "LEGAL_REQUIRES_CONFIRMATION" &&
      !window.confirm(`Submit confirmed Lifecycle action ${frontier.id}?`)
    ) {
      return;
    }
    setBusyFrontierId(frontier.id);
    setCommandMessage(undefined);
    setCommandError(undefined);
    try {
      const response = await fetch(`/api/lifecycle/${encodeURIComponent(lifecycleId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          frontier_id: frontier.id,
          expected_state_version: frontier.expected_state_version,
          actor: { type: "operator", agent_id: actorId },
          capability_id: capabilityId,
          parameters:
            frontier.reason_code === "LEGAL_REQUIRES_CONFIRMATION" ? { confirmed: true } : {}
        })
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        command_id?: string;
      };
      if (!response.ok) throw new Error(body.error ?? `command API returned ${response.status}`);
      setCommandMessage(
        `${body.message ?? "Broker processed the command."} Command ${body.command_id ?? "unknown"}.`
      );
      window.setTimeout(() => void load(), 1_000);
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : "Command publication failed");
    } finally {
      setBusyFrontierId(undefined);
    }
  };

  return (
    <LifecycleDetails
      projection={projection}
      actorId={actorId}
      capabilityId={capabilityId}
      busyFrontierId={busyFrontierId}
      commandMessage={commandMessage}
      commandError={commandError}
      onActorId={setActorId}
      onCapabilityId={setCapabilityId}
      onAction={(frontier) => void submit(frontier)}
    />
  );
}
