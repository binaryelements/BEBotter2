// Bundles the workflow canvas into the admin assets (the Dockerfile copies only src, so the bundle is committed).
// The console's CSP allows only same-origin scripts and styles, so everything is bundled.
import { copyFile } from "node:fs/promises";
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.jsx"],
  outfile: "../src/admin/assets/workflows/canvas.js",
  bundle: true,
  format: "iife",
  minify: true,
  jsx: "automatic",
  target: "es2020",
  define: { "process.env.NODE_ENV": '"production"' },
  legalComments: "linked",
  logLevel: "info",
});

// elkjs (the tidy layout, 1.6 MB) is its own file, fetched only when someone first presses tidy
await copyFile("node_modules/elkjs/lib/elk.bundled.js", "../src/admin/assets/workflows/elk.js");
await copyFile("node_modules/elkjs/LICENSE.md", "../src/admin/assets/workflows/elk.js.LEGAL.txt");
