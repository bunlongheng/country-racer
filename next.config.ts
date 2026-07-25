import type { NextConfig } from "next";

// Next dev (Turbopack/HMR) evaluates code via eval(); production never does.
// iOS Safari strictly enforces CSP, so the dev bundle needs 'unsafe-eval' to run
// on a phone. Production keeps script-src locked to 'self'.
const isDev = process.env.NODE_ENV !== "production";

// blob: is required for the WebGL worker/texture pipeline three.js uses.
const csp = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "worker-src 'self' blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=()",
  },
];

const nextConfig: NextConfig = {
  devIndicators: false,
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Never cache the HTML document so a new deploy is picked up immediately
      // (the hashed /_next/static assets it points to stay immutably cached).
      {
        source: "/",
        headers: [{ key: "Cache-Control", value: "no-store, must-revalidate" }],
      },
    ];
  },
};

export default nextConfig;
