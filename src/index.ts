import cors from "cors";
import express from "express";
import helmet from "helmet";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pinoHttp } from "pino-http";
import { WebSocketServer } from "ws";
import { env } from "./config/env.js";
import { GatewayHub } from "./gateway/gateway-hub.js";
import { HermesApiClient } from "./hermes/hermes-api-client.js";
import { createRoutes } from "./http/routes.js";
import { logger } from "./logger.js";
import { MemoryStore } from "./store/memory-store.js";

process.on("uncaughtException", (error) => {
  logger.fatal({ error }, "Uncaught exception - shutting down");
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.fatal({ reason, promise }, "Unhandled promise rejection - shutting down");
  process.exit(1);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
const gateway = new GatewayHub();
const store = new MemoryStore();
const hermesApi = new HermesApiClient();

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", "ws:", "wss:"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'", "data:"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
  }),
);

const allowedOrigins = env.ALLOWED_ORIGINS?.split(",") || ["http://localhost:8787"];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn({ origin, allowedOrigins }, "CORS origin rejected");
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    maxAge: 86400,
  }),
);

app.use(express.json({ limit: "1mb" }));
app.use(pinoHttp({ logger }));
app.use(express.static(path.join(__dirname, "../public")));

app.use(createRoutes(store, gateway, hermesApi));

const webSocketServer = new WebSocketServer({
  noServer: true,
});

webSocketServer.on("connection", (socket) => {
  gateway.addClient(socket);
  socket.send(JSON.stringify({ type: "hello", connected_at: Date.now() }));
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);

  if (url.pathname !== "/v1/gateway/connect") {
    logger.warn({ path: url.pathname }, "Rejected websocket upgrade with unsupported path");
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const authHeader = request.headers["authorization"];
  const tokenFromHeader = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const tokenFromQuery = url.searchParams.get("token");
  const token = tokenFromHeader ?? tokenFromQuery;

  if (token !== env.ECHOLINK_TOKEN) {
    logger.warn({ path: url.pathname }, "Rejected websocket upgrade with invalid token");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  logger.info({ path: url.pathname }, "Accepted websocket upgrade");
  webSocketServer.handleUpgrade(request, socket, head, (ws) => {
    webSocketServer.emit("connection", ws, request);
  });
});

server.listen(env.PORT, env.HOST, () => {
  logger.info({ host: env.HOST, port: env.PORT }, "Hermes EchoLink server started");
});

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Received shutdown signal, starting graceful shutdown");

  server.close((err) => {
    if (err) {
      logger.error({ error: err }, "Error closing HTTP server");
    } else {
      logger.info("HTTP server closed");
    }
  });

  try {
    await gateway.closeAll();
  } catch (error) {
    logger.error({ error }, "Error closing gateway connections");
  }

  try {
    gateway.destroy();
    store.destroy();
  } catch (error) {
    logger.error({ error }, "Error destroying resources");
  }

  logger.info("Graceful shutdown completed");
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
