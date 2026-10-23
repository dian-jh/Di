/*
 * ChatGPT Responses provider adapter public surface. Wire DTOs and quirks
 * stay inside this provider module; only the adapter pieces are exported for
 * `@di/ai` consumers.
 */

export {
  chatgptDefaults,
  chatgptErrorCodes,
  createChatGptTranslator,
  toWireRequest,
  serializeRequest,
  mapUsage,
  mapHttpErrorBody,
  ChatGptError,
} from "./translator.ts";

export { ChatGptAdapter } from "./adapter.ts";
export type { ChatGptAdapterOptions } from "./adapter.ts";

export type {
  ChatGptWireRequest,
  ChatGptWireInputItem,
  ChatGptWireReasoning,
  ChatGptWireToolNamespace,
  ChatGptWireTool,
  ChatGptWireUserContentPart,
  ChatGptWireAssistantContentPart,
  ChatGptWireSseEvent,
  ChatGptWireResponse,
  ChatGptWireUsage,
} from "./wire.ts";
