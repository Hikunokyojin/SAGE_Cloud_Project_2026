import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two builds of the same dashboard:
//  - default: relative asset paths ("./"), which work on GitHub Pages under any sub-path.
//  - "api" mode: absolute paths under the API Gateway stage ("/prod/"), used for the copy that
//    the Conductor serves. Absolute paths keep the page working whether or not the address
//    is typed with a trailing slash (".../prod" and ".../prod/"); relative paths break
//    without it, because the browser then looks for the assets at the domain root.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "api" ? "/prod/" : "./",
}));
