/** @type {import('next').NextConfig} */
const apiInternalUrl = (process.env.HOLOCENE_API_INTERNAL_URL ?? "http://localhost:4000").replace(
  /\/$/,
  ""
);

const nextConfig = {
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
      }
    ];
  }
};

export default nextConfig;
