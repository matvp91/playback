import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import relativeCiAgent from "@relative-ci/rollup-plugin";
import { transformFile } from "@swc/core";
import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: {
      main: "lib/index.ts",
    },
    format: "module",
    platform: "browser",
    deps: {
      alwaysBundle: ["txml"],
      onlyBundle: ["txml"],
    },
    // TODO(matvp): Create priority in dev, we currently
    // do not clean due to demo relying on dist.
    clean: false,
    plugins: [relativeCiAgent()],
    // Do not hash chunks, they mess with bundle analyzer.
    hash: false,
    onSuccess(config) {
      if (!config.watch) {
        // On full build, create API markdown files.
        execSync(
          "api-extractor run --local --config api-generator/config.json",
        );
        execSync(
          "api-documenter markdown -i api-generator/__generated__ -o api-generator/__generated__/markdown",
        );
      }
    },
  },
  {
    entry: {
      main: "lib/index.ts",
    },
    globalName: "cmafLite",
    format: "iife",
    platform: "browser",
    deps: {
      alwaysBundle: () => true,
      onlyBundle: false,
    },
    // TODO(matvp): Create priority in dev, we currently
    // do not clean due to demo relying on dist.
    clean: false,
    plugins: [relativeCiAgent()],
    async onSuccess(config) {
      if (!config.watch) {
        const result = await transformFile("dist/main.iife.js", {
          jsc: {
            target: "es5",
            loose: true,
            parser: {
              syntax: "ecmascript",
            },
          },
          minify: true,
        });
        await writeFile("dist/main.iife.es5.js", result.code);
      }
    },
  },
]);
