import type { RawData, WebSocket } from "ws";
import { LIMITS, TIMEOUTS } from "../constants.js";
import { logger } from "../logger.js";
import type { GatewayEvent } from "../types/protocol.js";

interface ClientMetadata {
  isAlive: boolean;
  connectedAt: number;
}

/**
 * Manages WebSocket gateway connections and broadcasts events to all connected clients.
 * Implements connection limits, heartbeat checks, and automatic cleanup of stale connections.
 */
export class GatewayHub {
  private readonly clients = new Map<WebSocket, ClientMetadata>();
  private heartbeatInterval: NodeJS.Timeout;

  constructor() {
    // Periodic heartbeat check
    this.heartbeatInterval = setInterval(() => {
      this.checkConnections();
    }, TIMEOUTS.HEARTBEAT_INTERVAL_MS);

    this.heartbeatInterval.unref();
  }

  /**
   * Adds a new WebSocket client to the gateway hub.
   * Enforces connection limits and sets up event listeners.
   *
   * @param socket - The WebSocket connection to add
   */
  addClient(socket: WebSocket): void {
    if (this.clients.size >= LIMITS.MAX_GATEWAY_CLIENTS) {
      logger.warn({ current: this.clients.size, max: LIMITS.MAX_GATEWAY_CLIENTS }, "Max client limit reached");
      socket.close(1008, "Server at capacity");
      return;
    }

    const metadata: ClientMetadata = {
      isAlive: true,
      connectedAt: Date.now(),
    };

    this.clients.set(socket, metadata);
    logger.info({ gateway_clients: this.clients.size }, "Gateway websocket client connected");

    socket.on("pong", () => {
      const meta = this.clients.get(socket);
      if (meta) {
        meta.isAlive = true;
      }
    });

    socket.on("close", (code, reason) => {
      this.clients.delete(socket);
      logger.info(
        { code, reason: reason.toString(), gateway_clients: this.clients.size },
        "Gateway websocket client disconnected",
      );
    });

    socket.on("error", (error) => {
      this.clients.delete(socket);
      logger.warn({ error, gateway_clients: this.clients.size }, "Gateway websocket client error");
    });

    socket.on("message", (raw) => this.handleClientMessage(socket, raw));
  }

  /**
   * Broadcasts a gateway event to all connected clients.
   * Automatically cleans up stale connections during broadcast.
   *
   * @param event - The event to broadcast to all clients
   */
  broadcast(event: GatewayEvent): void {
    const payload = JSON.stringify(event);
    const staleConnections: WebSocket[] = [];

    for (const [client] of this.clients) {
      if (client.readyState === client.OPEN) {
        try {
          client.send(payload);
        } catch (error) {
          logger.warn({ error }, "Failed to send broadcast to client");
          staleConnections.push(client);
        }
      } else if (client.readyState === client.CLOSED || client.readyState === client.CLOSING) {
        staleConnections.push(client);
      }
    }

    for (const client of staleConnections) {
      this.clients.delete(client);
    }

    if (staleConnections.length > 0) {
      logger.debug(
        { removed: staleConnections.length, remaining: this.clients.size },
        "Cleaned up stale connections",
      );
    }
  }

  /**
   * Returns the number of connected clients.
   */
  size(): number {
    return this.clients.size;
  }

  /**
   * Closes all client connections gracefully.
   * Used during server shutdown.
   */
  async closeAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];

    for (const [client] of this.clients) {
      closePromises.push(
        new Promise<void>((resolve) => {
          if (client.readyState === client.OPEN) {
            client.close(1001, "Server shutting down");
            client.once("close", () => resolve());
          } else {
            resolve();
          }
        }),
      );
    }

    await Promise.race([
      Promise.all(closePromises),
      new Promise<void>((resolve) => setTimeout(resolve, TIMEOUTS.GRACEFUL_SHUTDOWN_MS)),
    ]);

    this.clients.clear();
    logger.info("All gateway clients closed");
  }

  /**
   * Stops the heartbeat interval (for graceful shutdown).
   */
  destroy(): void {
    clearInterval(this.heartbeatInterval);
  }

  /**
   * Handles incoming messages from WebSocket clients.
   * Enforces message size limits.
   */
  private handleClientMessage(socket: WebSocket, raw: RawData): void {
    let size: number;
    if (Buffer.isBuffer(raw)) {
      size = raw.length;
    } else if (Array.isArray(raw)) {
      size = raw.reduce((acc, buf) => acc + buf.length, 0);
    } else if (ArrayBuffer.isView(raw)) {
      size = raw.byteLength;
    } else {
      size = raw.byteLength;
    }

    if (size > LIMITS.MAX_WEBSOCKET_MESSAGE_SIZE) {
      logger.warn({ size, max: LIMITS.MAX_WEBSOCKET_MESSAGE_SIZE }, "Message exceeds size limit");
      socket.close(1009, "Message too large");
      return;
    }

    const text = raw.toString();

    if (text === "ping") {
      socket.send("pong");
      return;
    }

    socket.send(JSON.stringify({ type: "ack", received_at: Date.now() }));
  }

  /**
   * Periodic heartbeat check to detect and remove unresponsive clients.
   */
  private checkConnections(): void {
    const terminatedClients: WebSocket[] = [];

    for (const [client, metadata] of this.clients) {
      if (!metadata.isAlive) {
        logger.warn("Terminating unresponsive client");
        client.terminate();
        terminatedClients.push(client);
        continue;
      }

      metadata.isAlive = false;
      try {
        client.ping();
      } catch (error) {
        logger.warn({ error }, "Failed to send ping to client");
        terminatedClients.push(client);
      }
    }

    for (const client of terminatedClients) {
      this.clients.delete(client);
    }

    if (terminatedClients.length > 0) {
      logger.info(
        { terminated: terminatedClients.length, remaining: this.clients.size },
        "Removed unresponsive clients",
      );
    }
  }
}
