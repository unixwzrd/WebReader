import http.client
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from helper.webreader_tts_relay import RelayConfig, make_handler, speech_endpoint


class FakeBridgeHandler(BaseHTTPRequestHandler):
    received = None

    def do_POST(self):  # noqa: N802
        length = int(self.headers["Content-Length"])
        type(self).received = json.loads(self.rfile.read(length))
        audio = b"RIFF-fake-wave"
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, *_args):
        pass


class RelayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bridge = ThreadingHTTPServer(("127.0.0.1", 0), FakeBridgeHandler)
        cls.bridge_thread = threading.Thread(target=cls.bridge.serve_forever, daemon=True)
        cls.bridge_thread.start()
        bridge_url = f"http://127.0.0.1:{cls.bridge.server_port}/v1"
        config = RelayConfig(
            upstream_url=speech_endpoint(bridge_url),
            voice="test-voice",
            model="test-model",
            allowed_origins=("http://localhost:4000", "safari-web-extension://*"),
            timeout=2,
        )
        cls.relay = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(config))
        cls.relay_thread = threading.Thread(target=cls.relay.serve_forever, daemon=True)
        cls.relay_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.relay.shutdown()
        cls.bridge.shutdown()
        cls.relay.server_close()
        cls.bridge.server_close()

    def request(self, method, path, origin, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.relay.server_port, timeout=2)
        headers = {"Origin": origin}
        if body is not None:
            body = json.dumps(body)
            headers["Content-Type"] = "application/json"
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        content = response.read()
        response_headers = dict(response.getheaders())
        connection.close()
        return response.status, response_headers, content

    def test_safari_extension_preflight_is_allowed(self):
        status, headers, _ = self.request(
            "OPTIONS", "/v1/audio/speech", "safari-web-extension://generated-identifier"
        )
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], "safari-web-extension://generated-identifier")

    def test_external_web_origin_is_denied(self):
        status, headers, _ = self.request("OPTIONS", "/v1/audio/speech", "https://example.com")
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_speech_is_forwarded_with_configured_defaults(self):
        status, headers, content = self.request(
            "POST",
            "/v1/audio/speech",
            "safari-web-extension://generated-identifier",
            {"input": "Read this sentence."},
        )
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "audio/wav")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertEqual(content, b"RIFF-fake-wave")
        self.assertEqual(
            FakeBridgeHandler.received,
            {
                "input": "Read this sentence.",
                "response_format": "wav",
                "voice": "test-voice",
                "model": "test-model",
            },
        )

    def test_health_does_not_disclose_upstream_configuration(self):
        status, _, content = self.request("GET", "/health", "http://localhost:4000")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(content), {"status": "ok"})

    def test_input_limit_is_enforced_before_upstream_request(self):
        status, _, _ = self.request(
            "POST",
            "/v1/audio/speech",
            "safari-web-extension://generated-identifier",
            {"input": "x" * 5_001},
        )
        self.assertEqual(status, 413)

    def test_endpoint_normalization(self):
        self.assertEqual(speech_endpoint("http://localhost:9000/v1"), "http://localhost:9000/v1/audio/speech")
        self.assertEqual(
            speech_endpoint("http://localhost:9000/v1/audio/speech"),
            "http://localhost:9000/v1/audio/speech",
        )
        self.assertEqual(speech_endpoint("http://localhost:9000"), "http://localhost:9000/v1/audio/speech")


if __name__ == "__main__":
    unittest.main()
