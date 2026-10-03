import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Relative asset paths: in production the dashboard is served by Conductor behind
  // API Gateway's /prod/ stage prefix, so absolute /assets/... URLs would 403.
  base: "./",
});
