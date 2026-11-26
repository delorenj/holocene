import { proxyArtifacts } from "../signed";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The sandboxed srcdoc for one catalog artifact (HOLOC-69); the API resolves it by catalog id only.
export async function GET(request: Request) {
  return proxyArtifacts(request, "document");
}
