import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  auth: true,
  preview: {
    buckets: {
      "ged-eye-media": { access: "public_read" },
    },
  },
  functions: {
    api: { name: "ged-eye api", source: "api/index.js" },
    media: { name: "ged-eye media", source: "media/index.js", externalPackages: ["sharp"] },
  },
});
