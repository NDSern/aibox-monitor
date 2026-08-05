import react from "@vitejs/plugin-react";

export default {
  plugins: [
    react(),
    {
      name: "preview-cache-control",
      configurePreviewServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url === "/" || (req.url && req.url.startsWith("/aibox-data.json"))) {
            res.setHeader("Cache-Control", "no-store, max-age=0");
          }
          next();
        });
      },
    },
  ],
};
