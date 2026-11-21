// Bundles the workflow canvas into the admin assets (the Dockerfile copies only src, so the bundle is committed).
// The console's CSP allows only same-origin scripts and styles, so everything is bundled.
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
