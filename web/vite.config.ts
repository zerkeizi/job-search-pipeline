import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `pnpm jobpipe review` builds this into web/dist and serves it with the API.
// For UI work: run `pnpm jobpipe review` (API on :4321) and `pnpm vite web` (proxy below).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { proxy: { "/api": "http://127.0.0.1:4321" } },
});
