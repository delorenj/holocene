export type Product = {
  id: string; name: string; stage: "launch" | "live" | "polish";
  declaration: { commit: string };
  destination?: { href: string; label: string; publishedAt?: string };
  launch?: { state: "attention" | "unknown" | "stale"; openActions?: number; ownerBlockers?: number; nextStep: string; observedAt?: string; source: "launch dashboard receipt" };
  issue?: string;
};
export type ProductsPayload = {
  generatedAt: string;
  registry: { state: "ok" | "down"; snapshotAt?: string; ageSeconds?: number; detail?: string };
  products: Product[];
  issues: Array<{ id: string; name: string; state: string; detail: string }>;
};
