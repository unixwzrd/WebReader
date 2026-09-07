const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const { Readability } = require("@mozilla/readability");

global.Readability = Readability;
const extractor = require("../extension/extractor.js");

const fixture = fs.readFileSync(path.join(__dirname, "fixtures/article-page.html"), "utf8");

test("extractDocument keeps the article and removes surrounding page furniture", () => {
  const dom = new JSDOM(fixture, { url: "https://example.test/article" });
  const result = extractor.extractDocument(dom.window.document);

  assert.equal(result.method, "readability");
  assert.match(result.text, /A Useful Test Article/);
  assert.match(result.text, /The second paragraph is part of the article/);
  assert.doesNotMatch(result.text, /advertisement should never be spoken/);
  assert.doesNotMatch(result.text, /reader comment should not be spoken/);
  assert.doesNotMatch(result.text, /unrelated headline should not be spoken/);
  assert.doesNotMatch(result.text, /Terms Privacy Contact/);
});

test("cleanText produces speech-friendly text without URL punctuation", () => {
  assert.equal(extractor.cleanText("A → B + C = D / E & F"), "A B plus C equals D E and F");
});

test("semantic fallback refuses a document without an article-like region", () => {
  const dom = new JSDOM("<!doctype html><title>Menu</title><body><nav>One Two</nav></body>");
  const result = extractor.extractDocument(dom.window.document);

  assert.equal(result.method, "none");
  assert.equal(result.text, "");
});
