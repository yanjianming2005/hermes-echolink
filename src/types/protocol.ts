export type ChatType = "dm" | "group";
export type SenderType = "user" | "bot";
export type MessageType = "text";
export type GatewayEventType = "message.created" | "message.draft";

export interface ChatRef {
  id: string;
  type: ChatType;
}

export interface SenderRef {
  id: string;
  type: SenderType;
  name?: string;
}

export interface TextMessage {
  id: string;
  type: MessageType;
  text: string;
  mentions: string[];
  reply_to?: string;
}

export interface MessageCreatedEvent {
  event_id: string;
  type: "message.created";
  chat: ChatRef;
  sender: SenderRef;
  message: TextMessage;
  timestamp: number;
}

export interface MessageDraftEvent {
  event_id: string;
  type: "message.draft";
  chat: ChatRef;
  sender: SenderRef;
  draft: {
    id: string;
    type: MessageType;
    text: string;
    final: boolean;
    thinking?: string;
  };
  timestamp: number;
}

export type GatewayEvent = MessageCreatedEvent | MessageDraftEvent;

export interface StoredMessage {
  id: string;
  chat_id: string;
  chat_type: ChatType;
  sender: SenderRef;
  type: MessageType;
  text: string;
  mentions: string[];
  reply_to?: string;
  created_at: number;
}
