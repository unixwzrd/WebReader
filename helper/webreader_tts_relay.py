#!/usr/bin/env python3
"""Loopback-only HTTP relay between WebReader and an OpenAI-compatible TTS bridge."""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


DEFAULT_ORIGINS = (
    "http://127.0.0.1:4000",
    "http://localhost:4000",
    "safari-web-extension://*",
)
MAX_REQUEST_BYTES = 64 * 1024
MAX_INPUT_CHARS = 5_000


@dataclass(frozen=True)
class RelayConfig:
    upstream_url: str
    voice: str | None
    model: str | None
    allowed_origins: tuple[str, ...]
    timeout: float


def speech_endpoint(value: str) -> str:
    value = value.rstrip("/")
    path = urlsplit(value).path.rstrip("/")
    if path.endswith("/v1/audio/speech") or path.endswith("/audio/speech"):
        return value
    if path.endswith("/v1"):
        return f"{value}/audio/speech"
    return f"{value}/v1/audio/speech"


def origin_allowed(origin: str | None, patterns: tuple[str, ...]) -> bool:
    return bool(origin and any(fnmatch.fnmatchcase(origin, pattern) for pattern in patterns))


def make_handler(config: RelayConfig) -> type[BaseHTTPRequestHandler]:
    class RelayHandler(BaseHTTPRequestHandler):
        server_version = "WebReaderRelay/0.1"

        def _cors_origin(self) -> str | None:
            origin = self.headers.get("Origin")
            return origin if origin_allowed(origin, config.allowed_origins) else None

        def _send_headers(self, status: int, content_type: str, length: int = 0) -> None:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            allowed = self._cors_origin()
            if allowed:
                self.send_header("Access-Control-Allow-Origin", allowed)
                self.send_header("Vary", "Origin")
            self.end_headers()

        def _json(self, status: int, payload: dict[str, object]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self._send_headers(status, "application/json", len(body))
            self.wfile.write(body)

        def _authorized(self) -> bool:
            if self._cors_origin():
                return True
            self._json(403, {"error": "origin not allowed"})
            return False

        def do_OPTIONS(self) -> None:  # noqa: N802
            if self.path not in ("/health", "/v1/audio/speech"):
                self._json(404, {"error": "not found"})
                return
            if not self._authorized():
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self._cors_origin() or "")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Vary", "Origin")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path != "/health":
                self._json(404, {"error": "not found"})
                return
            if not self._authorized():
                return
            self._json(200, {"status": "ok"})

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/v1/audio/speech":
                self._json(404, {"error": "not found"})
                return
            if not self._authorized():
                return

            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self._json(400, {"error": "invalid content length"})
                return
            if length <= 0 or length > MAX_REQUEST_BYTES:
                self._json(413, {"error": "request is empty or too large"})
                return

            try:
                incoming = json.loads(self.rfile.read(length))
            except (json.JSONDecodeError, UnicodeDecodeError):
                self._json(400, {"error": "invalid JSON"})
                return

            text = incoming.get("input") if isinstance(incoming, dict) else None
            if not isinstance(text, str) or not text.strip():
                self._json(400, {"error": "input must be non-empty text"})
                return
            if len(text) > MAX_INPUT_CHARS:
                self._json(413, {"error": "input exceeds 5,000 characters"})
                return

            payload: dict[str, str] = {"input": text, "response_format": "wav"}
            if config.voice:
                payload["voice"] = config.voice
            if config.model:
                payload["model"] = config.model

            request = urllib.request.Request(
                config.upstream_url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(request, timeout=config.timeout) as response:
                    audio = response.read()
                    content_type = response.headers.get("Content-Type", "audio/wav")
            except urllib.error.HTTPError as error:
                print(f"WebReader relay: upstream returned HTTP {error.code}", file=sys.stderr)
                self._json(502, {"error": "TTS bridge request failed"})
                return
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                print(f"WebReader relay: upstream unavailable ({type(error).__name__})", file=sys.stderr)
                self._json(502, {"error": "TTS bridge unavailable"})
                return

            if not audio or not content_type.lower().startswith("audio/"):
                self._json(502, {"error": "TTS bridge returned non-audio data"})
                return
            self._send_headers(200, content_type, len(audio))
            self.wfile.write(audio)

        def log_message(self, message: str, *args: object) -> None:
            print(f"WebReader relay: {message % args}", file=sys.stderr)

    return RelayHandler


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=11441)
    parser.add_argument("--bridge-url", default=os.environ.get("TTS_BRIDGE_URL"))
    parser.add_argument("--voice", default=os.environ.get("TTS_BRIDGE_VOICE"))
    parser.add_argument("--model", default=os.environ.get("TTS_BRIDGE_MODEL"))
    parser.add_argument("--allow-origin", action="append", dest="origins")
    parser.add_argument("--timeout", type=float, default=300.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.listen not in ("127.0.0.1", "::1", "localhost"):
        print("WebReader relay must listen on a loopback address.", file=sys.stderr)
        return 2
    if not args.bridge_url:
        print("Set TTS_BRIDGE_URL or pass --bridge-url.", file=sys.stderr)
        return 2

    config = RelayConfig(
        upstream_url=speech_endpoint(args.bridge_url),
        voice=args.voice,
        model=args.model,
        allowed_origins=tuple(args.origins or DEFAULT_ORIGINS),
        timeout=args.timeout,
    )
    server = ThreadingHTTPServer((args.listen, args.port), make_handler(config))
    print(f"WebReader relay listening on http://{args.listen}:{args.port}")
    print("Audio is relayed from memory and is not written to disk. Press Ctrl-C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
