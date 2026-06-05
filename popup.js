const apiKeyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

chrome.storage.local.get(["openRouterKey", "model"], (data) => {
  if (data.openRouterKey) apiKeyInput.value = data.openRouterKey;
  if (data.model) modelSelect.value = data.model;
});

saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    statusEl.textContent = "Введите API ключ";
    statusEl.className = "status err";
    return;
  }

  chrome.storage.local.set(
    { openRouterKey: key, model: modelSelect.value },
    () => {
      statusEl.textContent = "Сохранено! Обновите страницу Meet.";
      statusEl.className = "status ok";
    }
  );
});
