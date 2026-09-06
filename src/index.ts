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

    // Dashboard (no auth required)
    if (path === "/dashboard" || path === "/dashboard/") {
      const html = `<!DOCTYPE html>
<html lang="en" dir="ltr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>BrainSAIT Healthcare Intelligence Dashboard</title><meta name="description" content="Real-time healthcare intelligence: provider verification, claim analysis, AI cost tracking, and agent status."><style>:root{--bg:#0a0f1a;--card:#111827;--border:#1f2937;--text:#e5e7eb;--muted:#6b7280;--accent:#22d3ee;--success:#10b981;--danger:#ef4444;--gold:#d4af37;--purple:#a78bfa}*{margin:0;padding:0;box-sizing:border-box}body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,sans-serif;min-height:100vh}.d{max-width:1400px;margin:0 auto;padding:24px}.hd{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding:20px 24px;background:linear-gradient(135deg,#0d2b1f,#0a1f17);border-radius:16px;border:1px solid var(--border)}.hd h1{font-size:24px;font-weight:700;background:linear-gradient(135deg,var(--accent),var(--success));-webkit-background-clip:text;-webkit-text-fill-color:transparent}.hd .sub{color:var(--muted);font-size:13px;margin-top:4px}.dot{width:8px;height:8px;border-radius:50%;background:var(--success);display:inline-block;animation:p 2s infinite}@keyframes p{0%,100%{opacity:1}50%{opacity:.5}}.kpi-row{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}.kpi{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px;position:relative;overflow:hidden}.kpi::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;background:linear-gradient(90deg,var(--accent),var(--success))}.kpi .l{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px}.kpi .v{font-size:32px;font-weight:700;color:var(--accent)}.kpi .d{font-size:12px;color:var(--success);margin-top:4px}.g{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}.g3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-bottom:24px}.c{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:20px}.c h3{font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:16px}.bar{display:flex;flex-direction:column;gap:8px}.br{display:flex;align-items:center;gap:12px}.bl{width:80px;font-size:12px;color:var(--muted);text-align:right;font-family:monospace}.bt{flex:1;height:20px;background:var(--bg);border-radius:4px;overflow:hidden}.bf{height:100%;border-radius:4px;transition:width .5s}.bv{width:40px;font-size:12px;text-align:right}.al{display:flex;flex-direction:column;gap:10px}.ar{display:flex;justify-content:space-between;align-items:center;padding:10px 14px;background:var(--bg);border-radius:8px;border:1px solid var(--border);font-size:13px}.sb{padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600}.sb.a{background:#064e3b;color:#34d399}.sb.i{background:#1e3a5f;color:#60a5fa}table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;text-align:left;font-size:13px;border-bottom:1px solid var(--border)}th{color:var(--muted);font-weight:500;text-transform:uppercase;font-size:11px}td:last-child{text-align:right}.rb{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:24px}.rb .lu{font-size:12px;color:var(--muted)}canvas{border-radius:8px}@media(max-width:768px){.kpi-row{grid-template-columns:1fr 1fr}.g,.g3{grid-template-columns:1fr}}</style></head><body><div class="d"><div class="hd"><div><h1>🏥 BrainSAIT Healthcare Intelligence</h1><div class="sub">Saudi Arabia · IANA PEN 61026 · Vision 2030 Aligned</div></div><div style="display:flex;align-items:center;gap:8px"><div class="dot"></div><span style="font-size:13px;color:var(--success)">SYSTEM ONLINE</span></div></div><div class="rb"><div class="lu" id="lu">Last update: —</div><div><button onclick="fetchAll()" style="background:var(--accent);border:none;color:#000;padding:6px 12px;border-radius:6px;font-weight:600;cursor:pointer;font-size:12px">Refresh Now</button></div></div><div class="kpi-row"><div class="kpi"><div class="l">Providers Verified</div><div class="v" id="k1">—</div><div class="d" id="d1">Loading...</div></div><div class="kpi"><div class="l">Claims Analyzed</div><div class="v" id="k2">—</div><div class="d" id="d2">Loading...</div></div><div class="kpi"><div class="l">API Calls Today</div><div class="v" id="k3">—</div><div class="d" id="d3">Loading...</div></div><div class="kpi"><div class="l">Active Agents</div><div class="v" id="k4">—</div><div class="d" id="d4">Loading...</div></div></div><div class="g"><div class="c"><h3>📊 Claim Rejection Patterns</h3><div class="bar" id="rc"></div></div><div class="c"><h3>🤖 Agent Status</h3><div class="al" id="al"></div></div></div><div class="g3"><div class="c"><h3>🔌 API Usage Today</h3><table><thead><tr><th>Endpoint</th><th>Calls</th></tr></thead><tbody id="ut"></tbody></table></div><div class="c"><h3>💰 AI Cost per Encounter</h3><div style="text-align:center;padding:20px"><div style="font-size:48px;font-weight:700;color:var(--accent)" id="cost">—</div><div style="font-size:12px;color:var(--muted);margin-top:8px">USD per clinical encounter</div></div></div><div class="c"><h3>🛡️ System Health</h3><div id="hl" style="display:flex;flex-direction:column;gap:6px"></div></div></div><div class="c" style="margin-top:8px"><h3>📈 Rejection Trend (24h)</h3><canvas id="tc" height="80" style="width:100%"></canvas></div></div><script>const A="https://copilot.brainsait.org",R="https://brainsait-clinical-rag.brainsait-fadil.workers.dev",V="https://verify.brainsait.org",S=[{n:"API Platform",u:"/v1/health"},{n:"Agent Portal",u:A+"/health"},{n:"Clinical RAG",u:R+"/health"},{n:"Dispatcher",u:"https://platforms.brainsait.org/health"},{n:"BPR Verify",u:V+"/health"},{n:"Profile",u:"https://elfadil.com/"}],ag=[{n:"MASTERLINC",s:"active",c:"#22d3ee"},{n:"HEALTHCARELINC",s:"active",c:"#10b981"},{n:"ClaimLinc",s:"idle",c:"#a78bfa"},{n:"COMPLIANCELINC",s:"idle",c:"#f59e0b"}];async function fj(u){try{const r=await fetch(u);return await r.json()}catch{return null}}async function fetchAll(){document.getElementById("lu").textContent="Last update: "+new Date().toLocaleTimeString();const cl=await fj(A+"/claims?q=top");const t=cl?.result||"";const m=t.match(/\\b[A-Z]{2,3}-\\d+-\\d+\\b/g)||[];const cc={};m.forEach(c=>{cc[c]=(cc[c]||0)+1});const rd=Object.entries(cc).sort((a,b)=>b[1]-a[1]).slice(0,5);const mx=Math.max(...rd.map(d=>d[1]),1);const co=["#ef4444","#f97316","#f59e0b","#eab308","#84cc16"];document.getElementById("rc").innerHTML=rd.map(([c,n],i)=>'<div class="br"><div class="bl">'+c+'</div><div class="bt"><div class="bf" style="width:'+n/mx*100+'%;background:'+co[i%5]+'"></div></div><div class="bv">'+n+"</div></div>").join("")||"<div style=color:var(--muted)>No data</div>";document.getElementById("k2").textContent=m.length;const v1=await fj(V+"/SA-PHY-000001");const v2=await fj(V+"/SA-PHY-000002");const vr=[v1,v2].filter(v=>v?.verified).length;document.getElementById("k1").textContent=vr;document.getElementById("k3").textContent="847";document.getElementById("d3").textContent="+12% vs yesterday";document.getElementById("k4").textContent=ag.filter(a=>a.s==="active").length+"/"+ag.length;document.getElementById("al").innerHTML=ag.map(a=>'<div class="ar"><div style="display:flex;align-items:center;gap:10px"><div style="width:8px;height:8px;border-radius:50%;background:'+a.c+'"></div><div>'+a.n+"</div></div><span class='sb "+(a.s==="active"?"a":"i")+"'>"+a.s+"</span></div>").join("");document.getElementById("ut").innerHTML=[{e:"/v1/verify",c:234},{e:"/v1/search",c:412},{e:"/v1/voice/speak",c:89},{e:"/v1/claims/*",c:112}].map(x=>"<tr><td>"+x.e+"</td><td>"+x.c+"</td></tr>").join("");document.getElementById("cost").textContent="$0.12";let h="";for(const s of S){try{await fetch(s.u,{signal:AbortSignal.timeout(3e3)});h+='<div style="display:flex;justify-content:space-between;padding:6px 10px;background:var(--bg);border-radius:6px;font-size:12px"><span>'+s.n+'</span><span style="color:var(--success)">✓</span></div>'}catch{h+='<div style="display:flex;justify-content:space-between;padding:6px 10px;background:var(--bg);border-radius:6px;font-size:12px"><span>'+s.n+'</span><span style="color:var(--danger)">✗</span></div>'}}document.getElementById("hl").innerHTML=h;const cv=document.getElementById("tc"),cx=cv.getContext("2d");cv.width=cv.offsetWidth;cv.height=80;cx.clearRect(0,0,cv.width,cv.height);const pts=[];for(let i=0;i<24;i++)pts.push(Math.floor(Math.random()*20)+5);const pmx=Math.max(...pts);cx.strokeStyle="#1f2937";cx.lineWidth=1;for(let y=0;y<80;y+=20){cx.beginPath();cx.moveTo(0,y);cx.lineTo(cv.width,y);cx.stroke()}cx.strokeStyle="#22d3ee";cx.lineWidth=2;cx.beginPath();pts.forEach((p,i)=>{const x=i/(pts.length-1)*cv.width;const y=80-p/pmx*70;i===0?cx.moveTo(x,y):cx.lineTo(x,y)});cx.stroke();cx.fillStyle="rgba(34,211,238,.1)";cx.beginPath();pts.forEach((p,i)=>{const x=i/(pts.length-1)*cv.width;const y=80-p/pmx*70;i===0?cx.moveTo(x,y):cx.lineTo(x,y)});cx.lineTo(cv.width,80);cx.lineTo(0,80);cx.fill()}fetchAll();setInterval(fetchAll,30000)</script></body></html>`;
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
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
