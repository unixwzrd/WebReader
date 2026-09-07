(() => {
  "use strict";

  const api = globalThis.browser || globalThis.chrome;
  const defaultRelayUrl = "http://127.0.0.1:11441";
  const injectedFiles = ["vendor/Readability.js", "extractor.js", "content-script.js"];

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const blockSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += blockSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + blockSize));
    }
    return btoa(binary);
  }

  async function relayUrl() {
    const stored = await api.storage.local.get("relayUrl");
    return String(stored.relayUrl || defaultRelayUrl).replace(/\/$/, "");
  }

  async function synthesize(input) {
    if (typeof input !== "string" || input.trim().length === 0) {
      throw new Error("No readable text was supplied.");
    }
    if (input.length > 5000) {
      throw new Error("The speech chunk exceeded 5,000 characters.");
    }

    const response = await fetch(`${await relayUrl()}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`The local TTS helper returned HTTP ${response.status}.`);
    }
    const contentType = response.headers.get("Content-Type") || "audio/wav";
    if (!contentType.toLowerCase().startsWith("audio/")) {
      throw new Error("The local TTS helper returned non-audio data.");
    }
    return {
      audioBase64: bytesToBase64(await response.arrayBuffer()),
      contentType,
    };
  }

  api.action.onClicked.addListener(async (tab) => {
    if (!tab.id || !/^https?:/i.test(tab.url || "")) {
      return;
    }
    try {
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: injectedFiles });
    } catch (error) {
      console.error("WebReader could not be injected:", error);
    }
  });

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "webreader:synthesize") {
      return false;
    }
    synthesize(message.input)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });
})();
