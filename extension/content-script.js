(() => {
  "use strict";

  const existingHost = document.getElementById("webreader-extension-root");
  if (existingHost) {
    existingHost.hidden = false;
    existingHost.dispatchEvent(new CustomEvent("webreader:show"));
    return;
  }

  const api = globalThis.browser || globalThis.chrome;
  const extractor = globalThis.WebReaderExtractor;
  if (!api?.runtime || !extractor) {
    return;
  }

  const maxChunkCharacters = 900;
  const host = document.createElement("div");
  host.id = "webreader-extension-root";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
        color-scheme: dark;
      }
      .reader {
        position: fixed;
        z-index: 2147483647;
        right: 18px;
        bottom: 18px;
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: min(720px, calc(100vw - 36px));
        padding: 10px 12px;
        border: 1px solid #46515e;
        border-radius: 12px;
        background: rgba(18, 22, 27, 0.97);
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.42);
        color: #f4f7fa;
        font: 14px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .label {
        font-weight: 700;
        letter-spacing: 0.01em;
        white-space: nowrap;
      }
      button {
        appearance: none;
        border: 1px solid #607080;
        border-radius: 7px;
        padding: 5px 9px;
        background: #27313b;
        color: #f4f7fa;
        font: inherit;
        cursor: pointer;
      }
      button:hover:not(:disabled) {
        background: #344250;
        border-color: #8ea4b8;
      }
      button:focus-visible {
        outline: 2px solid #72b7ff;
        outline-offset: 2px;
      }
      button:disabled {
        cursor: default;
        opacity: 0.45;
      }
      .status {
        min-width: 160px;
        overflow: hidden;
        color: #cbd4dc;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .hide {
        margin-left: 2px;
        border-color: transparent;
        background: transparent;
        color: #aeb9c3;
      }
      @media (max-width: 680px) {
        .reader {
          right: 8px;
          bottom: 8px;
          left: 8px;
          flex-wrap: wrap;
          max-width: none;
        }
        .status {
          order: 2;
          flex: 1 0 100%;
        }
      }
      @media print {
        .reader { display: none; }
      }
    </style>
    <section class="reader" aria-label="WebReader text-to-speech player">
      <span class="label">Listen</span>
      <button type="button" data-action="restart" title="Restart from the beginning of the article">Restart</button>
      <button type="button" data-action="play">Play</button>
      <button type="button" data-action="pause" disabled>Pause</button>
      <button type="button" data-action="stop" disabled>Stop</button>
      <span class="status" role="status" aria-live="polite">Select text, place the cursor, or play the article.</span>
      <button type="button" class="hide" data-action="hide" title="Hide WebReader">Hide</button>
    </section>
  `;
  document.documentElement.append(host);

  const playButton = shadow.querySelector('[data-action="play"]');
  const pauseButton = shadow.querySelector('[data-action="pause"]');
  const stopButton = shadow.querySelector('[data-action="stop"]');
  const restartButton = shadow.querySelector('[data-action="restart"]');
  const hideButton = shadow.querySelector('[data-action="hide"]');
  const status = shadow.querySelector(".status");
  const audio = document.createElement("audio");
  const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
  const silentWav = "data:audio/wav;base64,UklGRsQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  audio.preload = "auto";
  audio.setAttribute("playsinline", "");

  let sessionId = 0;
  let chunks = [];
  let currentIndex = 0;
  let paused = false;
  let stopped = true;
  let activeObjectUrl = null;
  let audioContext = null;
  let activeBufferSource = null;
  let usingWebAudio = false;
  let bufferedAudio = new Map();
  let queuedTarget = null;
  let lastCaretRange = null;
  let playbackScope = "article";

  function setStatus(message) {
    status.textContent = message;
    status.title = message;
  }

  function setControls({ playing = false, isPaused = false } = {}) {
    playButton.textContent = isPaused ? "Resume" : "Play";
    playButton.disabled = playing && !isPaused;
    pauseButton.disabled = !playing || isPaused;
    stopButton.disabled = !playing;
  }

  function primeAudioOutput() {
    if (!audio.src || audio.src.startsWith("data:")) {
      audio.src = silentWav;
    }
    audio.play().catch(() => {});

    if (AudioContextClass) {
      const context = ensureAudioContext();
      context.resume().catch(() => {});
      const source = context.createBufferSource();
      source.buffer = context.createBuffer(1, 1, context.sampleRate);
      source.connect(context.destination);
      source.start(0);
      source.addEventListener("ended", () => source.disconnect(), { once: true });
    }
  }

  function ensureAudioContext() {
    if (!AudioContextClass) {
      throw new Error("This browser does not provide Web Audio playback.");
    }
    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContextClass();
    }
    return audioContext;
  }

  function rangeContainer(range) {
    return range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement;
  }

  function currentPageRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return null;
    }
    const range = selection.getRangeAt(0);
    const container = rangeContainer(range);
    if (!container || host.contains(container)) {
      return null;
    }
    return range.cloneRange();
  }

  function wholeArticle() {
    return extractor.extractDocument(document);
  }

  function textFromCaret(range, article) {
    const container = rangeContainer(range);
    const block = container?.closest("p, h1, h2, h3, h4, li, blockquote");
    if (!block) {
      return article.text;
    }

    const blockText = extractor.cleanText(block.textContent);
    const blockOffset = article.text.indexOf(blockText);
    if (blockOffset < 0) {
      return article.text;
    }

    let prefixLength = 0;
    try {
      const prefixRange = range.cloneRange();
      prefixRange.selectNodeContents(block);
      prefixRange.setEnd(range.startContainer, range.startOffset);
      prefixLength = extractor.cleanText(prefixRange.toString()).length;
    } catch (_error) {
      prefixLength = 0;
    }
    return article.text.slice(blockOffset + Math.min(prefixLength, blockText.length)).trim();
  }

  function readingTarget() {
    const selection = window.getSelection();
    const range = currentPageRange();
    if (range && selection && !selection.isCollapsed) {
      return { text: extractor.cleanText(selection.toString()), scope: "selection" };
    }

    const article = wholeArticle();
    if (range?.collapsed) {
      lastCaretRange = range.cloneRange();
      return { text: textFromCaret(range, article), scope: "cursor" };
    }
    if (lastCaretRange) {
      return { text: textFromCaret(lastCaretRange, article), scope: "cursor" };
    }
    return { text: article.text, scope: article.method === "readability" ? "article" : "page" };
  }

  function splitLongText(text) {
    if (text.length <= maxChunkCharacters) {
      return [text];
    }
    const sentences = text.match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g) || [text];
    const pieces = [];
    let current = "";
    for (const rawSentence of sentences) {
      const sentence = rawSentence.trim();
      const candidate = `${current} ${sentence}`.trim();
      if (current && candidate.length > maxChunkCharacters) {
        pieces.push(current);
        current = sentence;
      } else {
        current = candidate;
      }
      while (current.length > maxChunkCharacters) {
        let boundary = current.lastIndexOf(" ", maxChunkCharacters);
        if (boundary < 1) {
          boundary = maxChunkCharacters;
        }
        pieces.push(current.slice(0, boundary).trim());
        current = current.slice(boundary).trim();
      }
    }
    if (current) {
      pieces.push(current);
    }
    return pieces;
  }

  function makeChunks(text) {
    const result = [];
    let current = "";
    for (const paragraph of text.split(/\n{2,}/).map(extractor.cleanText).filter(Boolean)) {
      for (const piece of splitLongText(paragraph)) {
        const candidate = `${current}\n\n${piece}`.trim();
        if (current && candidate.length > maxChunkCharacters) {
          result.push(current);
          current = piece;
        } else {
          current = candidate;
        }
      }
    }
    if (current) {
      result.push(current);
    }
    return result;
  }

  function sendMessage(message) {
    if (globalThis.browser?.runtime) {
      return globalThis.browser.runtime.sendMessage(message);
    }
    return new Promise((resolve, reject) => {
      globalThis.chrome.runtime.sendMessage(message, (response) => {
        const error = globalThis.chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  function base64ToBytes(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  async function loadAudio(index, expectedSession) {
    if (bufferedAudio.has(index)) {
      return bufferedAudio.get(index);
    }
    const promise = (async () => {
      const response = await sendMessage({ type: "webreader:synthesize", input: chunks[index] });
      if (!response?.ok) {
        throw new Error(response?.error || "The local TTS helper did not return audio.");
      }
      if (expectedSession !== sessionId) {
        return null;
      }
      return {
        bytes: base64ToBytes(response.audioBase64),
        contentType: response.contentType,
      };
    })();
    bufferedAudio.set(index, promise);
    return promise;
  }

  function releaseAudioUrl() {
    if (activeObjectUrl) {
      URL.revokeObjectURL(activeObjectUrl);
      activeObjectUrl = null;
    }
  }

  async function playCurrent(expectedSession) {
    if (expectedSession !== sessionId || stopped || paused) {
      return;
    }
    if (currentIndex >= chunks.length) {
      stopped = true;
      setControls();
      setStatus("Finished.");
      return;
    }

    try {
      setStatus(`Preparing ${currentIndex + 1} of ${chunks.length}...`);
      const audioData = await loadAudio(currentIndex, expectedSession);
      if (!audioData || expectedSession !== sessionId || stopped) {
        return;
      }
      if (paused) {
        setStatus(`Paused at ${currentIndex + 1} of ${chunks.length}.`);
        return;
      }

      const chunkEnded = () => {
        if (expectedSession !== sessionId || stopped) {
          return;
        }
        releaseAudioUrl();
        activeBufferSource = null;
        bufferedAudio.delete(currentIndex);
        currentIndex += 1;
        playCurrent(expectedSession);
      };

      releaseAudioUrl();
      activeObjectUrl = URL.createObjectURL(new Blob([audioData.bytes], { type: audioData.contentType }));
      audio.src = activeObjectUrl;
      audio.currentTime = 0;
      audio.onended = chunkEnded;
      usingWebAudio = false;
      try {
        await audio.play();
      } catch (nativeError) {
        audio.pause();
        audio.onended = null;
        audio.removeAttribute("src");
        releaseAudioUrl();
        if (!AudioContextClass || (nativeError.name !== "NotSupportedError" && !/not supported/i.test(nativeError.message))) {
          throw nativeError;
        }

        const context = ensureAudioContext();
        const arrayBuffer = audioData.bytes.buffer.slice(
          audioData.bytes.byteOffset,
          audioData.bytes.byteOffset + audioData.bytes.byteLength,
        );
        let decoded;
        try {
          decoded = await context.decodeAudioData(arrayBuffer);
        } catch (decodeError) {
          throw new Error("Safari could not decode the returned audio.", { cause: decodeError });
        }
        if (expectedSession !== sessionId || stopped) {
          return;
        }
        await context.resume();
        activeBufferSource = context.createBufferSource();
        activeBufferSource.buffer = decoded;
        activeBufferSource.connect(context.destination);
        activeBufferSource.addEventListener("ended", chunkEnded, { once: true });
        activeBufferSource.start(0);
        usingWebAudio = true;
      }
      setStatus(`Playing ${currentIndex + 1} of ${chunks.length} from ${playbackScope}.`);
      if (currentIndex + 1 < chunks.length) {
        loadAudio(currentIndex + 1, expectedSession).catch(() => {});
      }
    } catch (error) {
      if (expectedSession !== sessionId) {
        return;
      }
      stopped = true;
      setControls();
      setStatus(error.message || "The local TTS helper is unavailable.");
      console.error("WebReader playback failed:", error);
    }
  }

  function stopPlayback(showStatus = true) {
    sessionId += 1;
    stopped = true;
    paused = false;
    audio.pause();
    audio.onended = null;
    audio.removeAttribute("src");
    audio.load();
    if (activeBufferSource) {
      try {
        activeBufferSource.stop();
      } catch (_error) {
        // The source may already have ended.
      }
      activeBufferSource.disconnect();
      activeBufferSource = null;
    }
    if (usingWebAudio && audioContext?.state === "running") {
      audioContext.suspend().catch(() => {});
    }
    usingWebAudio = false;
    releaseAudioUrl();
    for (const value of bufferedAudio.values()) {
      Promise.resolve(value).catch(() => {});
    }
    bufferedAudio.clear();
    chunks = [];
    currentIndex = 0;
    setControls();
    if (showStatus) {
      setStatus("Stopped. Select text, place the cursor, or play the article.");
    }
  }

  async function startOrResume(forcedTarget = null) {
    if (!forcedTarget && paused && !stopped) {
      paused = false;
      if (usingWebAudio) {
        await ensureAudioContext().resume();
      } else {
        await audio.play();
      }
      setControls({ playing: true });
      setStatus(`Playing ${currentIndex + 1} of ${chunks.length} from ${playbackScope}.`);
      return;
    }

    stopPlayback(false);
    const target = forcedTarget || queuedTarget || readingTarget();
    queuedTarget = null;
    chunks = makeChunks(target.text);
    if (chunks.length === 0) {
      setStatus("No readable article text was found.");
      return;
    }

    sessionId += 1;
    currentIndex = 0;
    paused = false;
    stopped = false;
    playbackScope = target.scope;
    setControls({ playing: true });
    playCurrent(sessionId);
  }

  function pointerRange(event) {
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(event.clientX, event.clientY);
      if (position) {
        const range = document.createRange();
        range.setStart(position.offsetNode, position.offset);
        range.collapse(true);
        return range;
      }
    }
    if (document.caretRangeFromPoint) {
      return document.caretRangeFromPoint(event.clientX, event.clientY);
    }
    return null;
  }

  document.addEventListener("pointerup", (event) => {
    if (event.composedPath().includes(host)) {
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      return;
    }
    const range = pointerRange(event);
    const container = range ? rangeContainer(range) : null;
    if (container && !host.contains(container)) {
      lastCaretRange = range.cloneRange();
    }
  }, true);

  playButton.addEventListener("pointerdown", () => {
    queuedTarget = readingTarget();
    primeAudioOutput();
  });
  playButton.addEventListener("click", () => {
    primeAudioOutput();
    startOrResume().catch((error) => {
      setControls();
      setStatus("The browser could not start audio playback.");
      console.error("WebReader start failed:", error);
    });
  });
  restartButton.addEventListener("pointerdown", primeAudioOutput);
  restartButton.addEventListener("click", () => {
    primeAudioOutput();
    const article = wholeArticle();
    startOrResume({ text: article.text, scope: "beginning" }).catch((error) => {
      setControls();
      setStatus("The browser could not restart audio playback.");
      console.error("WebReader restart failed:", error);
    });
  });
  pauseButton.addEventListener("click", () => {
    if (stopped || paused) {
      return;
    }
    paused = true;
    if (usingWebAudio) {
      audioContext.suspend().catch(() => {});
    } else {
      audio.pause();
    }
    setControls({ playing: true, isPaused: true });
    setStatus(`Paused at ${currentIndex + 1} of ${chunks.length}.`);
  });
  stopButton.addEventListener("click", () => stopPlayback());
  hideButton.addEventListener("click", () => {
    stopPlayback(false);
    host.hidden = true;
  });
  host.addEventListener("webreader:show", () => setStatus("Select text, place the cursor, or play the article."));
  window.addEventListener("pagehide", () => stopPlayback(false), { once: true });
})();
