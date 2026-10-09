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
  triggers: {
    // Hourly: deletes incoming/ uploads more than an hour old (media/handler.js, POST /sweep).
    "sweep-incoming": { type: "schedule", function: "media", cron: "17 * * * *", functionPath: "/sweep" },
  },
});
