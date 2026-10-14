import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Everything here is live operational data read per request; nothing is
  // worth caching, so the component cache stays off.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
