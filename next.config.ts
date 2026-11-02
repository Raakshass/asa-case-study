import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native module; must not be bundled by webpack.
  serverExternalPackages: ["better-sqlite3"],
};

export default nextConfig;
