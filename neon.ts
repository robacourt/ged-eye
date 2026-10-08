import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  preview: {
    buckets: {
      "ged-eye-media": { access: "public_read" },
    },
  },
});
