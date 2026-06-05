// Перехватчик и переводчик субтитров Google Meet
(function () {
  "use strict";

  console.log("[Meet Captions] Расширение загружено, ожидаю субтитры...");

  // Селекторы на основе реального DOM Google Meet (июнь 2025)
  const CONTAINER_SELECTOR = '[role="region"][aria-label="Captions"]';
  const CONTAINER_FALLBACKS = ['[jscontroller="KPn5nb"]', ".vNKgIf"];
  const ENTRY_SELECTOR = ".nMcdL";
  const SPEAKER_SELECTOR = ".NWpY1d";
  const TEXT_SELECTOR = ".ygicle";

  const POLL_MS = 200;
  const PAUSE_MS = 3000;
  const MAX_ACCUMULATE_MS = 12000;
  const SENTENCE_END_MS = 800;
  const TRANSLATION_DISPLAY_MS = 8000;
  const SUGGEST_DISPLAY_MS = 12000;
  const MAX_HISTORY = 50;
  const HISTORY_SAVE_KEY = "mct_history";

  const activeSpeakers = new Map();
  const translatedTexts = new Set();
  const MAX_TRANSLATED = 50;

  // История разговора для контекста — загружается из storage при старте
  let conversationHistory = [];

  let noSubtitlesWarningShown = false;
  let noSubtitlesTimer = null;
  let debounceTimer = null;

  // === Оверлей ===

  const overlay = document.createElement("div");
  overlay.id = "mct-overlay";
  overlay.innerHTML = `
    <style>
      #mct-overlay {
        position: fixed;
        bottom: 90px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 999999;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        pointer-events: none;
        max-width: 80vw;
      }
      .mct-line {
        background: rgba(0, 0, 0, 0.82);
        color: #fff;
        font-family: "Google Sans", "Segoe UI", sans-serif;
        font-size: 15px;
        line-height: 1.4;
        padding: 6px 16px;
        border-radius: 8px;
        white-space: pre-wrap;
        word-break: break-word;
        text-align: center;
        max-width: 80vw;
        transition: opacity 0.3s;
      }
      .mct-line .mct-speaker { color: #8ab4f8; font-weight: 500; }
      .mct-line .mct-translation { color: #81c995; display: block; margin-top: 2px; }
      .mct-suggest {
        background: rgba(30, 30, 80, 0.92);
        border: 1px solid #bb86fc;
        color: #fff;
        font-family: "Google Sans", "Segoe UI", sans-serif;
        font-size: 14px;
        line-height: 1.4;
        padding: 8px 16px;
        border-radius: 8px;
        max-width: 80vw;
        text-align: left;
        transition: opacity 0.4s;
      }
      .mct-suggest .mct-suggest-label {
        color: #bb86fc;
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        margin-bottom: 4px;
      }
      .mct-suggest .mct-suggest-text { color: #e8eaed; }
      .mct-suggest .mct-suggest-en {
        color: #8ab4f8;
        font-size: 14px;
        margin-top: 4px;
        font-weight: 500;
      }
      .mct-suggest .mct-suggest-why {
        color: #9aa0a6;
        font-size: 12px;
        margin-top: 4px;
        font-style: italic;
      }
    </style>
  `;
  document.body.appendChild(overlay);

  const overlayLines = new Map();
  let suggestEl = null;
  let suggestHideTimer = null;

  function getOverlayLine(speaker) {
    if (overlayLines.has(speaker)) return overlayLines.get(speaker);
    const el = document.createElement("div");
    el.className = "mct-line";
    overlay.insertBefore(el, suggestEl);
    overlayLines.set(speaker, el);
    return el;
  }

  function updateOverlayLine(speaker, text) {
    const el = getOverlayLine(speaker);
    el.innerHTML =
      `<span class="mct-speaker">${esc(speaker || "???")}</span>: ${esc(text)}`;
    el.style.opacity = "1";
    if (el.dataset.hideTimer) clearTimeout(Number(el.dataset.hideTimer));
  }

  function showTranslation(speaker, original, translation) {
    const el = getOverlayLine(speaker);
    el.innerHTML =
      `<span class="mct-speaker">${esc(speaker || "???")}</span>: ${esc(original)}` +
      `<span class="mct-translation">→ ${esc(translation)}</span>`;
    el.style.opacity = "1";
    const timer = setTimeout(() => removeOverlayLine(speaker), TRANSLATION_DISPLAY_MS);
    el.dataset.hideTimer = String(timer);
  }

  function showSuggestion(textRu, textEn, why) {
    if (!suggestEl) {
      suggestEl = document.createElement("div");
      suggestEl.className = "mct-suggest";
      overlay.appendChild(suggestEl);
    }

    let html = `<div class="mct-suggest-label">💡 Подсказка</div>`;
    if (textRu) {
      html += `<div class="mct-suggest-text">${esc(textRu)}</div>`;
    }
    if (textEn) {
      html += `<div class="mct-suggest-en">🇬🇧 ${esc(textEn)}</div>`;
    }
    if (why) {
      html += `<div class="mct-suggest-why">${esc(why)}</div>`;
    }

    suggestEl.innerHTML = html;
    suggestEl.style.opacity = "1";

    if (suggestHideTimer) clearTimeout(suggestHideTimer);
    suggestHideTimer = setTimeout(() => {
      if (suggestEl) suggestEl.style.opacity = "0";
    }, SUGGEST_DISPLAY_MS);
  }

  function removeOverlayLine(speaker) {
    const el = overlayLines.get(speaker);
    if (!el) return;
    el.style.opacity = "0";
    setTimeout(() => {
      el.remove();
      overlayLines.delete(speaker);
    }, 300);
  }

  function esc(s) {
    const d = document.createElement("span");
    d.textContent = s;
    return d.innerHTML;
  }

  // === История разговора (персистентная) ===

  function loadHistory() {
    chrome.storage.local.get([HISTORY_SAVE_KEY], (data) => {
      if (data[HISTORY_SAVE_KEY]) {
        conversationHistory = data[HISTORY_SAVE_KEY];
        console.log(
          `[Meet Captions] Загружена история: ${conversationHistory.length} фраз`
        );
      }
    });
  }

  function saveHistory() {
    chrome.storage.local.set({ [HISTORY_SAVE_KEY]: conversationHistory });
  }

  function addToHistory(speaker, text, translation) {
    conversationHistory.push({
      speaker,
      text,
      translation,
      ts: Date.now(),
    });
    if (conversationHistory.length > MAX_HISTORY) {
      conversationHistory.shift();
    }
    saveHistory();
  }

  function buildHistoryString() {
    if (conversationHistory.length === 0) return "";
    return conversationHistory
      .map((h) => `${h.speaker}: ${h.text}`)
      .join("\n");
  }

  loadHistory();

  // === Логика ===

  function findContainer() {
    let el = document.querySelector(CONTAINER_SELECTOR);
    if (el) return el;
    for (const sel of CONTAINER_FALLBACKS) {
      el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function extractCaptions() {
    const container = findContainer();
    if (!container) return [];

    const entries = container.querySelectorAll(ENTRY_SELECTOR);
    const results = [];

    for (const entry of entries) {
      const speakerEl = entry.querySelector(SPEAKER_SELECTOR);
      const textEl = entry.querySelector(TEXT_SELECTOR);

      const speaker = speakerEl ? speakerEl.textContent.trim() : "";
      const text = textEl ? textEl.textContent.trim() : "";

      if (!text) continue;
      results.push({ speaker, text });
    }

    return results;
  }

  function rememberTranslated(key) {
    translatedTexts.add(key);
    if (translatedTexts.size > MAX_TRANSLATED) {
      const first = translatedTexts.values().next().value;
      translatedTexts.delete(first);
    }
  }

  function endsWithPunctuation(text) {
    return /[.?!…]$/.test(text.trim());
  }

  function requestTranslation(speaker, text) {
    const key = `${speaker}:${text}`;
    if (translatedTexts.has(key)) return;
    rememberTranslated(key);

    const prefix = speaker || "???";
    const history = buildHistoryString();

    chrome.runtime.sendMessage(
      { type: "translate", text, history },
      (response) => {
        if (chrome.runtime.lastError) {
          console.error(
            "[Meet Captions] Ошибка связи с background:",
            chrome.runtime.lastError.message
          );
          return;
        }

        if (response?.error) {
          console.warn(`[Meet Captions] ${response.error}`);
          return;
        }

        if (response?.translation) {
          console.log(
            `[CC] ${prefix}: ${text}\n` +
              `[>>] ${prefix}: ${response.translation}`
          );
          showTranslation(speaker, text, response.translation);
          addToHistory(speaker, text, response.translation);

          if (response.suggestionRu || response.suggestionEn) {
            let logMsg = "";
            if (response.suggestionRu)
              logMsg += `%c[💡 RU] ${response.suggestionRu}\n`;
            if (response.suggestionEn)
              logMsg += `%c[🇬🇧 EN] ${response.suggestionEn}\n`;
            if (response.why)
              logMsg += `%c    ↳ ${response.why}`;

            const styles = [];
            if (response.suggestionRu)
              styles.push("color: #bb86fc; font-weight: bold;");
            if (response.suggestionEn)
              styles.push("color: #8ab4f8; font-weight: bold;");
            if (response.why)
              styles.push("color: #9aa0a6; font-style: italic;");

            console.log(logMsg, ...styles);
            showSuggestion(
              response.suggestionRu,
              response.suggestionEn,
              response.why
            );
          }
        }
      }
    );
  }

  function flushSpeaker(speaker) {
    const state = activeSpeakers.get(speaker);
    if (!state) return;

    if (state.pauseTimer) clearTimeout(state.pauseTimer);
    if (state.maxTimer) clearTimeout(state.maxTimer);

    if (!state.translated) {
      state.translated = true;
      state.translatedUpTo = state.text;
      requestTranslation(speaker, state.text);
    }
  }

  function partialFlush(speaker) {
    const state = activeSpeakers.get(speaker);
    if (!state || state.translated) return;

    state.translated = true;
    state.translatedUpTo = state.text;
    requestTranslation(speaker, state.text);

    if (state.maxTimer) clearTimeout(state.maxTimer);
  }

  function scheduleTranslation(speaker, state) {
    if (state.pauseTimer) clearTimeout(state.pauseTimer);

    const delay = endsWithPunctuation(state.text) ? SENTENCE_END_MS : PAUSE_MS;
    state.pauseTimer = setTimeout(() => flushSpeaker(speaker), delay);

    if (!state.maxTimer) {
      state.maxTimer = setTimeout(() => partialFlush(speaker), MAX_ACCUMULATE_MS);
    }
  }

  function processCaptions() {
    const captions = extractCaptions();

    if (captions.length > 0) {
      noSubtitlesWarningShown = false;
      if (noSubtitlesTimer) {
        clearTimeout(noSubtitlesTimer);
        noSubtitlesTimer = null;
      }

      const currentSpeakers = new Set();

      for (const { speaker, text } of captions) {
        currentSpeakers.add(speaker);
        const existing = activeSpeakers.get(speaker);

        if (existing && existing.text === text) continue;

        updateOverlayLine(speaker, text);

        if (existing) {
          if (existing.pauseTimer) clearTimeout(existing.pauseTimer);

          if (existing.translated && existing.translatedUpTo !== text) {
            existing.translated = false;
            if (existing.maxTimer) clearTimeout(existing.maxTimer);
            existing.maxTimer = null;
          }

          existing.text = text;
          scheduleTranslation(speaker, existing);
        } else {
          const state = {
            text,
            pauseTimer: null,
            maxTimer: null,
            startedAt: Date.now(),
            translatedUpTo: null,
            translated: false,
          };
          activeSpeakers.set(speaker, state);
          scheduleTranslation(speaker, state);
        }
      }

      for (const [speaker] of activeSpeakers) {
        if (!currentSpeakers.has(speaker)) {
          flushSpeaker(speaker);
          activeSpeakers.delete(speaker);
        }
      }
    } else {
      for (const [speaker] of activeSpeakers) {
        flushSpeaker(speaker);
      }
      activeSpeakers.clear();

      if (!noSubtitlesWarningShown && !noSubtitlesTimer) {
        noSubtitlesTimer = setTimeout(() => {
          if (!noSubtitlesWarningShown) {
            console.warn(
              "[Meet Captions] Субтитры не найдены. Убедитесь, что субтитры включены в Google Meet (кнопка CC)."
            );
            noSubtitlesWarningShown = true;
          }
          noSubtitlesTimer = null;
        }, 5000);
      }
    }
  }

  function isCaptionMutation(mutation) {
    const target =
      mutation.type === "characterData"
        ? mutation.target.parentElement
        : mutation.target;
    if (!target || !target.closest) return false;

    return (
      target.closest(CONTAINER_SELECTOR) ||
      target.closest(CONTAINER_FALLBACKS[0]) ||
      target.closest(CONTAINER_FALLBACKS[1])
    );
  }

  function handleMutations(mutations) {
    let relevant = false;
    for (const m of mutations) {
      if (isCaptionMutation(m)) {
        relevant = true;
        break;
      }
    }
    if (!relevant) return;

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(processCaptions, POLL_MS);
  }

  const observer = new MutationObserver(handleMutations);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
  });
})();
