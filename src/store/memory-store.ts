import { nanoid } from "nanoid";
import { LIMITS, TTL } from "../constants.js";
import { logger } from "../logger.js";
import type { ChatType, MessageCreatedEvent, SenderRef, StoredMessage } from "../types/protocol.js";

export class MemoryStore {
  private readonly messages = new Map<string, StoredMessage[]>();
  private readonly events = new Map<string, MessageCreatedEvent>();
  private cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, TTL.CLEANUP_INTERVAL_MS);

    this.cleanupInterval.unref();
  }

  createTextMessage(input: {
    chatId: string;
    chatType?: ChatType;
    sender: SenderRef;
    text: string;
    mentions?: string[];
    replyTo?: string;
  }): { message: StoredMessage; event: MessageCreatedEvent } {
    const now = Date.now();
    const message: StoredMessage = {
      id: `msg_${nanoid(12)}`,
      chat_id: input.chatId,
      chat_type: input.chatType ?? "dm",
      sender: input.sender,
      type: "text",
      text: input.text,
      mentions: input.mentions ?? [],
      reply_to: input.replyTo,
      created_at: now,
    };

    const event: MessageCreatedEvent = {
      event_id: `evt_${nanoid(12)}`,
      type: "message.created",
      chat: { id: message.chat_id, type: message.chat_type },
      sender: message.sender,
      message: {
        id: message.id,
        type: message.type,
        text: message.text,
        mentions: message.mentions,
        reply_to: message.reply_to,
      },
      timestamp: now,
    };

    const chatMessages = this.messages.get(message.chat_id) ?? [];
    chatMessages.push(message);

    if (chatMessages.length > LIMITS.MAX_MESSAGES_PER_CHAT) {
      const removed = chatMessages.shift();
      logger.debug({ chatId: message.chat_id, removedMessageId: removed?.id }, "Removed oldest message due to limit");
    }

    this.messages.set(message.chat_id, chatMessages);

    if (this.events.size >= LIMITS.MAX_EVENTS) {
      const oldestKey = this.events.keys().next().value;
      if (oldestKey) {
        this.events.delete(oldestKey);
        logger.debug({ eventId: oldestKey }, "Removed oldest event due to limit");
      }
    }

    this.events.set(event.event_id, event);

    return { message, event };
  }

  listMessages(chatId: string): StoredMessage[] {
    return this.messages.get(chatId) ?? [];
  }

  listEvents(): MessageCreatedEvent[] {
    return [...this.events.values()];
  }

  /**
   * Clean up old messages and events based on TTL
   */
  private cleanup(): void {
    const now = Date.now();
    let removedMessages = 0;
    let removedChats = 0;
    let removedEvents = 0;

    for (const [chatId, messages] of this.messages.entries()) {
      const filtered = messages.filter((msg) => now - msg.created_at < TTL.MESSAGE_TTL_MS);

      if (filtered.length === 0) {
        this.messages.delete(chatId);
        removedChats++;
      } else if (filtered.length < messages.length) {
        this.messages.set(chatId, filtered);
        removedMessages += messages.length - filtered.length;
      }
    }

    for (const [eventId, event] of this.events.entries()) {
      if (now - event.timestamp > TTL.MESSAGE_TTL_MS) {
        this.events.delete(eventId);
        removedEvents++;
      }
    }

    if (removedMessages > 0 || removedChats > 0 || removedEvents > 0) {
      logger.info(
        {
          removedMessages,
          removedChats,
          removedEvents,
          remainingChats: this.messages.size,
          remainingEvents: this.events.size,
        },
        "Cleanup completed",
      );
    }
  }

  /**
   * Stop the cleanup interval (for graceful shutdown)
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}
