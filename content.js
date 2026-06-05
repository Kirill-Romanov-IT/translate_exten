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
  // Пауза в речи — если текст не менялся 3 сек, считаем фразу законченной
  const PAUSE_MS = 3000;
  // Макс. накопление — если человек говорит без пауз дольше 12 сек, переводим то что есть
  const MAX_ACCUMULATE_MS = 12000;
  // Быстрый триггер — конец предложения (. ? !) + 800мс тишины
  const SENTENCE_END_MS = 800;
  // Время жизни строки перевода в оверлее
  const TRANSLATION_DISPLAY_MS = 8000;

  // speaker → {text, pauseTimer, maxTimer, startedAt, translatedUpTo, translated}
  const activeSpeakers = new Map();
  const translatedTexts = new Set();
  const MAX_TRANSLATED = 50;

  let noSubtitlesWarningShown = false;
  let noSubtitlesTimer = null;
  let debounceTimer = null;

  // === Оверлей для стриминга субтитров ===

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
      .mct-line .mct-speaker {
        color: #8ab4f8;
        font-weight: 500;
      }
      .mct-line .mct-translation {
        color: #81c995;
        display: block;
        margin-top: 2px;
      }
    </style>
  `;
  document.body.appendChild(overlay);

  const overlayLines = new Map();

  function getOverlayLine(speaker) {
    if (overlayLines.has(speaker)) return overlayLines.get(speaker);
    const el = document.createElement("div");
    el.className = "mct-line";
    overlay.appendChild(el);
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

    chrome.runtime.sendMessage(
      { type: "translate", text: text },
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

  // Частичный перевод — переводим накопленное, но спикер продолжает говорить
  function partialFlush(speaker) {
    const state = activeSpeakers.get(speaker);
    if (!state || state.translated) return;

    state.translated = true;
    state.translatedUpTo = state.text;
    requestTranslation(speaker, state.text);

    // Сбрасываем для следующего куска — maxTimer перезапустится при следующем обновлении
    if (state.maxTimer) clearTimeout(state.maxTimer);
  }

  function scheduleTranslation(speaker, state) {
    if (state.pauseTimer) clearTimeout(state.pauseTimer);

    // Выбираем задержку: конец предложения → быстрый триггер, иначе ждём паузу
    const delay = endsWithPunctuation(state.text) ? SENTENCE_END_MS : PAUSE_MS;

    state.pauseTimer = setTimeout(() => flushSpeaker(speaker), delay);

    // Макс. таймер — если ещё не запущен, стартуем
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

        // Стрим оригинала — обновляем ту же строку в оверлее
        updateOverlayLine(speaker, text);

        if (existing) {
          if (existing.pauseTimer) clearTimeout(existing.pauseTimer);

          // Текст обновился после того как мы уже перевели предыдущий кусок —
          // значит это продолжение, разрешаем новый перевод
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

      // Спикеры пропавшие из DOM — фраза закончена
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
