// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import fs from "node:fs";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// Coordination server (../server). Everything under /api is proxied to it, so phones only
// need to reach this one address.
const API_TARGET = process.env["API_TARGET"] ?? "http://localhost:4000";

// Phones only allow GPS (navigator.geolocation) on HTTPS pages. Drop a key/cert pair in
// frontend/certs/ (see README "HTTPS for rescuer phones") and the dev server switches to HTTPS.
const certs = fs.existsSync("certs/key.pem") && fs.existsSync("certs/cert.pem");

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    server: {
      proxy: { "/api": { target: API_TARGET, changeOrigin: true } },
      ...(certs
        ? { https: { key: fs.readFileSync("certs/key.pem"), cert: fs.readFileSync("certs/cert.pem") } }
        : {}),
    },
  },
});
