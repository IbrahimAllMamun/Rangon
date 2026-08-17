import type { NextConfig } from "next";

const apiHost = (() => {
  try {
    return new URL(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000/api/v1").hostname;
  } catch {
    return "localhost";
  }
})();

const config: NextConfig = {
  // Small runtime image for the production container (see Dockerfile).
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    remotePatterns: [
      { protocol: "http", hostname: apiHost, port: "8000", pathname: "/media/**" },
      { protocol: "http", hostname: "localhost", port: "9000", pathname: "/**" }, // MinIO in dev
      { protocol: "https", hostname: "**", pathname: "/**" },
    ],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
