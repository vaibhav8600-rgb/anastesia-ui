import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// singlefile keeps the original selling point: one self-contained offline
// HTML file you can save with Ctrl+S and use with no network.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { target: "esnext" },
});
