import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : {
          target: "pino-pretty",
          options: { colorize: true },
        },
  redact: {
    paths: [
      "authorization",
      "token",
      "password",
      "secret",
      "api_key",
      "*.authorization",
      "*.token",
      "*.password",
      "*.secret",
      "*.api_key",
      "req.headers.authorization",
      "req.headers.cookie",
    ],
    remove: true,
  },
});
