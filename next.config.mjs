// @ts-check

/** Baseline response headers on every route (no CSP yet). The PDF frame is same-origin, hence SAMEORIGIN. */
const baselineHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Native module; must not be bundled by webpack.
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: baselineHeaders }];
  },
};

export default nextConfig;
