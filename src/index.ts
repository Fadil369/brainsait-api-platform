/**
 * BrainSAIT API Platform — unified API gateway for the entire ecosystem.
 *
 * One endpoint, every capability:
 *   GET  /v1/verify/{spid}        → OID provider verification
 *   GET  /v1/search?q=...         → Clinical RAG search
 *   GET  /v1/claims/rejections    → Top rejection codes
 *   GET  /v1/claims/analyze?code=X → Specific rejection analysis
 *   POST /v1/voice/speak          → ElevenLabs TTS
 *   POST /v1/chat                 → Intent detection + orchestration
 *   GET  /v1/health               → System health
 *   GET  /v1/usage                → API key usage stats
 *   GET  /docs                    → OpenAPI documentation
 *
 * Auth: Bearer token (API key from KV)
 * Rate limiting: per-plan (Free/Pro/Enterprise)
 * Analytics: every call logged to Analytics Engine
 */

export interface Env {
  AI: Ai;
  AI_SEARCH: AiSearchNamespace;
  HIS_DB: D1Database;
  WAE: AnalyticsEngineDataset;
  API_KEYS: KVNamespace;
}

// ---- Plans ----

interface Plan {
  name: string;
  rateLimit: number; // requests per minute
  dailyLimit: number;
  features: string[];
}

const PLANS: Record<string, Plan> = {
  free: { name: "Free", rateLimit: 10, dailyLimit: 100, features: ["search"] },
  pro: { name: "Pro", rateLimit: 100, dailyLimit: 10000, features: ["search", "verify", "claims"] },
  enterprise: { name: "Enterprise", rateLimit: 1000, dailyLimit: -1, features: ["search", "verify", "claims", "voice", "chat"] },
};

// ---- API Key Management ----

async function validateApiKey(env: Env, key: string): Promise<{ valid: boolean; plan?: string; error?: string }> {
  if (!key) return { valid: false, error: "Missing Authorization header" };
  const stored = await env.API_KEYS.get(`apikey:${key}`);
  if (!stored) return { valid: false, error: "Invalid API key" };
  try {
    const data = JSON.parse(stored);
    return { valid: true, plan: data.plan || "free" };
  } catch {
    return { valid: false, error: "Invalid key data" };
  }
}

// ---- Rate Limiting (in-memory, per-isolate) ----

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(key: string, limit: number): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + 60000 });
    return { allowed: true, remaining: limit - 1, resetAt: now + 60000 };
  }
  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count++;
  return { allowed: true, remaining: limit - entry.count, resetAt: entry.resetAt };
}

// ---- Analytics ----

function track(env: Env, data: { endpoint: string; method: string; plan: string; status: number; latencyMs: number; keyId: string }) {
  env.WAE.writeDataPoint({
    blobs: [data.endpoint, data.method, data.plan, data.keyId],
    doubles: [data.status, data.latencyMs, Date.now()],
  });
}

// ---- Backend Calls ----

const RAG_URL = "https://brainsait-clinical-rag.brainsait-fadil.workers.dev";
const OID_URL = "https://oid-line.brainsait-fadil.workers.dev";
const AGENT_URL = "https://copilot.brainsait.org";

async function ragSearch(query: string): Promise<any> {
  const res = await fetch(`${RAG_URL}/search?q=${encodeURIComponent(query)}`);
  return res.json();
}

async function oidVerify(spid: string): Promise<any> {
  const res = await fetch(`${OID_URL}/v1/verify/${spid}`);
  return res.json();
}

async function claimsRejections(): Promise<any> {
  const res = await fetch(`${AGENT_URL}/claims?q=top`);
  return res.json();
}

async function claimsAnalyze(code: string): Promise<any> {
  const res = await fetch(`${AGENT_URL}/claims?q=${encodeURIComponent(code)}`);
  return res.json();
}

async function voiceSpeak(text: string): Promise<Response> {
  const res = await fetch(`${AGENT_URL}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return res;
}

async function agentChat(query: string): Promise<any> {
  const res = await fetch(`${AGENT_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, speak: false }),
  });
  return res.json();
}

// ---- OpenAPI Docs ----

function openApiDocs(): object {
  return {
    openapi: "3.0.3",
    info: {
      title: "BrainSAIT API",
      version: "1.0.0",
      description: "Unified API for healthcare provider verification, clinical knowledge search, claim analysis, and voice AI. Powered by BrainSAIT OID, AI Search, and ElevenLabs.",
      contact: { name: "BrainSAIT", url: "https://brainsait.org" },
      license: { name: "Proprietary" },
    },
    servers: [
      { url: "https://api.brainsait.org", description: "Production" },
    ],
    security: [{ BearerAuth: [] }],
    paths: {
      "/v1/health": {
        get: {
          summary: "System health",
          tags: ["System"],
          security: [],
          responses: { "200": { description: "Health status" } },
        },
      },
      "/v1/verify/{spid}": {
        get: {
          summary: "Verify healthcare provider",
          tags: ["Identity"],
          parameters: [
            { name: "spid", in: "path", required: true, schema: { type: "string" }, description: "Provider SPID (e.g. SA-PHY-000001)" },
          ],
          responses: { "200": { description: "Verification result" } },
        },
      },
      "/v1/search": {
        get: {
          summary: "Search clinical knowledge base",
          tags: ["Clinical"],
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" }, description: "Search query (AR/EN)" },
          ],
          responses: { "200": { description: "Search results" } },
        },
      },
      "/v1/claims/rejections": {
        get: {
          summary: "Top rejection codes",
          tags: ["Claims"],
          responses: { "200": { description: "Rejection code list" } },
        },
      },
      "/v1/claims/analyze": {
        get: {
          summary: "Analyze rejection code",
          tags: ["Claims"],
          parameters: [
            { name: "code", in: "query", required: true, schema: { type: "string" }, description: "Rejection code (e.g. AD-1-9)" },
          ],
          responses: { "200": { description: "Analysis result" } },
        },
      },
      "/v1/voice/speak": {
        post: {
          summary: "Text-to-speech",
          tags: ["Voice"],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } } },
          },
          responses: { "200": { description: "Audio/mpeg" } },
        },
      },
      "/v1/chat": {
        post: {
          summary: "Unified chat (intent detection + orchestration)",
          tags: ["AI"],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } },
          },
          responses: { "200": { description: "Chat response" } },
        },
      },
      "/v1/usage": {
        get: {
          summary: "API key usage stats",
          tags: ["Account"],
          responses: { "200": { description: "Usage statistics" } },
        },
      },
    },
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          description: "BrainSAIT API key (get from dashboard.brainsait.org)",
        },
      },
    },
  };
}

// ---- Main Handler ----

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const started = Date.now();

    // CORS
    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
      });
    }

    // OpenAPI docs (no auth required)
    if (path === "/docs" || path === "/docs/") {
      return Response.json(openApiDocs());
    }

    // Health (no auth required)
    if (path === "/v1/health") {
      return Response.json({
        ok: true,
        service: "brainsait-api-platform",
        version: "1.0.0",
        status: "live",
        endpoints: ["/v1/health", "/v1/verify/{spid}", "/v1/search", "/v1/claims/rejections", "/v1/claims/analyze", "/v1/voice/speak", "/v1/chat", "/v1/usage", "/docs"],
      });
    }

    // Auth check for all other endpoints
    const authHeader = request.headers.get("Authorization") || "";
    const apiKey = authHeader.replace(/^Bearer\s+/i, "").trim();
    const authResult = await validateApiKey(env, apiKey);
    if (!authResult.valid) {
      return Response.json({ ok: false, error: authResult.error }, { status: 401 });
    }

    const plan = authResult.plan || "free";
    const planConfig = PLANS[plan] || PLANS.free;
    const keyId = `key:${apiKey.slice(0, 8)}...`;

    // Rate limiting
    const rl = checkRateLimit(keyId, planConfig.rateLimit);
    const rateHeaders: Record<string, string> = {
      "X-RateLimit-Limit": String(planConfig.rateLimit),
      "X-RateLimit-Remaining": String(rl.remaining),
      "X-RateLimit-Reset": String(Math.ceil(rl.resetAt / 1000)),
      "X-Plan": plan,
    };

    if (!rl.allowed) {
      track(env, { endpoint: path, method, plan, status: 429, latencyMs: Date.now() - started, keyId });
      return Response.json({ ok: false, error: "Rate limit exceeded", retryAfter: Math.ceil((rl.resetAt - Date.now()) / 1000) }, { status: 429, headers: rateHeaders });
    }

    // Route to endpoint
    let response: Response;
    let status = 200;

    try {
      // Verify provider
      if (path.startsWith("/v1/verify/")) {
        if (!planConfig.features.includes("verify")) {
          status = 403;
          return Response.json({ ok: false, error: "verify not included in your plan", upgrade: "https://store.brainsait.de/products/oid-explorer-seat" }, { status: 403, headers: rateHeaders });
        }
        const spid = path.split("/v1/verify/")[1];
        const result = await oidVerify(spid);
        response = Response.json(result, { headers: rateHeaders });
      }
      // Clinical search
      else if (path === "/v1/search") {
        const query = url.searchParams.get("q") || "";
        if (!query) { status = 400; return Response.json({ ok: false, error: "q required" }, { status: 400, headers: rateHeaders }); }
        if (!planConfig.features.includes("search")) {
          status = 403;
          return Response.json({ ok: false, error: "search not included in your plan" }, { status: 403, headers: rateHeaders });
        }
        const result = await ragSearch(query);
        response = Response.json(result, { headers: rateHeaders });
      }
      // Claims rejections
      else if (path === "/v1/claims/rejections") {
        if (!planConfig.features.includes("claims")) {
          status = 403;
          return Response.json({ ok: false, error: "claims not included in your plan", upgrade: "https://store.brainsait.de/products/oid-explorer-seat" }, { status: 403, headers: rateHeaders });
        }
        const result = await claimsRejections();
        response = Response.json(result, { headers: rateHeaders });
      }
      // Claims analyze
      else if (path === "/v1/claims/analyze") {
        if (!planConfig.features.includes("claims")) {
          status = 403;
          return Response.json({ ok: false, error: "claims not included in your plan" }, { status: 403, headers: rateHeaders });
        }
        const code = url.searchParams.get("code") || "";
        if (!code) { status = 400; return Response.json({ ok: false, error: "code required" }, { status: 400, headers: rateHeaders }); }
        const result = await claimsAnalyze(code);
        response = Response.json(result, { headers: rateHeaders });
      }
      // Voice speak
      else if (path === "/v1/voice/speak" && method === "POST") {
        if (!planConfig.features.includes("voice")) {
          status = 403;
          return Response.json({ ok: false, error: "voice not included in your plan", upgrade: "https://store.brainsait.de/products/oid-white-label-enterprise-1" }, { status: 403, headers: rateHeaders });
        }
        const body = await request.json().catch(() => ({})) as any;
        const text = body.text || "";
        if (!text) { status = 400; return Response.json({ ok: false, error: "text required" }, { status: 400, headers: rateHeaders }); }
        const audioRes = await voiceSpeak(text);
        if (!audioRes.ok) { status = 502; return Response.json({ ok: false, error: "TTS service unavailable" }, { status: 502, headers: rateHeaders }); }
        response = new Response(audioRes.body, {
          headers: { ...rateHeaders, "Content-Type": "audio/mpeg", "Content-Disposition": 'attachment; filename="speech.mp3"' },
        });
      }
      // Chat
      else if (path === "/v1/chat" && method === "POST") {
        if (!planConfig.features.includes("chat")) {
          status = 403;
          return Response.json({ ok: false, error: "chat not included in your plan", upgrade: "https://store.brainsait.de/products/oid-white-label-enterprise-1" }, { status: 403, headers: rateHeaders });
        }
        const body = await request.json().catch(() => ({})) as any;
        const query = body.query || "";
        if (!query) { status = 400; return Response.json({ ok: false, error: "query required" }, { status: 400, headers: rateHeaders }); }
        const result = await agentChat(query);
        response = Response.json(result, { headers: rateHeaders });
      }
      // Usage stats
      else if (path === "/v1/usage") {
        const dailyKey = `usage:${keyId}:${new Date().toISOString().slice(0, 10)}`;
        const usage = await env.API_KEYS.get(dailyKey);
        const count = usage ? parseInt(usage) : 0;
        response = Response.json({
          ok: true,
          keyId,
          plan,
          dailyUsage: count,
          dailyLimit: planConfig.dailyLimit,
          features: planConfig.features,
        }, { headers: rateHeaders });
      }
      // 404
      else {
        status = 404;
        response = Response.json({
          ok: false,
          error: "Not found",
          available: ["/v1/health", "/v1/verify/{spid}", "/v1/search", "/v1/claims/rejections", "/v1/claims/analyze", "/v1/voice/speak", "/v1/chat", "/v1/usage", "/docs"],
        }, { status: 404, headers: rateHeaders });
      }
    } catch (e: any) {
      status = 500;
      response = Response.json({ ok: false, error: "Internal error", message: e.message?.slice(0, 200) }, { status: 500, headers: rateHeaders });
    }

    // Track analytics
    const latencyMs = Date.now() - started;
    track(env, { endpoint: path, method, plan, status, latencyMs, keyId });

    // Increment daily usage
    try {
      const dailyKey = `usage:${keyId}:${new Date().toISOString().slice(0, 10)}`;
      const current = await env.API_KEYS.get(dailyKey);
      const count = current ? parseInt(current) + 1 : 1;
      await env.API_KEYS.put(dailyKey, String(count), { expirationTtl: 86400 * 2 });
    } catch { /* best-effort */ }

    return response;
  },
};
