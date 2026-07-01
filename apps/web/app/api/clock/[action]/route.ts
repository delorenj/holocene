const apiInternalUrl = (process.env.HOLOCENE_API_INTERNAL_URL ?? "http://localhost:4000").replace(
  /\/$/,
  ""
);

const CLOCK_ACTIONS = new Set(["in", "out", "state"]);

type RouteContext = {
  params: Promise<{
    action: string;
  }>;
};

async function proxyClockRequest(action: string, method: "GET" | "POST") {
  if (!CLOCK_ACTIONS.has(action)) {
    return Response.json({ success: false, error: `Unknown clock action '${action}'.` }, { status: 404 });
  }

  const upstream = await fetch(`${apiInternalUrl}/api/clock/${action}`, {
    method,
    headers: {
      accept: "application/json"
    },
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
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { action } = await params;
  if (action !== "state") {
    return Response.json({ success: false, error: "Use POST for clock actions." }, { status: 405 });
  }

  return proxyClockRequest(action, "GET");
}

export async function POST(_request: Request, { params }: RouteContext) {
  const { action } = await params;
  if (action === "state") {
    return Response.json({ success: false, error: "Use GET for clock state." }, { status: 405 });
  }

  return proxyClockRequest(action, "POST");
}
