// Service worker: перевод и ассистент через OpenRouter API
const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

const TRANSLATE_ONLY_PROMPT =
  "You are a real-time subtitle translator. Translate the following English text to Russian. " +
  "Output ONLY the translation, nothing else. Keep it natural and concise. " +
  "If the text is already in Russian, output it unchanged.";

function buildAssistantPrompt(userContext, callGoal) {
  return (
    "You are a real-time meeting assistant. You receive a fragment of live meeting captions in English.\n\n" +
    "About the user:\n" + (userContext || "Not specified") + "\n\n" +
    "Meeting goal:\n" + (callGoal || "Not specified") + "\n\n" +
    "You will also receive recent conversation history for context.\n\n" +
    "Your task — respond in EXACTLY this format (4 lines, no extra text):\n" +
    "TRANSLATION: <Russian translation of the caption>\n" +
    "SUGGEST_RU: <short suggestion in Russian — what the user could say or ask next, 1-2 sentences>\n" +
    "SUGGEST_EN: <the same suggestion translated to English — ready to say out loud>\n" +
    "WHY: <brief reasoning in Russian — why this response/question is good, 1 sentence>\n\n" +
    "Rules:\n" +
    "- Translation must be natural and concise\n" +
    "- SUGGEST_RU is for the user to understand the idea, SUGGEST_EN is what they actually say in the call\n" +
    "- Suggestion should be strategic, helping the user achieve their meeting goal\n" +
    "- If the caption is just filler/small talk and no suggestion is needed, write SUGGEST_RU: -\n" +
    "- If the text is already in Russian, keep it as-is in TRANSLATION\n" +
    "- WHY is always in Russian"
  );
}

async function getConfig() {
  const data = await chrome.storage.local.get([
    "openRouterKey",
    "model",
    "userContext",
    "callGoal",
  ]);
  return {
    apiKey: data.openRouterKey || "",
    model: data.model || DEFAULT_MODEL,
    userContext: data.userContext || "",
    callGoal: data.callGoal || "",
  };
}

async function callOpenRouter(messages, config) {
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "chrome-extension://meet-captions-translator",
        "X-Title": "Meet Captions Translator",
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: 400,
        temperature: 0.3,
        stream: true,
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    return { error: `OpenRouter ${response.status}: ${err}` };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6).trim();
      if (payload === "[DONE]") break;

      try {
        const parsed = JSON.parse(payload);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) result += delta;
      } catch {}
    }
  }

  return { raw: result.trim() };
}

function parseAssistantResponse(raw) {
  const translation =
    raw.match(/TRANSLATION:\s*(.+)/i)?.[1]?.trim() || raw;
  const suggestRu = raw.match(/SUGGEST_RU:\s*(.+)/i)?.[1]?.trim();
  const suggestEn = raw.match(/SUGGEST_EN:\s*(.+)/i)?.[1]?.trim();
  const whyMatch = raw.match(/WHY:\s*(.+)/i)?.[1]?.trim();

  const suggestionRu =
    suggestRu && suggestRu !== "-" ? suggestRu : null;
  const suggestionEn =
    suggestEn && suggestEn !== "-" ? suggestEn : null;
  const why = whyMatch && whyMatch !== "-" ? whyMatch : null;

  return { translation, suggestionRu, suggestionEn, why };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "translate") {
    (async () => {
      const config = await getConfig();
      if (!config.apiKey) {
        sendResponse({
          error: "API ключ не установлен. Нажмите на иконку расширения.",
        });
        return;
      }

      const hasContext = config.userContext || config.callGoal;
      const systemPrompt = hasContext
        ? buildAssistantPrompt(config.userContext, config.callGoal)
        : TRANSLATE_ONLY_PROMPT;

      const messages = [{ role: "system", content: systemPrompt }];

      if (hasContext && message.history) {
        messages.push({
          role: "user",
          content: "Recent conversation:\n" + message.history,
        });
        messages.push({
          role: "assistant",
          content: "Understood, I have the context. Send me the next caption.",
        });
      }

      messages.push({ role: "user", content: message.text });

      const result = await callOpenRouter(messages, config);

      if (result.error) {
        sendResponse(result);
        return;
      }

      if (hasContext) {
        sendResponse(parseAssistantResponse(result.raw));
      } else {
        sendResponse({ translation: result.raw });
      }
    })();
    return true;
  }

  if (message.type === "getConfig") {
    getConfig().then(sendResponse);
    return true;
  }
});
