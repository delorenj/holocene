import { proxyArtifacts } from "../signed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Reached through the authenticated Holocene router; signed in ../signed.ts.
export async function GET(request: Request) {
  return proxyArtifacts(request, "catalog");
}
