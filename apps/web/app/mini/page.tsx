import { MiniApp } from "../hq/hq-client";

// Holocene Mini in a normal browser. Not carved out of Traefik's Google auth (only /hq is), so this route and the
// /api/modules/* calls it makes are gated exactly like the rest of holocene.delo.sh.
export default function MiniPage() {
  return <MiniApp mode="browser" />;
}
