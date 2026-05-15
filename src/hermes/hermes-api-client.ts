import { TIMEOUTS } from "../constants.js";
import { env } from "../config/env.js";
import { logger } from "../logger.js";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

/**
 * Client for interacting with the Hermes API.
 * Implements timeout, error handling, and proper request/response validation.
 */
export class HermesApiClient {
  /**
   * Sends a message to the Hermes API and returns the response.
   *
   * @param input - The session ID and text to send
   * @returns The response text from Hermes
   * @throws Error if the request fails or times out
   */
  async ask(input: { sessionId: string; text: string }): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUTS.HERMES_API_TIMEOUT_MS);

    try {
      const startTime = Date.now();

      const response = await fetch(`${env.HERMES_API_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.HERMES_API_KEY}`,
          "content-type": "application/json",
          "x-hermes-session-id": input.sessionId,
        },
        body: JSON.stringify({
          model: env.HERMES_API_MODEL,
          stream: false,
          messages: [{ role: "user", content: input.text }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const duration = Date.now() - startTime;

      let body: ChatCompletionResponse;
      try {
        body = (await response.json()) as ChatCompletionResponse;
      } catch (parseError) {
        logger.error({ parseError, status: response.status }, "Failed to parse Hermes API response");
        throw new Error(`Failed to parse Hermes API response: ${parseError}`);
      }

      if (!response.ok) {
        const errorMessage = body.error?.message ?? `HTTP ${response.status}`;
        logger.error({ status: response.status, error: body.error, duration }, "Hermes API request failed");
        throw new Error(`Hermes API failed: ${errorMessage}`);
      }

      const content = body.choices?.[0]?.message?.content;
      if (!content) {
        logger.error({ body, duration }, "Hermes API returned empty response");
        throw new Error("Hermes API returned an empty response");
      }

      logger.debug({ sessionId: input.sessionId, duration, contentLength: content.length }, "Hermes API request succeeded");

      return content;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        logger.error({ timeout: TIMEOUTS.HERMES_API_TIMEOUT_MS, sessionId: input.sessionId }, "Hermes API request timeout");
        throw new Error(`Hermes API request timeout after ${TIMEOUTS.HERMES_API_TIMEOUT_MS}ms`);
      }

      if (error instanceof TypeError) {
        logger.error({ error, sessionId: input.sessionId }, "Hermes API network error");
        throw new Error(`Hermes API network error: ${error.message}`);
      }

      throw error;
    }
  }
}
