import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false, // don't advertise the stack
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
        {
          // No script-src here on purpose: Next injects inline bootstrap scripts,
          // so a strict policy needs a per-request nonce from middleware. These
          // four directives block clickjacking, <base> injection, form
          // exfiltration and plugin content with zero breakage.
          // ponytail: add nonce-based script-src via middleware if this ever
          // handles payment or PII beyond an email and phone number.
          key: "Content-Security-Policy",
          value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
        },
      ],
    }];
  },
};

export default nextConfig;
