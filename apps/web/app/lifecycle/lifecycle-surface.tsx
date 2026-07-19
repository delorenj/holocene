"use client";

import {
  missingLifecycleProjection,
  normalizeLifecycleProjection,
  type LifecycleFrontierItem,
  type LifecycleProjection
} from "@holocene/lifecycle-client";
import { useCallback, useEffect, useState } from "react";
import {
  buildLifecycleActionRequest,
  lifecycleActionRequiresConfirmation,
  lifecycleConfirmationMessage,
  parseLifecycleCommandReceipt,
  type LifecycleCommandReceipt
} from "./lifecycle-action-contract";
import { LifecycleDetails } from "./lifecycle-details";

export function LifecycleSurface({ lifecycleId }: { lifecycleId: string }) {
  const [projection, setProjection] = useState<LifecycleProjection>(() =>
    missingLifecycleProjection(lifecycleId, new Date().toISOString(), "Loading projection")
  );
  const [actorId, setActorId] = useState("");
  const [capabilityId, setCapabilityId] = useState("");
  const [busyFrontierId, setBusyFrontierId] = useState<string>();
  const [commandReceipt, setCommandReceipt] = useState<LifecycleCommandReceipt>();
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
      lifecycleActionRequiresConfirmation(frontier) &&
      !window.confirm(lifecycleConfirmationMessage(frontier))
    ) {
      return;
    }
    setBusyFrontierId(frontier.id);
    setCommandReceipt(undefined);
    setCommandError(undefined);
    try {
      const response = await fetch(`/api/lifecycle/${encodeURIComponent(lifecycleId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildLifecycleActionRequest(frontier, actorId, capabilityId))
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (response.status !== 202) {
        throw new Error(body.error ?? `command API returned ${response.status}`);
      }
      setCommandReceipt(parseLifecycleCommandReceipt(body));
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
      commandReceipt={commandReceipt}
      commandError={commandError}
      onActorId={setActorId}
      onCapabilityId={setCapabilityId}
      onAction={(frontier) => void submit(frontier)}
    />
  );
}
