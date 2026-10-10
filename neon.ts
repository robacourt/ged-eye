import { defineConfig } from "@neon/config/v1";

// The api Function's mail credentials (api/mailer.js), passed only when both are set, so a deploy
// without them sends no `env` and leaves any deployed values alone. They come from their own file
// (`neon deploy --env .env.mail.local`), never .env.local: a dev branch copies the real admin list.
const { SMTP_USER, SMTP_PASS } = process.env;
if (Boolean(SMTP_USER) !== Boolean(SMTP_PASS)) {
  console.warn("neon.ts: only one of SMTP_USER and SMTP_PASS is set, so the api Function gets neither");
}
const mailEnv = SMTP_USER && SMTP_PASS ? { env: { SMTP_USER, SMTP_PASS } } : {};

export default defineConfig({
  auth: true,
  preview: {
    buckets: {
      "ged-eye-media": { access: "public_read" },
    },
  },
  functions: {
    api: { name: "ged-eye api", source: "api/index.js", ...mailEnv },
    media: { name: "ged-eye media", source: "media/index.js", externalPackages: ["sharp"] },
  },
  triggers: {
    // Hourly: deletes incoming/ uploads more than an hour old (media/handler.js, POST /sweep).
    "sweep-incoming": { type: "schedule", function: "media", cron: "17 * * * *", functionPath: "/sweep" },
  },
});
