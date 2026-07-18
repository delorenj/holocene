const apiInternalUrl = (process.env.HOLOCENE_API_INTERNAL_URL ?? "http://localhost:4000").replace(
  /\/$/,
  ""
);

type RouteContext = {
  params: Promise<{ lifecycleId: string }>;
};

async function proxy(request: Request, lifecycleId: string, method: "GET" | "POST") {
  const target = `${apiInternalUrl}/api/modules/lifecycle/${encodeURIComponent(lifecycleId)}${
    method === "POST" ? "/actions" : ""
  }`;
  try {
    const body = method === "POST" ? await request.text() : undefined;
    const upstream = await fetch(target, {
      method,
      headers: {
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json" } : {})
      },
      body,
      cache: "no-store"
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "cache-control": "no-store",
        "content-type": upstream.headers.get("content-type") ?? "application/json; charset=utf-8"
      }
    });
  } catch (error) {
    return Response.json(
      {
        error: `Holocene API unavailable: ${error instanceof Error ? error.message : String(error)}`
      },
      { status: 502 }
    );
  }
}

export async function GET(request: Request, { params }: RouteContext) {
  const { lifecycleId } = await params;
  return proxy(request, lifecycleId, "GET");
}

export async function POST(request: Request, { params }: RouteContext) {
  const { lifecycleId } = await params;
  return proxy(request, lifecycleId, "POST");
}
