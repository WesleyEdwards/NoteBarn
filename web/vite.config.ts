import {defineConfig} from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 8917,
    proxy: {
      "/api": {
        target: "http://0.0.0.0:8085",
        rewrite: (path) => path.replace(/^\/api/, ""),
        ws: true
      }
    }
  },
  // `npm run preview` serves a built app; proxy the API the same way for testing it locally.
  preview: {
    port: 8918,
    proxy: {
      "/api": {
        target: "http://0.0.0.0:8085",
        rewrite: (path) => path.replace(/^\/api/, ""),
        ws: true
      }
    }
  },
  test: {
    environment: "node"
  }
})
