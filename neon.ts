import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  preview: {
    buckets: {
      "ged-eye-media": { access: "public_read" },
    },
  },
  functions: {
    api: { name: "ged-eye api", source: "api/index.js" },
  },
});
