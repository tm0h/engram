import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts"],
    dts: false,
    format: "esm",
    platform: "node",
    fixedExtension: false,
    deps: { alwaysBundle: ["@engram/core"] },
  },
});
