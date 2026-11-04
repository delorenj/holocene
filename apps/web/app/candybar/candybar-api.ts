// Writes go through the Holocene API's POST-only proxies (apps/api/src/candybar.ts); Candybar's own refusal comes back
// as { error } with its status, an unreachable Candybar as 502.

export type ActionResult = { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string };

export async function postAction(candybarId: string, path: string, body: Record<string, unknown> = {}): Promise<ActionResult> {
  try {
    const res = await fetch(`/api/modules/candybar/${encodeURIComponent(candybarId)}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store"
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { ok: false, status: res.status, error: typeof json.error === "string" ? json.error : `${res.status} ${res.statusText}` };
    return { ok: true, body: json };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
