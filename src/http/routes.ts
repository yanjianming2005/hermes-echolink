import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env } from "../config/env.js";
import { LIMITS, RATE_LIMIT } from "../constants.js";
import type { GatewayHub } from "../gateway/gateway-hub.js";
import type { HermesApiClient } from "../hermes/hermes-api-client.js";
import { logger } from "../logger.js";
import type { MemoryStore } from "../store/memory-store.js";
import type { MessageDraftEvent } from "../types/protocol.js";
import { requireBearerToken } from "./auth.js";

const chatIdSchema = z.string().min(1).max(LIMITS.MAX_CHAT_ID_LENGTH).regex(/^[a-zA-Z0-9_-]+$/);

const userMessageSchema = z.object({
  sender_id: z
    .string()
    .min(1)
    .max(LIMITS.MAX_SENDER_ID_LENGTH)
    .default("user_demo")
    .transform((text) => text.trim()),
  sender_name: z
    .string()
    .min(1)
    .max(LIMITS.MAX_SENDER_NAME_LENGTH)
    .optional()
    .transform((text) => text?.trim()),
  text: z
    .string()
    .max(LIMITS.MAX_MESSAGE_LENGTH)
    .transform((text) => text.replace(/<[^>]*>/g, "").trim())
    .pipe(z.string().min(1)),
  chat_type: z.enum(["dm", "group"]).default("dm"),
  mentions: z.array(z.string().min(1)).optional(),
  reply_to: z.string().min(1).optional(),
});

const hermesMessageSchema = z.object({
  chat_id: chatIdSchema,
  sender_id: z.string().min(1).max(LIMITS.MAX_SENDER_ID_LENGTH).default(env.HERMES_BOT_ID),
  sender_name: z.string().min(1).max(LIMITS.MAX_SENDER_NAME_LENGTH).default("Hermes"),
  text: z
    .string()
    .max(LIMITS.MAX_MESSAGE_LENGTH)
    .transform((text) => text.trim())
    .pipe(z.string().min(1)),
  reply_to: z.string().min(1).optional(),
});

const draftMessageSchema = z.object({
  chat_id: chatIdSchema,
  draft_id: z.union([z.string(), z.number()]).transform((value) => String(value)),
  sender_id: z.string().min(1).max(LIMITS.MAX_SENDER_ID_LENGTH).default(env.HERMES_BOT_ID),
  sender_name: z.string().min(1).max(LIMITS.MAX_SENDER_NAME_LENGTH).default(env.HERMES_BOT_NAME),
  text: z
    .string()
    .max(LIMITS.MAX_MESSAGE_LENGTH)
    .transform((text) => text.trim()),
  final: z.boolean().default(false),
  thinking: z.string().optional(),
});

const apiLimiter = rateLimit({
  windowMs: RATE_LIMIT.WINDOW_MS,
  max: RATE_LIMIT.MAX_REQUESTS,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error: {
        code: "rate_limit_exceeded",
        message: "Too many requests, please try again later",
      },
    });
  },
});

export function createRoutes(store: MemoryStore, gateway: GatewayHub, hermesApi: HermesApiClient): Router {
  const router = Router();

  router.get("/health", (_req, res) => {
    res.json({ ok: true, gateway_clients: gateway.size() });
  });

  router.get("/v1/events", (_req, res) => {
    res.json({ events: store.listEvents() });
  });

  router.get("/v1/chats/:chatId/messages", (req, res) => {
    const chatIdValidation = chatIdSchema.safeParse(req.params.chatId);
    if (!chatIdValidation.success) {
      res.status(400).json({
        error: {
          code: "invalid_chat_id",
          message: "Chat ID must be alphanumeric with dashes or underscores",
        },
      });
      return;
    }

    res.json({ messages: store.listMessages(chatIdValidation.data) });
  });

  router.post("/v1/chats/:chatId/messages", apiLimiter, (req, res) => {
    const chatIdValidation = chatIdSchema.safeParse(req.params.chatId);
    if (!chatIdValidation.success) {
      res.status(400).json({
        error: {
          code: "invalid_chat_id",
          message: "Chat ID must be alphanumeric with dashes or underscores",
        },
      });
      return;
    }

    const parsed = userMessageSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "invalid_request",
          message: "Invalid request body",
          details: parsed.error.flatten(),
        },
      });
      return;
    }

    const mentions = parsed.data.mentions ?? extractMentions(parsed.data.text);
    const result = store.createTextMessage({
      chatId: chatIdValidation.data,
      chatType: parsed.data.chat_type,
      sender: {
        id: parsed.data.sender_id,
        type: "user",
        name: parsed.data.sender_name,
      },
      text: parsed.data.text,
      mentions,
      replyTo: parsed.data.reply_to,
    });

    gateway.broadcast(result.event);

    askHermesFromUserMessage({
      chatId: chatIdValidation.data,
      text: parsed.data.text,
      replyTo: result.message.id,
      store,
      gateway,
      hermesApi,
    }).catch((error) => {
      logger.error({ error, chatId: chatIdValidation.data }, "Unhandled error in askHermesFromUserMessage");
    });

    res.status(201).json(result);
  });

  router.post("/v1/messages", requireBearerToken, apiLimiter, (req, res) => {
    const parsed = hermesMessageSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "invalid_request",
          message: "Invalid request body",
          details: parsed.error.flatten(),
        },
      });
      return;
    }

    const result = store.createTextMessage({
      chatId: parsed.data.chat_id,
      sender: {
        id: parsed.data.sender_id,
        type: "bot",
        name: parsed.data.sender_name,
      },
      text: parsed.data.text,
      replyTo: parsed.data.reply_to,
    });

    gateway.broadcast(result.event);

    res.status(201).json(result.message);
  });

  router.post("/v1/drafts", requireBearerToken, apiLimiter, (req, res) => {
    const parsed = draftMessageSchema.safeParse(req.body);

    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: "invalid_request",
          message: "Invalid request body",
          details: parsed.error.flatten(),
        },
      });
      return;
    }

    const event: MessageDraftEvent = {
      event_id: `draft_${parsed.data.draft_id}_${Date.now()}`,
      type: "message.draft",
      chat: { id: parsed.data.chat_id, type: "dm" },
      sender: {
        id: parsed.data.sender_id,
        type: "bot",
        name: parsed.data.sender_name,
      },
      draft: {
        id: parsed.data.draft_id,
        type: "text",
        text: parsed.data.text,
        final: parsed.data.final,
        thinking: parsed.data.thinking,
      },
      timestamp: Date.now(),
    };

    gateway.broadcast(event);
    res.status(202).json({ ok: true });
  });

  return router;
}

async function askHermesFromUserMessage(input: {
  chatId: string;
  text: string;
  replyTo: string;
  store: MemoryStore;
  gateway: GatewayHub;
  hermesApi: HermesApiClient;
}): Promise<void> {
  if (!env.HERMES_API_ENABLED) {
    return;
  }

  try {
    const answer = await input.hermesApi.ask({
      sessionId: `echolink:${input.chatId}`,
      text: input.text,
    });

    const result = input.store.createTextMessage({
      chatId: input.chatId,
      sender: {
        id: env.HERMES_BOT_ID,
        type: "bot",
        name: env.HERMES_BOT_NAME,
      },
      text: answer,
      replyTo: input.replyTo,
    });

    input.gateway.broadcast(result.event);
  } catch (error) {
    logger.error({ error, chatId: input.chatId }, "Hermes API request failed");
  }
}

function extractMentions(text: string): string[] {
  return [...text.matchAll(/@([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);
}
