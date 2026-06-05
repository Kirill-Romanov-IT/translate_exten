// Service worker: перевод субтитров через OpenRouter API
const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

const SYSTEM_PROMPT =
  "You are a real-time subtitle translator. Translate the following English text to Russian. " +
  "Output ONLY the translation, nothing else. Keep it natural and concise. " +
  "If the text is already in Russian, output it unchanged.";

async function getConfig() {
  const data = await chrome.storage.local.get(["openRouterKey", "model"]);
  return {
    apiKey: data.openRouterKey || "",
    model: data.model || DEFAULT_MODEL,
  };
}

async function translateText(text) {
  const config = await getConfig();
  if (!config.apiKey) {
    return { error: "API ключ не установлен. Нажмите на иконку расширения." };
  }

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
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        max_tokens: 256,
        temperature: 0.1,
        stream: true,
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    return { error: `OpenRouter ${response.status}: ${err}` };
  }

  // SSE стриминг: собираем ответ по частям
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let translation = "";
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
        if (delta) translation += delta;
      } catch {}
    }
  }

  return { translation: translation.trim() };
}

// Обработка сообщений от content.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "translate") {
    translateText(message.text).then(sendResponse);
    return true;
  }

  if (message.type === "getConfig") {
    getConfig().then(sendResponse);
    return true;
  }
});
