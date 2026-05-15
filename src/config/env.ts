import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("127.0.0.1"),
  ECHOLINK_TOKEN: z
    .string()
    .min(1)
    .default("dev-token")
    .refine(
      (token) => {
        if (process.env.NODE_ENV === "production" && token === "dev-token") {
          throw new Error('ECHOLINK_TOKEN must not be "dev-token" in production');
        }
        if (process.env.NODE_ENV === "production" && token.length < 32) {
          throw new Error("ECHOLINK_TOKEN must be at least 32 characters in production");
        }
        return true;
      },
      { message: "Invalid ECHOLINK_TOKEN for production environment" },
    ),
  ALLOWED_ORIGINS: z.string().optional(),
  HERMES_BOT_ID: z.string().min(1).default("hermes"),
  HERMES_BOT_NAME: z.string().min(1).default("Hermes"),
  HERMES_API_ENABLED: z
    .string()
    .default("false")
    .transform((value) => ["1", "true", "yes", "on"].includes(value.toLowerCase())),
  HERMES_API_BASE_URL: z.string().url().default("http://127.0.0.1:8642"),
  HERMES_API_KEY: z.string().default("hermes-echolink-dev-key"),
  HERMES_API_MODEL: z.string().min(1).default("hermes-agent"),
});

export const env = envSchema.parse(process.env);
