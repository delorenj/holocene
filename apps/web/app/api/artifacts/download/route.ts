import { proxyArtifacts } from "../signed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Streams one catalog artifact (or bundle file) as an attachment; never rendered in this origin.
export async function GET(request: Request) {
  return proxyArtifacts(request, "download");
}
