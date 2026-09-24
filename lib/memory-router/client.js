import { validateLoopbackEndpoint } from "./security.js";
import { validateHealthResponse, validateRecallResponse, validateCaptureResponse, validateRelationResponse, SchemaValidationError } from "./schemas.js";
import http from "node:http";

export class LayaHttpError extends Error {
  constructor(message, { status = 0, permanent = false, auth = false } = {}) {
    super(message);
    this.name = "LayaHttpError";
    this.status = status;
    this.permanent = permanent;
    this.auth = auth;
  }
}

async function readBoundedJson(response, maxBytes) {
  const contentLength = response.headers?.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new LayaHttpError("Laya response exceeds maximum allowed size", { permanent: false });
  }

  // 1. Web ReadableStream (stream-based bounded reader for chunked/streaming responses)
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          try { await reader.cancel("Response body exceeded limit"); } catch {}
          throw new LayaHttpError("Laya response exceeds maximum allowed size", { permanent: false });
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8").decode(merged);
    try {
      return JSON.parse(text);
    } catch {
      throw new LayaHttpError("Laya response was not valid JSON", { permanent: true });
    }
  }

  // 2. arrayBuffer fallback
  if (typeof response.arrayBuffer === "function") {
    const buf = await response.arrayBuffer();
    if (buf.byteLength > maxBytes) {
      throw new LayaHttpError("Laya response exceeds maximum allowed size", { permanent: false });
    }
    const text = new TextDecoder("utf-8").decode(buf);
    try {
      return JSON.parse(text);
    } catch {
      throw new LayaHttpError("Laya response was not valid JSON", { permanent: true });
    }
  }

  // 3. text fallback checking UTF-8 byte length
  const text = await response.text();
  const byteLength = Buffer.byteLength(text, "utf8");
  if (byteLength > maxBytes) {
    throw new LayaHttpError("Laya response exceeds maximum allowed size", { permanent: false });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LayaHttpError("Laya response was not valid JSON", { permanent: true });
  }
}

// Send project_context only when it carries a real project id. A null/empty id used to reach
// the model as the literal string "None" and changed its verdict (OpenClaw without projectId).
export function normalizeProjectContext(projectContext) {
  const projectId = projectContext?.project_id;
  if (typeof projectId !== "string" || projectId.trim() === "") return null;
  return { project_context: { project_id: projectId } };
}

export function truncateForInference(text, maxChars = 2048) {
  if (typeof text !== "string") return "";
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 5) / 2);
  return `${text.slice(0, half)}\n...\n${text.slice(-half)}`;
}

export class LayaClient {
  constructor(endpoint, options = {}) {
    if (typeof endpoint === "string" && endpoint.startsWith("uds:")) {
      this.socketPath = endpoint.slice(4);
      if (!this.socketPath.startsWith("/") || this.socketPath.includes("\0")) throw new TypeError("Invalid trusted UDS endpoint");
      this.endpoint = endpoint;
    } else {
      this.endpoint = validateLoopbackEndpoint(endpoint);
      this.socketPath = null;
    }
    this.token = typeof options.token === "string" && options.token ? options.token : null;
    this.fetch = options.fetch ?? globalThis.fetch;
    this.AbortController = options.AbortController ?? globalThis.AbortController;
    this.timers = options.timers ?? {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout
    };
    this.maxResponseBytes = options.maxResponseBytes ?? 65536;
    this.logger = options.logger ?? null;
  }

  async _request(path, { method = "GET", body = null, timeout = 1000 } = {}) {
    if (this.socketPath) return this._requestUds(path, { method, body, timeout });
    const url = new URL(path, this.endpoint).toString();
    const controller = new this.AbortController();
    const timeoutId = this.timers.setTimeout(() => {
      controller.abort(new Error(`Laya request timeout after ${timeout}ms`));
    }, timeout);

    if (typeof timeoutId?.unref === "function") {
      timeoutId.unref();
    }

    try {
      const headers = {
        Accept: "application/json"
      };
      if (body !== null) {
        headers["Content-Type"] = "application/json; charset=utf-8";
      }
      if (this.token) {
        headers.Authorization = `Bearer ${this.token}`;
      }

      let response;
      try {
        response = await this.fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : null,
          signal: controller.signal,
          redirect: "manual"
        });
      } catch (err) {
        if (err?.name === "AbortError" || controller.signal.aborted) {
          throw new LayaHttpError(`Laya request timed out (${timeout}ms)`, { status: 0 });
        }
        throw new LayaHttpError("Laya connection error", { status: 0 });
      }

      // Prohibit HTTP redirects
      if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
        throw new LayaHttpError("Laya request rejected: HTTP redirects are forbidden", {
          status: response.status,
          permanent: true
        });
      }

      if (!response.ok) {
        const isAuth = response.status === 401 || response.status === 403;
        const isPermanent = isAuth || response.status === 400 || response.status === 404 || response.status === 422;
        throw new LayaHttpError(`Laya HTTP ${response.status}`, {
          status: response.status,
          permanent: isPermanent,
          auth: isAuth
        });
      }

      return await readBoundedJson(response, this.maxResponseBytes);
    } finally {
      this.timers.clearTimeout(timeoutId);
    }
  }

  async _requestUds(path, { method, body, timeout }) {
    return new Promise((resolve, reject) => {
      const headers = { Accept: "application/json" };
      let payload = null;
      if (body !== null) {
        payload = JSON.stringify(body);
        headers["Content-Type"] = "application/json; charset=utf-8";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const req = http.request({ socketPath: this.socketPath, path, method, headers }, (res) => {
        const chunks = [];
        let total = 0;
        res.on("data", (chunk) => {
          total += chunk.length;
          if (total > this.maxResponseBytes) {
            req.destroy(new LayaHttpError("Laya response exceeds maximum allowed size"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          if (res.statusCode >= 300 && res.statusCode < 400) return reject(new LayaHttpError("Laya request rejected: HTTP redirects are forbidden", { status: res.statusCode, permanent: true }));
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const auth = res.statusCode === 401 || res.statusCode === 403;
            return reject(new LayaHttpError(`Laya HTTP ${res.statusCode}`, { status: res.statusCode, permanent: auth || [400, 404, 422].includes(res.statusCode), auth }));
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { reject(new LayaHttpError("Laya response was not valid JSON", { permanent: true })); }
        });
      });
      req.setTimeout(timeout, () => req.destroy(new LayaHttpError(`Laya request timed out (${timeout}ms)`)));
      req.on("error", (err) => reject(err instanceof LayaHttpError ? err : new LayaHttpError("Laya connection error")));
      if (payload) req.write(payload);
      req.end();
    });
  }

  async healthCheck({ timeout = 200 } = {}) {
    const raw = await this._request("/health", { method: "GET", timeout });
    try {
      return validateHealthResponse(raw);
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        throw new LayaHttpError(err.message, { permanent: true });
      }
      throw err;
    }
  }

  /** Ask the service to load an unloaded model in the background. Returns the health-shaped status. */
  async warmup({ timeout = 500 } = {}) {
    const raw = await this._request("/warmup", { method: "POST", body: {}, timeout });
    try {
      return { ...validateHealthResponse(raw), warming: raw?.warming === true };
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        throw new LayaHttpError(err.message, { permanent: true });
      }
      throw err;
    }
  }

  async judgeRecall({ text, projectContext = null, timeout = 1000 } = {}) {
    const payload = {
      text: truncateForInference(text, 2048),
      ...(normalizeProjectContext(projectContext) ?? {})
    };
    const raw = await this._request("/judge/recall", {
      method: "POST",
      body: payload,
      timeout
    });
    try {
      return validateRecallResponse(raw);
    } catch (err) {
      if (err instanceof SchemaValidationError) {
        throw new LayaHttpError(err.message, { permanent: true });
      }
      throw err;
    }
  }

  async judgeCapture({ text, timeout = 1000 } = {}) {
    if (typeof text !== "string" || !text.trim() || text.length > 2048) throw new LayaHttpError("Capture input must be non-empty and at most 2048 characters", { permanent: true });
    const raw = await this._request("/judge/capture", {
      method: "POST",
      body: { text },
      timeout
    });
    try { return validateCaptureResponse(raw); }
    catch (err) {
      if (err instanceof SchemaValidationError) throw new LayaHttpError(err.message, { permanent: true });
      throw err;
    }
  }

  async judgeRelation({ candidate, existing, timeout = 1000 } = {}) {
    if (typeof candidate !== "string" || typeof existing !== "string" || !candidate.trim() || !existing.trim() || candidate.length > 2048 || existing.length > 2048) {
      throw new LayaHttpError("Relation excerpts must be non-empty and at most 2048 characters each", { permanent: true });
    }
    const raw = await this._request("/judge/relation", {
      method: "POST",
      body: { candidate, existing },
      timeout
    });
    try { return validateRelationResponse(raw); }
    catch (err) {
      if (err instanceof SchemaValidationError) throw new LayaHttpError(err.message, { permanent: true });
      throw err;
    }
  }

  async shutdown({ pid, instanceId, timeout = 4000 } = {}) {
    return this._request("/shutdown", { method: "POST", body: { pid, instance_id: instanceId }, timeout });
  }
}
