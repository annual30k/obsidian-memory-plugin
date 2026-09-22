import { validateLoopbackEndpoint } from "./security.js";
import { validateHealthResponse, validateRecallResponse, SchemaValidationError } from "./schemas.js";

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

export function truncateForInference(text, maxChars = 2048) {
  if (typeof text !== "string") return "";
  if (text.length <= maxChars) return text;
  const half = Math.floor((maxChars - 5) / 2);
  return `${text.slice(0, half)}\n...\n${text.slice(-half)}`;
}

export class LayaClient {
  constructor(endpoint, options = {}) {
    this.endpoint = validateLoopbackEndpoint(endpoint);
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

  async judgeRecall({ text, projectContext = null, timeout = 1000 } = {}) {
    const payload = {
      text: truncateForInference(text, 2048),
      ...(projectContext ? { project_context: projectContext } : {})
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
}
