// The focus-restore intent (action-store.ts) ends when the operator takes over (HOLOC-24 round 3, N8): any pointerdown
// or keydown means they are driving, so a poll that lands afterwards must not pull focus back to a row's button. The
// 15 s timer stays as the backstop for an operator who does nothing.

type Target = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Calls `end` on the first pointerdown or keydown (capture phase, so a handler that stops propagation still counts),
 * ignoring key auto-repeat. Returns the cleanup.
 */
export function endOnInteraction(target: Target, end: () => void): () => void {
  const onEvent = (e: Event) => {
    if ((e as { repeat?: boolean }).repeat) return;
    end();
  };
  const capture = { capture: true } as const;
  target.addEventListener("pointerdown", onEvent, capture);
  target.addEventListener("keydown", onEvent, capture);
  return () => {
    target.removeEventListener("pointerdown", onEvent, capture);
    target.removeEventListener("keydown", onEvent, capture);
  };
}
