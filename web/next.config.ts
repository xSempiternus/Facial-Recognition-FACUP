import type { NextConfig } from "next";

// La API de reconocimiento (FastAPI + DeepFace) corre aparte; el navegador la llama vía /api/* en el mismo
// origen, así no hace falta CORS ni exponer el puerto 8000.
const API_URL = process.env.API_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Permissions-Policy", value: "camera=(self)" }],
      },
    ];
  },
  rewrites() {
    return [{ source: "/api/:path*", destination: `${API_URL}/:path*` }];
  },
};

export default nextConfig;
