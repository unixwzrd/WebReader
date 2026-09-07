((root, factory) => {
  const exported = factory(root.Readability);
  if (typeof module === "object" && module.exports) {
    module.exports = exported;
  } else {
    root.WebReaderExtractor = exported;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, (ReadabilityClass) => {
  "use strict";

  const removedSelectors = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "audio",
    "video",
    "button",
    "form",
    "dialog",
    "nav",
    "aside",
    "footer",
    "[aria-hidden='true']",
    "[hidden]",
    "[role='navigation']",
    "[role='dialog']",
    "[role='banner']",
    "[role='complementary']",
    "[class*='advert']",
    "[class*='cookie']",
    "[class*='consent']",
    "[class*='social-share']",
    "[class*='sharing']",
    "[class*='related']",
    "[class*='recommend']",
    "[class*='comment']",
    "[id*='comment']",
  ];

  function cleanText(value) {
    return String(value || "")
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/&/g, " and ")
      .replace(/[→←↔•_|`*]/g, " ")
      .replace(/\//g, " ")
      .replace(/=/g, " equals ")
      .replace(/\+/g, " plus ")
      .replace(/[ \t]+/g, " ")
      .replace(/\s+([,.;:!?])/g, "$1")
      .replace(/([(\[])\s+/g, "$1")
      .replace(/\s+([)\]])/g, "$1")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function removeUnwanted(rootNode) {
    rootNode.querySelectorAll(removedSelectors.join(",")).forEach((node) => node.remove());
    rootNode.querySelectorAll("img, picture, source, iframe").forEach((node) => node.remove());
    rootNode.querySelectorAll("a").forEach((link) => {
      const visible = cleanText(link.textContent);
      const href = cleanText(link.getAttribute("href"));
      if (/^(https?:\/\/|www\.)/i.test(visible) || visible === href) {
        link.remove();
      } else {
        link.replaceWith(...link.childNodes);
      }
    });
    return rootNode;
  }

  function textFromRoot(rootNode, title = "") {
    const clone = removeUnwanted(rootNode.cloneNode(true));
    const blocks = [];
    const cleanTitle = cleanText(title);
    if (cleanTitle) {
      blocks.push(/[.!?]$/.test(cleanTitle) ? cleanTitle : `${cleanTitle}.`);
    }
    const blockSelector = "h1, h2, h3, h4, p, li, blockquote";
    clone.querySelectorAll(blockSelector).forEach((node) => {
      const parentBlock = node.parentElement?.closest(blockSelector);
      if (parentBlock && clone.contains(parentBlock)) {
        return;
      }
      let text = cleanText(node.textContent);
      if (!text) {
        return;
      }
      if (/^H[1-4]$/.test(node.tagName) && !/[.!?]$/.test(text)) {
        text += ".";
      }
      if (blocks.at(-1) !== text) {
        blocks.push(text);
      }
    });
    if (blocks.length === 0) {
      const fallback = cleanText(clone.textContent);
      if (fallback) {
        blocks.push(fallback);
      }
    }
    return blocks.join("\n\n");
  }

  function fallbackRoot(document) {
    const candidates = [...document.querySelectorAll("article, main, [role='main']")];
    candidates.sort((left, right) => cleanText(right.textContent).length - cleanText(left.textContent).length);
    return candidates[0] || null;
  }

  function extractDocument(document) {
    if (typeof ReadabilityClass === "function") {
      const clone = document.cloneNode(true);
      removeUnwanted(clone);
      const parsed = new ReadabilityClass(clone, { charThreshold: 140, keepClasses: false }).parse();
      if (parsed?.textContent && cleanText(parsed.textContent).length >= 140) {
        const container = document.createElement("div");
        container.innerHTML = parsed.content;
        return {
          title: cleanText(parsed.title || document.title),
          text: textFromRoot(container, parsed.title || document.title),
          method: "readability",
        };
      }
    }

    const candidate = fallbackRoot(document);
    if (!candidate) {
      return { title: cleanText(document.title), text: "", method: "none" };
    }
    return {
      title: cleanText(document.title),
      text: textFromRoot(candidate, document.title),
      method: "semantic",
    };
  }

  return { cleanText, extractDocument, fallbackRoot, removeUnwanted, textFromRoot };
});
