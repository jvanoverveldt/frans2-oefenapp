import json
import mimetypes
import os
import tempfile
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("DATA_DIR", APP_DIR / "data")).resolve()
PORT = int(os.environ.get("PORT", "8099"))
HOST = os.environ.get("HOST", "0.0.0.0")
DEFAULT_MODEL = "gemini-3.5-flash-lite"
MAX_BODY_BYTES = 12 * 1024 * 1024

ALLOWED_STATIC = {
    "": "index.html",
    "index.html": "index.html",
    "style.css": "style.css",
    "app.js": "app.js",
    "curriculum.json": "curriculum.json",
}

PROGRESS_FILE = DATA_DIR / "progress.json"
CONFIG_FILE = DATA_DIR / "config.json"
HA_OPTIONS_FILE = Path("/data/options.json")


def ensure_data_dir():
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def read_json(path: Path, default):
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def write_json_atomic(path: Path, payload):
    ensure_data_dir()
    fd, tmp_name = tempfile.mkstemp(dir=str(DATA_DIR), prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        os.replace(tmp_name, path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def get_effective_config():
    cfg = read_json(CONFIG_FILE, {})
    ha_opts = read_json(HA_OPTIONS_FILE, {}) if HA_OPTIONS_FILE.is_file() else {}
    api_key = cfg.get("apiKey") or ha_opts.get("gemini_api_key") or os.environ.get("GEMINI_API_KEY", "")
    model = cfg.get("model") or ha_opts.get("gemini_model") or os.environ.get("GEMINI_MODEL") or DEFAULT_MODEL
    if cfg.get("apiKey"):
        source = "server"
    elif ha_opts.get("gemini_api_key"):
        source = "homeassistant"
    elif os.environ.get("GEMINI_API_KEY"):
        source = "env"
    else:
        source = "none"
    return {"apiKey": api_key.strip(), "model": model.strip() or DEFAULT_MODEL, "source": source}


def mask_key(key: str) -> str:
    if not key:
        return ""
    if len(key) <= 8:
        return "•" * len(key)
    return f"{key[:4]}…{key[-4:]}"


class FransHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[frans2] {self.address_string()} - {fmt % args}", flush=True)

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length <= 0:
            return {}
        if length > MAX_BODY_BYTES:
            raise ValueError("Payload te groot (max 12 MB).")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path.lstrip("/")

        if path == "api/health":
            self.send_json({"ok": True})
            return

        if path == "api/progress":
            self.send_json(read_json(PROGRESS_FILE, {}))
            return

        if path == "api/config":
            cfg = get_effective_config()
            self.send_json({
                "model": cfg["model"],
                "hasKey": bool(cfg["apiKey"]),
                "maskedKey": mask_key(cfg["apiKey"]),
                "keySource": cfg["source"],
            })
            return

        if path in ALLOWED_STATIC:
            target = APP_DIR / ALLOWED_STATIC[path]
            if not target.is_file():
                self.send_json({"error": "Bestand niet gevonden"}, 404)
                return
            content = target.read_bytes()
            ctype, _ = mimetypes.guess_type(str(target))
            if not ctype:
                ctype = "application/octet-stream"
            if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
                ctype = f"{ctype}; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
            return

        self.send_json({"error": "Niet gevonden"}, 404)

    def do_POST(self):
        path = urlparse(self.path).path.lstrip("/")

        try:
            body = self.read_json_body()
        except ValueError as exc:
            self.send_json({"error": str(exc)}, 413)
            return
        except Exception:
            self.send_json({"error": "Ongeldige JSON-invoer"}, 400)
            return

        if path == "api/progress":
            if not isinstance(body, dict):
                self.send_json({"error": "Voortgang moet een JSON-object zijn"}, 400)
                return
            write_json_atomic(PROGRESS_FILE, body)
            self.send_json({"ok": True})
            return

        if path == "api/config":
            current = read_json(CONFIG_FILE, {})
            if "model" in body and isinstance(body["model"], str) and body["model"].strip():
                current["model"] = body["model"].strip()
            if body.get("clearKey"):
                current.pop("apiKey", None)
            elif "apiKey" in body and isinstance(body["apiKey"], str) and body["apiKey"].strip():
                current["apiKey"] = body["apiKey"].strip()
            write_json_atomic(CONFIG_FILE, current)
            cfg = get_effective_config()
            self.send_json({
                "ok": True,
                "model": cfg["model"],
                "hasKey": bool(cfg["apiKey"]),
                "maskedKey": mask_key(cfg["apiKey"]),
                "keySource": cfg["source"],
            })
            return

        if path == "api/gemini":
            self.handle_gemini(body)
            return

        self.send_json({"error": "Niet gevonden"}, 404)

    def handle_gemini(self, body):
        cfg = get_effective_config()
        api_key = cfg["apiKey"]
        if not api_key:
            self.send_json({"error": "Geen Gemini API-key ingesteld. Open Instellingen om je sleutel toe te voegen."}, 400)
            return

        model = (body.get("model") or cfg["model"] or DEFAULT_MODEL).strip()
        payload = {}
        for key in ("contents", "systemInstruction", "generationConfig"):
            if key in body and body[key] is not None:
                payload[key] = body[key]

        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8")
                self.send_json(json.loads(raw), 200)
        except urllib.error.HTTPError as err:
            err_body = err.read().decode("utf-8", errors="ignore")
            try:
                err_json = json.loads(err_body)
                msg = err_json.get("error", {}).get("message", err_body)
            except Exception:
                msg = err_body or str(err)
            self.send_json({"error": f"Gemini API fout ({err.code}): {msg}"}, err.code)
        except urllib.error.URLError as err:
            self.send_json({"error": f"Kan Gemini API niet bereiken: {err.reason}"}, 502)
        except Exception as exc:
            self.send_json({"error": f"Onverwachte fout bij Gemini-call: {exc}"}, 500)


def main():
    ensure_data_dir()
    server = ThreadingHTTPServer((HOST, PORT), FransHandler)
    print(f"Frans 2 Oefenapp draait op http://localhost:{PORT} (data: {DATA_DIR})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer gestopt.")
        server.server_close()


if __name__ == "__main__":
    main()
