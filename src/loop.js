import { buildSystemPrompt } from "./prompt.js";
import { toolDefinitions, executeTool } from "./tools.js";

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

const FALLBACK_REPLY = "Just go Berseh Food Centre lah.";

/**
 * Run the agentic loop for one user turn and return Uncle's reply.
 *
 * history is the prior conversation as OpenAI-style {role, content} messages.
 */
export async function runLoop(history, message, env) {
  // If the Places key is missing, Uncle cannot search, so give a safe answer.
  if (!env.GOOGLE_PLACES_API_KEY) {
    return FALLBACK_REPLY;
  }

  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history,
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
      const result = await executeTool(call.function.name, args, env);
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
        if (!err.retryable) throw err;
        lastError = err;
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

function parseArgs(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}
