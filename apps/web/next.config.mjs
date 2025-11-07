import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const sharedRuntime = fileURLToPath(new URL("../../packages/shared/dist/index.js", import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: repositoryRoot,
  transpilePackages: ["@pong-pong/shared"],
  webpack(config) {
    config.resolve.alias["@pong-pong/shared"] = sharedRuntime;
    return config;
  }
};

export default nextConfig;
