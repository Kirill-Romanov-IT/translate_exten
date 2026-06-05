const apiKeyInput = document.getElementById("apiKey");
const modelSelect = document.getElementById("model");
const userContextInput = document.getElementById("userContext");
const callGoalInput = document.getElementById("callGoal");
const saveBtn = document.getElementById("save");
const clearHistoryBtn = document.getElementById("clearHistory");
const statusEl = document.getElementById("status");

chrome.storage.local.get(
  ["openRouterKey", "model", "userContext", "callGoal"],
  (data) => {
    if (data.openRouterKey) apiKeyInput.value = data.openRouterKey;
    if (data.model) modelSelect.value = data.model;
    if (data.userContext) userContextInput.value = data.userContext;
    if (data.callGoal) callGoalInput.value = data.callGoal;
  }
);

clearHistoryBtn.addEventListener("click", () => {
  chrome.storage.local.remove("mct_history", () => {
    statusEl.textContent = "История очищена. Новый звонок — чистый контекст.";
    statusEl.className = "status ok";
  });
});

saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    statusEl.textContent = "Введите API ключ";
    statusEl.className = "status err";
    return;
  }

  chrome.storage.local.set(
    {
      openRouterKey: key,
      model: modelSelect.value,
      userContext: userContextInput.value.trim(),
      callGoal: callGoalInput.value.trim(),
    },
    () => {
      statusEl.textContent = "Сохранено! Обновите страницу Meet.";
      statusEl.className = "status ok";
    }
  );
});
