import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "happy-dom",
    root: ".",
    include: ["test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
  },
});
