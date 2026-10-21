import { buildSystemPrompt } from "./prompt.js";
import { toolDefinitions, executeTool, CT_HUB_2 } from "./tools.js";

// OpenCode Go, OpenAI-compatible chat completions endpoint.
const LLM_BASE_URL = "https://opencode.ai/inference/go/openai/v1";
const LLM_MODEL = "deepseek-v4.1-flash";
// DeepSeek on OpenCode Go often returns 429 "Endpoint is unavailable",
// so retry it once, then fall back to a model that is reliably up.
const LLM_FALLBACK_MODEL = "glm-5.3-flash";
const ATTEMPTS_PER_MODEL = 2;
const RETRY_DELAY_MS = 500;

const LLM_TIMEOUT_MS = 20_000;
const MAX_ROUNDS = 8;
const MAX_HISTORY_MESSAGES = 20;

const FALLBACK_REPLY = "Just go Berseh Food Centre lah.";

/**
 * Run the agentic loop for one user turn and return Uncle's reply.
 *
 * history is the prior conversation as OpenAI-style {role, content} messages.
 * location is the browser's {latitude, longitude}, or anything else if the
 * user did not share it, in which case Uncle assumes CT Hub 2.
 */
export async function runLoop(history, message, env, location) {
  // If the Places key is missing, Uncle cannot search, so give a safe answer.
  if (!env.GOOGLE_PLACES_API_KEY) {
    return FALLBACK_REPLY;
  }

  const userLocation = parseLocation(location);
  const origin = userLocation ?? CT_HUB_2;

  const messages = [
    { role: "system", content: buildSystemPrompt(new Date(), userLocation) },
    ...cleanHistory(history),
    { role: "user", content: message },
  ];

  // One session id per turn, shared by every model call in this loop run,
  // so the OpenCode Go endpoint can route and cache consistently.
  const sessionId = crypto.randomUUID();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const assistant = await callModel(messages, env, sessionId);
    messages.push(assistant);

    const toolCalls = assistant.tool_calls ?? [];
    if (toolCalls.length === 0) {
      return assistant.content ?? "";
    }

    for (const call of toolCalls) {
      const args = parseArgs(call.function.arguments);
      console.log(`round ${round}: ${call.function.name}`, args);
      const result = await executeTool(call.function.name, args, env, origin);
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  return "Uncle tried too many times already. Ask something simpler.";
}

async function callModel(messages, env, sessionId) {
  let lastError;
  for (const model of [LLM_MODEL, LLM_FALLBACK_MODEL]) {
    for (let attempt = 0; attempt < ATTEMPTS_PER_MODEL; attempt++) {
      if (lastError) {
        console.warn(`retrying with ${model}: ${lastError.message}`);
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
      try {
        return await requestCompletion(model, messages, env, sessionId);
      } catch (err) {
        // A timeout already cost LLM_TIMEOUT_MS, so skip straight to the
        // next model instead of waiting on this one again.
        const timedOut = err.name === "TimeoutError";
        if (!err.retryable && !timedOut) throw err;
        lastError = err;
        if (timedOut) break;
      }
    }
  }
  throw lastError;
}

async function requestCompletion(model, messages, env, sessionId) {
  const res = await fetch(`${LLM_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.OPENCODE_API_KEY}`,
      "x-opencode-session": sessionId,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: toolDefinitions,
    }),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    const err = new Error(`${model} returned ${res.status}: ${await res.text()}`);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const data = await res.json();
  return data.choices[0].message;
}

/**
 * Keep only recent user/assistant text turns from client-supplied history,
 * so a caller cannot inject system or tool messages or send a huge payload.
 */
export function cleanHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (m) =>
        (m?.role === "user" || m?.role === "assistant") &&
        typeof m.content === "string",
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(({ role, content }) => ({ role, content }));
}

/**
 * Return {latitude, longitude} if the client sent a valid position, else null.
 */
export function parseLocation(location) {
  const { latitude, longitude } = location ?? {};
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }
  return { latitude, longitude };
}

function parseArgs(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
