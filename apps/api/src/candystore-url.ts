// The Candystore API base every holocene-api reader uses. 8683 is the
// cross-peer loopback port contract (candystore README "Port contract"); each
// machine queries its own store there. CANDYSTORE_API_URL (the host API unit's
// knob) wins, then the platform-wide CANDYSTORE_URL; blank values fall through.
export const CANDYSTORE_DEFAULT_URL = "http://127.0.0.1:8683";

export function candystoreBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  for (const key of ["CANDYSTORE_API_URL", "CANDYSTORE_URL"] as const) {
    const value = env[key]?.trim();
    if (value) return value.replace(/\/+$/, "");
  }
  return CANDYSTORE_DEFAULT_URL;
}
