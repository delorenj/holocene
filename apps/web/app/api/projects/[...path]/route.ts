import { proxyReview } from "../review-proxy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HOLOC-70 project home and review API, through the signed proxy only.
type Ctx = { params: Promise<{ path: string[] }> };
const handle = async (request: Request, ctx: Ctx) => proxyReview(request, (await ctx.params).path);
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
