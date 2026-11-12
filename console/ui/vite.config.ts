import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Served by console/server under /admin/console; the stylesheets come from the engine's admin (src/admin/assets) so both look the same.
export default defineConfig({
  base: "/admin/console/",
  plugins: [react()],
  server: { fs: { allow: ["../.."] }, proxy: { "/admin/console/api": "http://localhost:3979" } },
});
