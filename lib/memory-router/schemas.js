export class SchemaValidationError extends TypeError {
  constructor(message) {
    super(`Laya Schema Validation Error: ${message}`);
    this.name = "SchemaValidationError";
  }
}

const ALLOWED_SCOPES = new Set(["project", "global", "unknown"]);

function isObject(val) {
  return val !== null && typeof val === "object" && !Array.isArray(val);
}

function isScore(val) {
  return typeof val === "number" && !Number.isNaN(val) && val >= 0.0 && val <= 1.0;
}

const ALLOWED_HEALTH_STATUSES = new Set(["ok", "degraded"]);
const ALLOWED_MODEL_STATUSES = new Set(["ready", "loading", "unloaded"]);
const ALLOWED_RELATIONS = new Set(["support", "extension", "duplicate", "conflict", "supersession", "unrelated"]);

export function validateCaptureResponse(data) {
  if (!isObject(data) || !isScore(data.capture_score) || !isScore(data.confidence)) {
    throw new SchemaValidationError("capture response scores must be numbers between 0.0 and 1.0");
  }
  if (!["pitfall", "decision", "knowledge"].includes(data.category) || !ALLOWED_SCOPES.has(data.scope)) {
    throw new SchemaValidationError("capture response category or scope is invalid");
  }
  return { captureScore: data.capture_score, confidence: data.confidence, category: data.category, scope: data.scope };
}

export function validateRelationResponse(data) {
  if (!isObject(data) || !ALLOWED_RELATIONS.has(data.relation) || !isScore(data.confidence)) {
    throw new SchemaValidationError("relation response must contain an allowed relation and confidence score");
  }
  return { relation: data.relation, confidence: data.confidence };
}

export function validateHealthResponse(data) {
  if (!isObject(data)) {
    throw new SchemaValidationError("health response must be a JSON object");
  }
  if (data.service !== "laya-memory-judge") {
    throw new SchemaValidationError("service identity mismatch");
  }
  if (typeof data.status !== "string" || !ALLOWED_HEALTH_STATUSES.has(data.status)) {
    throw new SchemaValidationError("health status must be 'ok' or 'degraded'");
  }
  const apiVersion = data.api_version ?? data.apiVersion;
  if (apiVersion !== "1") {
    throw new SchemaValidationError("api_version mismatch");
  }
  const modelStatus = data.model_status ?? data.modelStatus;
  if (typeof modelStatus !== "string" || !ALLOWED_MODEL_STATUSES.has(modelStatus)) {
    throw new SchemaValidationError("model_status must be 'ready', 'loading', or 'unloaded'");
  }
  if (!Array.isArray(data.capabilities) || !data.capabilities.includes("recall")) {
    throw new SchemaValidationError("capabilities must be an array containing 'recall'");
  }
  const idleUnloadSeconds = data.idle_unload_seconds ?? data.idleUnloadSeconds ?? null;
  if (idleUnloadSeconds !== null && (!Number.isInteger(idleUnloadSeconds) || idleUnloadSeconds < 0 || idleUnloadSeconds > 86400)) {
    throw new SchemaValidationError("idle_unload_seconds must be an integer between 0 and 86400 when provided");
  }

  let instanceId = null;
  const rawInstance = data.instance_id ?? data.instanceId;
  if (rawInstance !== undefined && rawInstance !== null) {
    if (typeof rawInstance !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(rawInstance)) {
      throw new SchemaValidationError("invalid instance_id format");
    }
    instanceId = rawInstance;
  }

  return {
    service: data.service,
    status: data.status,
    apiVersion: "1",
    modelStatus,
    idleUnloadSeconds,
    capabilities: data.capabilities,
    backend: typeof data.backend === "string" ? data.backend : null,
    model: typeof data.model === "string" ? data.model : null,
    recall_head: recallHeadInfo(data.recall_head),
    instanceId,
    instance_id: instanceId
  };
}

// Display-only description of the trained recall head the service loaded (null when zero-shot).
function recallHeadInfo(value) {
  if (!isObject(value) || typeof value.path !== "string" || !value.path || value.path.length > 1024) return null;
  return {
    path: value.path,
    trained_at: typeof value.trained_at === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.trained_at) ? value.trained_at : null,
    prompts: Number.isInteger(value.prompts) && value.prompts >= 0 ? value.prompts : null
  };
}

export function validateRecallResponse(data) {
  if (!isObject(data)) {
    throw new SchemaValidationError("recall response must be a JSON object");
  }
  if (!isScore(data.requires_memory)) {
    throw new SchemaValidationError("requires_memory must be a number between 0.0 and 1.0");
  }
  if (!isScore(data.confidence)) {
    throw new SchemaValidationError("confidence must be a number between 0.0 and 1.0");
  }

  const filteredScope = {};
  let bestScopeKey = null;
  let maxScopeScore = -1;

  if (isObject(data.scope)) {
    for (const [k, v] of Object.entries(data.scope)) {
      // Filter out any key not in ALLOWED_SCOPES (prevents prompt injection & disallows auto shared)
      if (ALLOWED_SCOPES.has(k) && isScore(v)) {
        filteredScope[k] = v;
        if (v > maxScopeScore) {
          maxScopeScore = v;
          bestScopeKey = k;
        }
      }
    }
  }

  // Strictly map to fixed enum: "global" or "project" (unknown defaults to project)
  const safeScope = bestScopeKey === "global" ? "global" : "project";

  const categories = data.categories ?? data.memory_type;
  const filteredCategories = {};
  if (isObject(categories)) {
    for (const [k, v] of Object.entries(categories)) {
      if (typeof k === "string" && k.length <= 64 && /^[a-zA-Z0-9_-]+$/u.test(k) && isScore(v)) {
        filteredCategories[k] = v;
      }
    }
  }

  const categoryConfidence = isScore(data.category_confidence)
    ? data.category_confidence
    : (isScore(data.categoryConfidence) ? data.categoryConfidence : data.confidence);

  return {
    requiresMemory: data.requires_memory,
    confidence: data.confidence,
    categoryConfidence,
    scope: filteredScope,
    bestScope: safeScope,
    categories: filteredCategories
  };
}
