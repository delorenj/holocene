/** @type {import('next').NextConfig} */
const apiInternalUrl = (process.env.HOLOCENE_API_INTERNAL_URL ?? "http://localhost:4000").replace(
  /\/$/,
  ""
);

// The pilot harvest worker (`px harvest worker`) serves the review form under /harvest/review/<harvest_id>/ on
// the host (0.0.0.0:18797). The review URL it emits is https://holocene.delo.sh/harvest/review/<id>/, so Holocene
// proxies that prefix; the holocene-web container reaches the host through host.docker.internal (extra_hosts).
const harvestWorkerUrl = (process.env.HARVEST_WORKER_URL ?? "http://host.docker.internal:18797").replace(/\/$/, "");

const nextConfig = {
  // Next would 308 /harvest/review/<id>/ to the slashless form before any rewrite runs; the worker's page and its
  // form actions are served under the slash form, so keep the slash and let the rewrites below match both.
  skipTrailingSlashRedirect: true,
  experimental: {
    typedRoutes: true
  },
  async rewrites() {
    return [
      {
        source: "/api/events/:path*",
        destination: `${apiInternalUrl}/api/events/:path*`
      },
      {
        source: "/api/modules/:path*",
        destination: `${apiInternalUrl}/api/modules/:path*`
      },
      {
        source: "/harvest/review/:path*/",
        destination: `${harvestWorkerUrl}/harvest/review/:path*/`
      },
      {
        source: "/harvest/review/:path*",
        destination: `${harvestWorkerUrl}/harvest/review/:path*`
      }
    ];
  }
};

export default nextConfig;
