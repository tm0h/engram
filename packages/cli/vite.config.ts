import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/pi-extension.ts", "src/opencode-plugin.ts"],
    dts: false,
    format: "esm",
    platform: "node",
    fixedExtension: false,
    deps: { alwaysBundle: ["@engram/core", "@engram/harnesses"] },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    hookTimeout: 120000,
    testTimeout: 120000,
  },
});
