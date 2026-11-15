// The Harvest button's one write: POST /api/modules/transcripts/:id/harvest (apps/api/src/transcripts.ts),
// which publishes bloodbank.audio.harvest.start. Same result shape as candybar-api's postJson.

export type HarvestRequestResult =
  | { ok: true; commandId: string | null; correlationId: string | null }
  | { ok: false; status: number; error: string };

export async function postHarvest(transcriptId: number, force: boolean): Promise<HarvestRequestResult> {
  try {
    const res = await fetch(`/api/modules/transcripts/${transcriptId}/harvest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(force ? { force: true } : {}),
      cache: "no-store"
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, error: typeof json.error === "string" ? json.error : `${res.status} ${res.statusText}` };
    return {
      ok: true,
      commandId: typeof json.command_id === "string" ? json.command_id : null,
      correlationId: typeof json.correlation_id === "string" ? json.correlation_id : null
    };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
