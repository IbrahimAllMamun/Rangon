import type { NextConfig } from "next";

/**
 * Origin of the Django API as seen from *this container* — `http://api:8000`,
 * not the public one. `API_INTERNAL_URL` points at the versioned root, so the
 * `/api/v1` suffix is dropped.
 */
const apiOrigin = (() => {
  try {
    return new URL(process.env.API_INTERNAL_URL ?? "http://api:8000/api/v1").origin;
  } catch {
    return "http://api:8000";
  }
})();

const config: NextConfig = {
  // Small runtime image for the production container (see Dockerfile).
  output: "standalone",
  reactStrictMode: true,
  poweredByHeader: false,
  images: {
    formats: ["image/avif", "image/webp"],
    // Uploaded media arrives from the API as a root-relative path
    // (`/media/products/...`, see apps/api/core/media.py), which `next/image`
    // treats as local and needs no pattern for. These cover the object-storage
    // configurations, where the storage backend returns an absolute URL.
    remotePatterns: [
      { protocol: "http", hostname: "localhost", port: "9000", pathname: "/**" }, // MinIO in dev
      { protocol: "https", hostname: "**", pathname: "/**" },
    ],
  },

  /**
   * `/media/*` is Django's, not ours.
   *
   * The API deliberately returns origin-relative media URLs, so the browser
   * asks *this* server for the bytes. Without this rewrite it would 404, and so
   * would the image optimizer: given a relative `src` it re-enters the app's
   * own router to fetch the file, which is why a rewrite is enough and a
   * remote pattern is not.
   *
   * Nginx also routes /media/ straight to the API in front of this, so in a
   * deployed stack the browser never reaches this rewrite — but `next dev`,
   * `next start` without a proxy, and the optimizer all do.
   */
  async rewrites() {
    return [{ source: "/media/:path*", destination: `${apiOrigin}/media/:path*` }];
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
