/**
 * Vite Config
 * ===========
 * Standard Vite config for the frontend workspace package.
 */

import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Keep source imports stable even though the package root is frontend/src.
      "@": path.resolve(__dirname),
    },
  },
  build: {
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          react_vendor: ["react", "react-dom"],
          ckb_vendor: ["@ckb-ccc/core", "@ckb-ccc/connector-react"],
        },
      },
    },
  },
});
