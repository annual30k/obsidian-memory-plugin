#!/usr/bin/env python3
"""Laya Memory Judge local adapter service.

Listens strictly on 127.0.0.1 or ::1 (ephemeral loopback port), exposes:
- GET /health (authenticated health check)
- POST /judge/recall (authenticated memory recall decision)
- POST /shutdown (authenticated graceful shutdown)

Authenticates via constant-time Bearer token comparison, clamps all probability outputs
to finite [0.0, 1.0], and atomically registers with ~/.laya/service.json (POSIX 0600).
Supports native Apple Silicon via laya-mlx, cross-platform PyTorch via laya, and mock backends.
"""

from __future__ import annotations

import argparse
import atexit
import json
import math
import os
import re
import secrets
import signal
import socket
import stat
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

MAX_PAYLOAD_BYTES = 65536
SERVICE_IDENTITY = "laya-memory-judge"
API_VERSION = "1"
ALLOWED_LOOPBACK_HOSTS = {"127.0.0.1", "::1"}
PROJECT_ID_REGEX = re.compile(r"^[a-zA-Z0-9_-]+$")

QUESTIONS = {
    "requires_memory": {
        "type": "choice",
        "instructions": "Does `text` need or benefit from retrieving past project memories, historical notes, or saved context?",
        "criteria": {
            "yes": "needs recalling past project context, previous decisions, pitfalls, or user preferences",
            "no": "general query, self-contained coding question, or greeting without past project context"
        }
    },
    "scope": {
        "type": "choice",
        "instructions": "What is the appropriate memory scope for `text`?",
        "criteria": {
            "project": "project-specific facts, code decisions, local pitfalls, or repository context",
            "global": "user-wide global preferences, personal habits, or cross-project instructions",
            "unknown": "unclear, ambiguous, or general scope"
        }
    },
    "category": {
        "type": "choice",
        "instructions": "What type of memory is most relevant for `text`?",
        "criteria": {
            "pitfall": "known bugs, error workarounds, failure preventions, or debugging lessons",
            "decision": "architecture decisions, design rationales, conventions, and alternatives",
            "knowledge": "domain specifications, contracts, setups, and reference documentation"
        }
    }
}


def sanitize_score(val: Any) -> float:
    """Validate that score is numeric and finite, and clamp to [0.0, 1.0]."""
    if val is None or not isinstance(val, (int, float)):
        raise ValueError("Score value must be numeric")
    fval = float(val)
    if not math.isfinite(fval):
        raise ValueError("Score value must be finite (cannot be NaN or Inf)")
    return max(0.0, min(1.0, fval))


def check_no_symlink(path_str: str, label: str) -> Path:
    """Validate that the path itself and its immediate parent directory are NOT symlinks.
    
    Uses os.path.abspath() which normalizes '.' and '..' lexically WITHOUT dereferencing symlinks.
    """
    expanded = os.path.expanduser(path_str)
    abs_path = os.path.abspath(expanded)

    # 1. Check if the path itself is a symlink
    try:
        st = os.lstat(abs_path)
        if stat.S_ISLNK(st.st_mode):
            sys.stderr.write(f"Security error: {label} '{path_str}' is a symlink\n")
            sys.exit(2)
    except FileNotFoundError:
        pass
    except OSError as e:
        sys.stderr.write(f"Security error inspecting {label}: {e}\n")
        sys.exit(2)

    # 2. Check if the parent directory is a symlink
    parent_dir = os.path.dirname(abs_path)
    if os.path.exists(parent_dir):
        try:
            parent_st = os.lstat(parent_dir)
            if stat.S_ISLNK(parent_st.st_mode):
                sys.stderr.write(f"Security error: Parent directory of {label} '{parent_dir}' is a symlink\n")
                sys.exit(2)
        except OSError as e:
            sys.stderr.write(f"Security error inspecting parent directory of {label}: {e}\n")
            sys.exit(2)

    return Path(abs_path)


class BaseBackend:
    def __init__(self, model_name: str):
        self.model_name = model_name
        self.status = "loading"
        self.backend_type = "unknown"

    def predict(self, text: str, project_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raise NotImplementedError


class MockBackend(BaseBackend):
    def __init__(self, model_name: str = "mock-model"):
        super().__init__(model_name)
        self.status = "ready"
        self.backend_type = "mock"
        self.delay = float(os.environ.get("LAYA_MOCK_DELAY", "0"))

    def predict(self, text: str, project_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        if self.delay > 0:
            import time
            time.sleep(self.delay)

        lower = text.lower()
        is_memory_related = any(kw in lower for kw in [
            "回忆", "踩坑", "以前", "之前", "记录", "记忆", "remember", "recall", "past", "history", "pitfall"
        ])

        if is_memory_related:
            req_score = 0.85
            confidence = 0.92
            scope_scores = {"project": 0.80, "global": 0.15, "unknown": 0.05}
            cat_scores = {"pitfall": 0.70, "decision": 0.20, "knowledge": 0.10}
        else:
            req_score = 0.12
            confidence = 0.88
            scope_scores = {"project": 0.20, "global": 0.10, "unknown": 0.70}
            cat_scores = {"pitfall": 0.10, "decision": 0.20, "knowledge": 0.70}

        return {
            "requires_memory": sanitize_score(req_score),
            "confidence": sanitize_score(confidence),
            "category_confidence": sanitize_score(confidence),
            "scope": {k: sanitize_score(v) for k, v in scope_scores.items()},
            "categories": {k: sanitize_score(v) for k, v in cat_scores.items()}
        }


class MlxBackend(BaseBackend):
    def __init__(self, model_name: str = "aac6fef/laya-multilingual-mlx"):
        super().__init__(model_name)
        self.backend_type = "mlx"
        import laya_mlx
        self.agent = laya_mlx.load(model_name)
        self.status = "ready"

    def predict(self, text: str, project_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        state: Dict[str, Any] = {"text": text}
        if project_context and isinstance(project_context, dict):
            if "project_id" in project_context:
                state["project_id"] = str(project_context["project_id"])

        res = self.agent.predict(state, QUESTIONS)
        answers = res.get("answers", {})

        req_ans = answers.get("requires_memory", {})
        req_probs = req_ans.get("probabilities", {})
        requires_memory = sanitize_score(req_probs.get("yes", 0.5))
        confidence = sanitize_score(req_ans.get("confidence", 0.5))

        scope_ans = answers.get("scope", {})
        scope_probs = scope_ans.get("probabilities", {})
        scope = {
            "project": sanitize_score(scope_probs.get("project", 0.0)),
            "global": sanitize_score(scope_probs.get("global", 0.0)),
            "unknown": sanitize_score(scope_probs.get("unknown", 0.0))
        }

        cat_ans = answers.get("category", {})
        cat_probs = cat_ans.get("probabilities", {})
        cat_confidence = sanitize_score(cat_ans.get("confidence", 0.5))
        categories = {
            "pitfall": sanitize_score(cat_probs.get("pitfall", 0.0)),
            "decision": sanitize_score(cat_probs.get("decision", 0.0)),
            "knowledge": sanitize_score(cat_probs.get("knowledge", 0.0))
        }

        return {
            "requires_memory": requires_memory,
            "confidence": confidence,
            "category_confidence": cat_confidence,
            "scope": scope,
            "categories": categories
        }


class PyTorchBackend(BaseBackend):
    def __init__(self, model_name: str = "convaiinnovations/laya-multilingual"):
        super().__init__(model_name)
        self.backend_type = "pytorch"
        import laya
        self.agent = laya.load(model_name)
        self.status = "ready"

    def predict(self, text: str, project_context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        state: Dict[str, Any] = {"text": text}
        if project_context and isinstance(project_context, dict):
            if "project_id" in project_context:
                state["project_id"] = str(project_context["project_id"])

        res = self.agent.predict(state, QUESTIONS)
        answers = res.get("answers", {})

        req_ans = answers.get("requires_memory", {})
        req_probs = req_ans.get("probabilities", {})
        requires_memory = sanitize_score(req_probs.get("yes", 0.5))
        confidence = sanitize_score(req_ans.get("confidence", 0.5))

        scope_ans = answers.get("scope", {})
        scope_probs = scope_ans.get("probabilities", {})
        scope = {
            "project": sanitize_score(scope_probs.get("project", 0.0)),
            "global": sanitize_score(scope_probs.get("global", 0.0)),
            "unknown": sanitize_score(scope_probs.get("unknown", 0.0))
        }

        cat_ans = answers.get("category", {})
        cat_probs = cat_ans.get("probabilities", {})
        cat_confidence = sanitize_score(cat_ans.get("confidence", 0.5))
        categories = {
            "pitfall": sanitize_score(cat_probs.get("pitfall", 0.0)),
            "decision": sanitize_score(cat_probs.get("decision", 0.0)),
            "knowledge": sanitize_score(cat_probs.get("knowledge", 0.0))
        }

        return {
            "requires_memory": requires_memory,
            "confidence": confidence,
            "category_confidence": cat_confidence,
            "scope": scope,
            "categories": categories
        }


def create_backend(backend_type: str, model_name: Optional[str] = None) -> BaseBackend:
    if backend_type == "mock" or os.environ.get("LAYA_MOCK_BACKEND") == "1":
        return MockBackend(model_name or "mock-model")

    is_apple_silicon = sys.platform == "darwin" and os.uname().machine == "arm64"

    if backend_type == "auto":
        backend_type = "mlx" if is_apple_silicon else "pytorch"

    if backend_type == "mlx":
        return MlxBackend(model_name or "aac6fef/laya-multilingual-mlx")
    elif backend_type == "pytorch":
        return PyTorchBackend(model_name or "convaiinnovations/laya-multilingual")
    else:
        raise ValueError(f"Unknown backend type: {backend_type}")


class LayaRequestHandler(BaseHTTPRequestHandler):
    server: LayaServer

    def setup(self) -> None:
        super().setup()
        # Set socket timeout on client connection to prevent slowloris/hung client attacks
        self.request.settimeout(10.0)

    def handle(self) -> None:
        acquired = self.server.connection_semaphore.acquire(blocking=False)
        if not acquired:
            self._send_json(503, {"error": "server_overloaded"})
            return
        try:
            super().handle()
        finally:
            self.server.connection_semaphore.release()

    def log_message(self, format: str, *args: Any) -> None:
        # Suppress request logging to avoid token leakage in stderr/stdout
        pass

    def _verify_auth(self) -> bool:
        auth_header = self.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return False
        provided_token = auth_header[7:].strip()
        # Constant-time comparison prevents timing attacks
        return secrets.compare_digest(provided_token, self.server.auth_token)

    def _send_json(self, status: int, data: Dict[str, Any]) -> None:
        try:
            body = json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (ValueError, TypeError):
            body = b'{"error":"invalid_numerical_output"}'
            status = 500

        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send_json(404, {"error": "not_found"})
            return

        if not self._verify_auth():
            self._send_json(401, {"error": "unauthorized"})
            return

        backend = self.server.backend
        status_info = {
            "service": SERVICE_IDENTITY,
            "status": "ok",
            "api_version": API_VERSION,
            "model_status": backend.status if backend else "loading",
            "capabilities": ["recall", "scope"],
            "backend": getattr(backend, "backend_type", "unknown"),
            "model": backend.model_name if backend else None,
            "instance_id": self.server.instance_id
        }
        self._send_json(200, status_info)

    def do_POST(self) -> None:
        if self.path == "/shutdown":
            if not self._verify_auth():
                self._send_json(401, {"error": "unauthorized"})
                return

            content_length_header = self.headers.get("Content-Length")
            if not content_length_header:
                self._send_json(400, {"error": "missing_content_length"})
                return

            try:
                length = int(content_length_header)
            except ValueError:
                self._send_json(400, {"error": "invalid_content_length"})
                return

            if length <= 0 or length > MAX_PAYLOAD_BYTES:
                self._send_json(400, {"error": "invalid_payload_length"})
                return

            try:
                body_bytes = self.rfile.read(length)
                body = json.loads(body_bytes.decode("utf-8"))
            except Exception:
                self._send_json(400, {"error": "invalid_json"})
                return

            if not isinstance(body, dict):
                self._send_json(400, {"error": "payload_must_be_object"})
                return

            req_pid = body.get("pid")
            if req_pid is None or not isinstance(req_pid, int):
                self._send_json(400, {"error": "missing_or_invalid_pid"})
                return
            if req_pid != os.getpid():
                self._send_json(400, {"error": "pid_mismatch"})
                return

            req_instance = body.get("instance_id")
            if req_instance is None or not isinstance(req_instance, str) or not req_instance:
                self._send_json(400, {"error": "missing_or_invalid_instance_id"})
                return
            if not secrets.compare_digest(req_instance, self.server.instance_id):
                self._send_json(400, {"error": "instance_id_mismatch"})
                return

            self._send_json(200, {
                "service": SERVICE_IDENTITY,
                "status": "shutting_down",
                "pid": os.getpid(),
                "instance_id": self.server.instance_id
            })

            def delayed_shutdown() -> None:
                import time
                time.sleep(0.1)
                self.server.shutdown()

            threading.Thread(target=delayed_shutdown, daemon=True).start()
            return

        if self.path != "/judge/recall":
            self._send_json(404, {"error": "not_found"})
            return

        if not self._verify_auth():
            self._send_json(401, {"error": "unauthorized"})
            return

        content_length_header = self.headers.get("Content-Length")
        if not content_length_header:
            self._send_json(400, {"error": "missing_content_length"})
            return

        try:
            content_length = int(content_length_header)
        except ValueError:
            self._send_json(400, {"error": "invalid_content_length"})
            return

        if content_length <= 0:
            self._send_json(400, {"error": "content_length_must_be_positive"})
            return

        if content_length > MAX_PAYLOAD_BYTES:
            self._send_json(413, {"error": "payload_too_large"})
            return

        try:
            payload_bytes = self.rfile.read(content_length)
            payload = json.loads(payload_bytes.decode("utf-8"))
        except Exception:
            self._send_json(400, {"error": "invalid_json"})
            return

        if not isinstance(payload, dict):
            self._send_json(400, {"error": "payload_must_be_object"})
            return

        text = payload.get("text")
        if not isinstance(text, str) or len(text.strip()) == 0:
            self._send_json(400, {"error": "text_must_be_non_empty_string"})
            return

        if len(text) > 2048:
            self._send_json(400, {"error": "text_exceeds_max_length"})
            return

        project_context = payload.get("project_context")
        if project_context is not None:
            if not isinstance(project_context, dict):
                self._send_json(400, {"error": "project_context_must_be_object"})
                return
            project_id = project_context.get("project_id")
            if project_id is not None:
                if not isinstance(project_id, str):
                    self._send_json(400, {"error": "project_id_must_be_string"})
                    return
                if len(project_id) == 0 or len(project_id) > 256 or not PROJECT_ID_REGEX.match(project_id):
                    self._send_json(400, {"error": "invalid_project_id"})
                    return

        # Non-blocking concurrency check: immediately fail with 503 if inference is busy
        acquired = self.server.inference_semaphore.acquire(blocking=False)
        if not acquired:
            self._send_json(503, {"error": "service_busy"})
            return

        try:
            result = self.server.backend.predict(text, project_context)
            self._send_json(200, result)
        except Exception:
            self._send_json(500, {"error": "inference_failed"})
        finally:
            self.server.inference_semaphore.release()


class LayaServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128
    MAX_CONCURRENT_REQUESTS = 16

    def __init__(self, server_address: Tuple[str, int], auth_token: str, backend: BaseBackend, instance_id: str):
        if ":" in server_address[0]:
            self.address_family = socket.AF_INET6
        super().__init__(server_address, LayaRequestHandler)
        self.auth_token = auth_token
        self.backend = backend
        self.instance_id = instance_id
        self.connection_semaphore = threading.Semaphore(self.MAX_CONCURRENT_REQUESTS)
        self.inference_semaphore = threading.Semaphore(1)


def write_atomic_service_file(service_file_path: Path, endpoint: str, token: str, pid: int, instance_id: str) -> None:
    parent_dir = service_file_path.parent
    parent_dir.mkdir(parents=True, exist_ok=True)
    if sys.platform != "win32":
        try:
            os.chmod(parent_dir, 0o700)
        except OSError:
            pass

    if os.path.islink(str(service_file_path)):
        raise PermissionError(f"Security error: target service file {service_file_path} is a symlink")

    tmp_path = parent_dir / f".service.json.tmp.{pid}_{secrets.token_hex(4)}"
    if os.path.islink(str(tmp_path)):
        tmp_path.unlink(missing_ok=True)

    content = {
        "service": SERVICE_IDENTITY,
        "api_version": API_VERSION,
        "endpoint": endpoint,
        "token": token,
        "pid": pid,
        "instance_id": instance_id
    }
    raw = json.dumps(content, indent=2) + "\n"

    # Write temp file and strictly enforce 0600 permissions on POSIX
    tmp_path.write_text(raw, encoding="utf-8")
    if sys.platform != "win32":
        try:
            os.chmod(tmp_path, 0o600)
        except OSError:
            pass

    # Atomic rename replaces existing file safely
    os.replace(tmp_path, service_file_path)


def remove_service_file_if_matched(service_file_path: Path, endpoint: str, token: str, instance_id: str, pid: int) -> None:
    try:
        if not service_file_path.is_file() or os.path.islink(str(service_file_path)):
            return
        data = json.loads(service_file_path.read_text(encoding="utf-8"))
        # Only delete if file still represents THIS process's exact identity
        file_token = data.get("token")
        file_instance = data.get("instance_id")
        if (
            data.get("pid") == pid and
            data.get("endpoint") == endpoint and
            isinstance(file_instance, str) and
            secrets.compare_digest(file_instance, instance_id) and
            isinstance(file_token, str) and
            secrets.compare_digest(file_token, token)
        ):
            service_file_path.unlink(missing_ok=True)
    except Exception:
        pass


def write_atomic_pid_file(pid_file_path: Path, pid: int, instance_id: str) -> None:
    parent_dir = pid_file_path.parent
    parent_dir.mkdir(parents=True, exist_ok=True)
    if sys.platform != "win32":
        try:
            os.chmod(parent_dir, 0o700)
        except OSError:
            pass

    if os.path.islink(str(pid_file_path)):
        raise PermissionError(f"Security error: target pid file {pid_file_path} is a symlink")

    tmp_path = parent_dir / f".daemon.pid.tmp.{pid}_{secrets.token_hex(4)}"
    if os.path.islink(str(tmp_path)):
        tmp_path.unlink(missing_ok=True)

    content = {
        "pid": pid,
        "instance_id": instance_id
    }
    raw = json.dumps(content, indent=2) + "\n"

    tmp_path.write_text(raw, encoding="utf-8")
    if sys.platform != "win32":
        try:
            os.chmod(tmp_path, 0o600)
        except OSError:
            pass

    os.replace(tmp_path, pid_file_path)


def remove_pid_file_if_matched(pid_file_path: Path, pid: int, instance_id: str) -> None:
    try:
        if not pid_file_path.is_file() or os.path.islink(str(pid_file_path)):
            return
        raw = pid_file_path.read_text(encoding="utf-8").strip()
        if raw.startswith("{"):
            data = json.loads(raw)
            file_instance = data.get("instance_id")
            if (
                data.get("pid") == pid and
                isinstance(file_instance, str) and
                secrets.compare_digest(file_instance, instance_id)
            ):
                pid_file_path.unlink(missing_ok=True)
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Laya Memory Judge local adapter service")
    parser.add_argument("--backend", choices=["auto", "mlx", "pytorch", "mock"], default="auto",
                        help="Backend engine to use (default: auto)")
    parser.add_argument("--model", type=str, default=None,
                        help="Model checkpoint path or repo ID")
    parser.add_argument("--host", type=str, default="127.0.0.1",
                        help="Loopback address to bind (strictly 127.0.0.1 or ::1)")
    parser.add_argument("--port", type=int, default=0,
                        help="Port to bind (default: 0 for dynamic ephemeral port)")
    parser.add_argument("--service-file", type=str, default=None,
                        help="Path to service.json (default: ~/.laya/service.json)")
    parser.add_argument("--token-file", type=str, default=None,
                        help="Path to temporary file containing auth token (read and deleted immediately)")
    parser.add_argument("--token", type=str, default=None,
                        help="Secret Bearer token (deprecated; use --token-file or LAYA_AUTH_TOKEN)")
    parser.add_argument("--pid-file", type=str, default=None,
                        help="Path to write PID file")

    args = parser.parse_args()

    # Enforce strict loopback contract: only 127.0.0.1 or ::1 are allowed
    clean_host = args.host.strip().lower()
    if clean_host not in ALLOWED_LOOPBACK_HOSTS:
        sys.stderr.write(f"Error: Host '{args.host}' is not a permitted loopback address. Only 127.0.0.1 or ::1 are allowed.\n")
        sys.exit(2)

    # Determine service file path safely (rejecting symlinks prior to any dereferencing)
    if args.service_file:
        service_file_path = check_no_symlink(args.service_file, "service-file")
    else:
        service_file_path = check_no_symlink(os.path.join(os.path.expanduser("~"), ".laya", "service.json"), "service-file")

    # Resolve token securely:
    # 1. Read from protected --token-file if provided, and delete immediately
    # 2. Else read from LAYA_AUTH_TOKEN environment variable
    # 3. Else fallback to --token if provided (e.g. tests)
    # 4. Else generate secure random 32-byte hex token
    token: Optional[str] = None
    if args.token_file:
        token_path = check_no_symlink(args.token_file, "token-file")
        if token_path.is_file():
            token = token_path.read_text(encoding="utf-8").strip()
            try:
                token_path.unlink()
            except Exception:
                pass

    if not token:
        token = os.environ.get("LAYA_AUTH_TOKEN")
    if not token:
        token = args.token
    if not token:
        token = secrets.token_hex(32)

    instance_id = secrets.token_hex(16)

    # Initialize backend
    backend = create_backend(args.backend, args.model)

    # Start HTTP server on loopback address
    server = LayaServer((clean_host, args.port), token, backend, instance_id)
    bound_host, bound_port = server.server_address[:2]
    if ":" in str(bound_host):
        endpoint = f"http://[{bound_host}]:{bound_port}"
    else:
        endpoint = f"http://{bound_host}:{bound_port}"

    pid = os.getpid()

    # Write service.json atomically
    write_atomic_service_file(service_file_path, endpoint, token, pid, instance_id)

    # Write PID file if requested
    pid_file_path: Optional[Path] = None
    if args.pid_file:
        pid_file_path = check_no_symlink(args.pid_file, "pid-file")
        write_atomic_pid_file(pid_file_path, pid, instance_id)

    # Cleanup handler ensures we clean up only our own service and pid file
    def cleanup() -> None:
        remove_service_file_if_matched(service_file_path, endpoint, token, instance_id, pid)
        if pid_file_path:
            remove_pid_file_if_matched(pid_file_path, pid, instance_id)

    atexit.register(cleanup)

    def sig_handler(signum: int, frame: Any) -> None:
        cleanup()
        sys.exit(0)

    try:
        signal.signal(signal.SIGINT, sig_handler)
        signal.signal(signal.SIGTERM, sig_handler)
    except (ValueError, AttributeError):
        pass

    # Print readiness notification to stdout (never printing the token!)
    sys.stdout.write(f"Laya service listening on {endpoint} (PID: {pid}, Backend: {backend.backend_type})\n")
    sys.stdout.flush()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
        cleanup()


if __name__ == "__main__":
    main()
