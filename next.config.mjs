// @ts-check

/** Baseline response headers on every route. The PDF frame is same-origin, hence SAMEORIGIN. */
const baselineHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/**
 * Content-Security-Policy for the pages (review round B7), production builds only (`next dev` needs eval).
 * 'unsafe-inline' for scripts: Next 15 inlines its bootstrap; a nonce via middleware is the stricter upgrade.
 * Not sent on /api/files/*: a CSP on the PDF response itself can stop Chrome's built-in viewer.
 */
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

/** @type {import("next").NextConfig} */
const nextConfig = {
  // Native module; must not be bundled by webpack.
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  // The app uses no next/image; the optimizer only logged EACCES in the read-only runtime (review round B7).
  images: { unoptimized: true },
  async headers() {
    const rules = [{ source: "/:path*", headers: baselineHeaders }];
    if (process.env.NODE_ENV === "production") {
      rules.push({ source: "/((?!api/files/).*)", headers: [{ key: "Content-Security-Policy", value: csp }] });
    }
    return rules;
  },
};

export default nextConfig;
