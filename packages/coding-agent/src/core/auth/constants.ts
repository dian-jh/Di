/** Shared host-side ChatGPT auth constants. `ChatGptAuth` @. */
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const CHATGPT_DIRECT_SCOPE = "chatgpt.tokens.use.direct";
export const CHATGPT_AUTHORIZE_URL = "https://auth.openai.com/api/accounts/authorize";
export const CHATGPT_TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_DISCOVERY_URL = "https://auth.openai.com/.well-known/openid-configuration";
export const CHATGPT_SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const CHATGPT_DYNAMIC_CLIENT_ID = "dynamic_agent_client";
export const CHATGPT_AGENT_NAME_HINT = "Di";
