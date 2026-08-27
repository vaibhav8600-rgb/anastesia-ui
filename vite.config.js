import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// singlefile keeps the app's original selling point: one self-contained
// offline HTML file you can save with Ctrl+S.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: { target: "esnext" },
});
