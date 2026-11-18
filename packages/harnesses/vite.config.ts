import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    env: { ENGRAM_STATS: "off" },
    hookTimeout: 20000,
    testTimeout: 20000,
  },
});
