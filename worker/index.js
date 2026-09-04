const CONFIG = Object.freeze({
  slidingWindowSize: 10,
  minimumNumberOfCalls: 5,
  failureRateThreshold: 50,
  waitDurationInOpenStateMs: 20_000,
  permittedCallsInHalfOpen: 3,
  maxAttempts: 3,
  initialBackoffMs: 200,
});

function initialState() {
  return {
    circuit: "CLOSED",
    openedAt: null,
    halfOpenAttempts: 0,
    halfOpenSuccesses: 0,
    window: [],
    externalAvailable: true,
    metrics: {
      total: 0,
      success: 0,
      degraded: 0,
      failure: 0,
      cloudAttempts: 0,
      retries: 0,
      latencies: [],
    },
    events: [],
  };
}

let demo = initialState();

function addEvent(type, message) {
  demo.events.unshift({ type, message, timestamp: new Date().toISOString() });
  demo.events = demo.events.slice(0, 8);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentCircuitState() {
  if (
    demo.circuit === "OPEN" &&
    demo.openedAt !== null &&
    Date.now() - demo.openedAt >= CONFIG.waitDurationInOpenStateMs
  ) {
    demo.circuit = "HALF_OPEN";
    demo.halfOpenAttempts = 0;
    demo.halfOpenSuccesses = 0;
    addEvent("transition", "Circuit Breaker: OPEN → HALF_OPEN");
  }
  return demo.circuit;
}

function openCircuit(reason) {
  if (demo.circuit !== "OPEN") {
    addEvent("transition", "Circuit Breaker: " + demo.circuit + " → OPEN (" + reason + ")");
  }
  demo.circuit = "OPEN";
  demo.openedAt = Date.now();
  demo.halfOpenAttempts = 0;
  demo.halfOpenSuccesses = 0;
}

function closeCircuit() {
  if (demo.circuit !== "CLOSED") {
    addEvent("transition", "Circuit Breaker: " + demo.circuit + " → CLOSED");
  }
  demo.circuit = "CLOSED";
  demo.openedAt = null;
  demo.halfOpenAttempts = 0;
  demo.halfOpenSuccesses = 0;
  demo.window = [];
}

function recordCircuitResult(success) {
  const state = currentCircuitState();

  if (state === "HALF_OPEN") {
    demo.halfOpenAttempts += 1;
    if (!success) {
      openCircuit("falló una llamada de prueba");
      return;
    }
    demo.halfOpenSuccesses += 1;
    if (demo.halfOpenSuccesses >= CONFIG.permittedCallsInHalfOpen) {
      closeCircuit();
    }
    return;
  }

  if (state !== "CLOSED") return;
  demo.window.push(success);
  if (demo.window.length > CONFIG.slidingWindowSize) demo.window.shift();

  if (demo.window.length >= CONFIG.minimumNumberOfCalls) {
    const failures = demo.window.filter((value) => !value).length;
    const failureRate = (failures / demo.window.length) * 100;
    if (failureRate >= CONFIG.failureRateThreshold) {
      openCircuit("failure rate " + failureRate.toFixed(0) + "%");
    }
  }
}

function failureRate() {
  if (demo.window.length === 0) return 0;
  return (demo.window.filter((value) => !value).length / demo.window.length) * 100;
}

function normalizedId(value) {
  return String(value || "").trim().toUpperCase();
}

async function cloudAttempt(transfer) {
  demo.metrics.cloudAttempts += 1;
  const id = normalizedId(transfer.id);

  if (!demo.externalAvailable) {
    await sleep(40);
    throw new Error("External service unavailable");
  }

  if (id.startsWith("SLOW-")) {
    await sleep(350);
    throw new Error("Cloud request timeout");
  }

  await sleep(35 + Math.floor(Math.random() * 90));
  const forceFailure = id.startsWith("FAIL-");
  const forceSuccess = id.startsWith("OK-");
  const randomFailure = !forceSuccess && Math.random() < 0.5;

  if (forceFailure || randomFailure) {
    throw new Error("Cloud service returned HTTP 500");
  }

  return {
    id: transfer.id,
    estado: "SUCCESS",
    source: "CLOUD",
    degraded: false,
    timestamp: new Date().toISOString(),
  };
}

async function cloudWithRetry(transfer) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.maxAttempts; attempt += 1) {
    try {
      const result = await cloudAttempt(transfer);
      return { result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < CONFIG.maxAttempts) {
        demo.metrics.retries += 1;
        const base = CONFIG.initialBackoffMs * 2 ** (attempt - 1);
        const jittered = Math.round(base * (0.5 + Math.random()));
        addEvent("retry", "Retry " + attempt + " para " + transfer.id + " en " + jittered + "ms");
        await sleep(jittered);
      }
    }
  }

  throw lastError;
}

async function coreFallback(transfer, reason) {
  if (!demo.externalAvailable) {
    throw new Error("Core fallback unavailable");
  }
  await sleep(30);
  addEvent("fallback", "Fallback CORE para " + transfer.id + ": " + reason);
  return {
    id: transfer.id,
    estado: "SUCCESS",
    source: "CORE_FALLBACK",
    degraded: true,
    timestamp: new Date().toISOString(),
  };
}

function validateTransfer(value) {
  if (!value || typeof value !== "object") return "El body JSON es obligatorio";
  if (!String(value.id || "").trim()) return "id es obligatorio";
  if (!Number.isFinite(Number(value.monto)) || Number(value.monto) <= 0) {
    return "monto debe ser mayor que cero";
  }
  if (!String(value.cuentaOrigen || "").trim()) return "cuentaOrigen es obligatoria";
  if (!String(value.cuentaDestino || "").trim()) return "cuentaDestino es obligatoria";
  return null;
}

async function processTransfer(transfer) {
  const startedAt = performance.now();
  demo.metrics.total += 1;
  let attempts = 0;

  try {
    let result;
    const state = currentCircuitState();

    if (state === "OPEN") {
      result = await coreFallback(transfer, "circuit breaker OPEN");
    } else {
      try {
        const cloud = await cloudWithRetry(transfer);
        attempts = cloud.attempts;
        recordCircuitResult(true);
        result = cloud.result;
      } catch (error) {
        attempts = CONFIG.maxAttempts;
        recordCircuitResult(false);
        result = await coreFallback(transfer, error.message);
      }
    }

    demo.metrics.success += 1;
    if (result.degraded) demo.metrics.degraded += 1;
    addEvent("success", transfer.id + " procesada por " + result.source);
    return { status: 200, result, attempts };
  } catch (error) {
    demo.metrics.failure += 1;
    addEvent("failure", transfer.id + " terminó con error: " + error.message);
    return {
      status: 503,
      result: {
        id: transfer.id,
        estado: "ERROR",
        source: "UNAVAILABLE",
        degraded: true,
        timestamp: new Date().toISOString(),
        message: error.message,
      },
      attempts,
    };
  } finally {
    demo.metrics.latencies.push(performance.now() - startedAt);
    demo.metrics.latencies = demo.metrics.latencies.slice(-20);
  }
}

function statusPayload() {
  const state = currentCircuitState();
  const remainingOpenMs = state === "OPEN" && demo.openedAt !== null
    ? Math.max(0, CONFIG.waitDurationInOpenStateMs - (Date.now() - demo.openedAt))
    : 0;

  return {
    circuitBreaker: {
      name: "cloudService",
      state,
      bufferedCalls: demo.window.length,
      failureRate: Number(failureRate().toFixed(2)),
      remainingOpenSeconds: Math.ceil(remainingOpenMs / 1000),
      halfOpenAttempts: demo.halfOpenAttempts,
      configuration: {
        slidingWindowSize: CONFIG.slidingWindowSize,
        minimumNumberOfCalls: CONFIG.minimumNumberOfCalls,
        failureRateThreshold: CONFIG.failureRateThreshold,
        waitDurationInOpenStateSeconds: CONFIG.waitDurationInOpenStateMs / 1000,
        permittedCallsInHalfOpen: CONFIG.permittedCallsInHalfOpen,
      },
    },
    retry: {
      maxAttempts: CONFIG.maxAttempts,
      initialBackoffMs: CONFIG.initialBackoffMs,
      exponentialBackoff: true,
      jitter: "±50%",
    },
    externalService: demo.externalAvailable ? "UP" : "DOWN",
    metrics: {
      total: demo.metrics.total,
      success: demo.metrics.success,
      degraded: demo.metrics.degraded,
      failure: demo.metrics.failure,
      cloudAttempts: demo.metrics.cloudAttempts,
      retries: demo.metrics.retries,
      p95LatencyMs: percentile(demo.metrics.latencies, 0.95),
    },
    events: demo.events,
  };
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return Number(sorted[index].toFixed(2));
}

function encodeState(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeState(token) {
  try {
    const normalized = token.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    const fresh = initialState();
    if (!["CLOSED", "OPEN", "HALF_OPEN"].includes(parsed?.circuit)) return fresh;
    return {
      ...fresh,
      ...parsed,
      window: Array.isArray(parsed.window) ? parsed.window.slice(-CONFIG.slidingWindowSize) : [],
      events: Array.isArray(parsed.events) ? parsed.events.slice(0, 8) : [],
      metrics: {
        ...fresh.metrics,
        ...(parsed.metrics || {}),
        latencies: Array.isArray(parsed.metrics?.latencies) ? parsed.metrics.latencies.slice(-20) : [],
      },
    };
  } catch {
    return initialState();
  }
}

function stateFromRequest(request) {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(/(?:^|;\s*)cb_demo_state=([^;]+)/);
  return match ? decodeState(match[1]) : demo;
}

function stateCookie() {
  return "cb_demo_state=" + encodeState(demo) + "; Path=/; Max-Age=14400; SameSite=Lax; Secure";
}

function corsHeaders(contentType = "application/json; charset=utf-8") {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-expose-headers": "x-circuit-state, x-retry-attempts",
    "cache-control": "no-store",
    "content-type": contentType,
    "set-cookie": stateCookie(),
  };
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value, null, 2), {
    status,
    headers: { ...corsHeaders(), ...extraHeaders },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function healthPayload(kind) {
  const externalStatus = demo.externalAvailable ? "UP" : "DOWN";
  const circuit = currentCircuitState();

  if (kind === "liveness") {
    return { status: "UP", components: { livenessState: { status: "UP" } } };
  }

  if (kind === "readiness") {
    return {
      status: externalStatus,
      components: {
        readinessState: { status: "UP" },
        externalService: {
          status: externalStatus,
          details: { externalService: demo.externalAvailable ? "Available" : "Unavailable" },
        },
      },
    };
  }

  return {
    status: externalStatus,
    components: {
      circuitBreakers: {
        status: circuit === "OPEN" ? "DOWN" : "UP",
        details: { cloudService: { state: circuit, failureRate: failureRate() } },
      },
      externalService: { status: externalStatus },
      livenessState: { status: "UP" },
      readinessState: { status: externalStatus },
    },
  };
}

function prometheusPayload() {
  const state = currentCircuitState();
  const m = demo.metrics;
  return [
    "# HELP transferencia_total Total de transferencias procesadas",
    "# TYPE transferencia_total counter",
    "transferencia_total " + m.total,
    "# HELP transferencia_success_total Total de transferencias exitosas",
    "# TYPE transferencia_success_total counter",
    "transferencia_success_total " + m.success,
    "# HELP transferencia_degraded_total Total de transferencias procesadas por fallback",
    "# TYPE transferencia_degraded_total counter",
    "transferencia_degraded_total " + m.degraded,
    "# HELP transferencia_failure_total Total de transferencias con error terminal",
    "# TYPE transferencia_failure_total counter",
    "transferencia_failure_total " + m.failure,
    "# HELP transferencia_retry_total Total de reintentos",
    "# TYPE transferencia_retry_total counter",
    "transferencia_retry_total " + m.retries,
    "# HELP transferencia_latency_p95_ms Latencia P95 en milisegundos",
    "# TYPE transferencia_latency_p95_ms gauge",
    "transferencia_latency_p95_ms " + percentile(m.latencies, 0.95),
    "# HELP resilience4j_circuitbreaker_state Estado (0=CLOSED, 1=OPEN, 2=HALF_OPEN)",
    "# TYPE resilience4j_circuitbreaker_state gauge",
    "resilience4j_circuitbreaker_state{name=\"cloudService\"} " + ({ CLOSED: 0, OPEN: 1, HALF_OPEN: 2 }[state]),
    "",
  ].join("\n");
}

const page = `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Demo interactiva de Circuit Breaker, retry y degradación controlada">
  <title>Circuit Breaker Lab</title>
  <style>
    :root { color-scheme: dark; --ink:#f7f5ec; --muted:#a8a89e; --line:#303127; --panel:#171811; --yellow:#ffd500; --green:#64db8f; --red:#ff6b6b; --blue:#6eb5ff; font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; color:var(--ink); background:radial-gradient(circle at 85% 0%,#35300c 0,transparent 30rem),#0d0e0a; }
    main { width:min(1180px,calc(100% - 28px)); margin:auto; padding:28px 0 48px; }
    header { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; margin-bottom:22px; }
    .eyebrow { color:var(--yellow); text-transform:uppercase; letter-spacing:.14em; font-size:.75rem; font-weight:800; }
    h1 { margin:.25rem 0 .35rem; font-size:clamp(2rem,4.5vw,4rem); line-height:.95; letter-spacing:-.055em; }
    header p { color:var(--muted); margin:0; max-width:650px; font-size:1rem; line-height:1.55; }
    .live { border:1px solid var(--line); border-radius:999px; padding:.6rem .8rem; white-space:nowrap; background:#13140f; font-weight:700; }
    .dot { display:inline-block; width:.55rem; height:.55rem; border-radius:50%; margin-right:.45rem; background:var(--green); box-shadow:0 0 18px var(--green); }
    .grid { display:grid; grid-template-columns:minmax(0,1.08fr) minmax(320px,.92fr); gap:16px; }
    .panel { background:color-mix(in srgb,var(--panel) 94%,transparent); border:1px solid var(--line); border-radius:18px; padding:18px; box-shadow:0 22px 70px #0007; }
    .panel h2 { margin:0 0 14px; font-size:1rem; letter-spacing:.01em; }
    .status-row { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-bottom:16px; }
    .stat { padding:14px; border:1px solid var(--line); border-radius:14px; background:#10110c; }
    .stat span { display:block; color:var(--muted); font-size:.76rem; margin-bottom:7px; }
    .stat strong { font-size:1.08rem; }
    .closed { color:var(--green); } .open { color:var(--red); } .half_open { color:var(--yellow); }
    label { display:block; color:var(--muted); font-size:.8rem; margin:0 0 6px; }
    .form-grid { display:grid; grid-template-columns:1.2fr .7fr; gap:10px; }
    input { width:100%; border:1px solid var(--line); border-radius:11px; color:var(--ink); background:#0c0d09; padding:.78rem .85rem; font:inherit; outline:none; }
    input:focus { border-color:var(--yellow); box-shadow:0 0 0 3px #ffd5001c; }
    .actions { display:grid; grid-template-columns:repeat(2,1fr); gap:9px; margin-top:14px; }
    button { border:1px solid var(--line); border-radius:11px; padding:.78rem .8rem; color:var(--ink); background:#24251c; font:700 .86rem/1.1 inherit; cursor:pointer; transition:.16s ease; }
    button:hover { transform:translateY(-1px); border-color:#65664f; }
    button:disabled { opacity:.55; cursor:wait; transform:none; }
    button.primary { background:var(--yellow); color:#161500; border-color:var(--yellow); }
    button.danger { background:#3b1718; border-color:#6e292c; }
    button.ghost { background:transparent; }
    .hint { color:var(--muted); font-size:.78rem; line-height:1.5; margin:12px 0 0; }
    .codehead { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:18px 0 8px; }
    pre { margin:0; min-height:238px; max-height:390px; overflow:auto; border-radius:13px; padding:14px; background:#080906; border:1px solid #292a21; color:#d7dbcb; font:13px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace; white-space:pre-wrap; word-break:break-word; }
    .timeline { display:grid; gap:8px; max-height:285px; overflow:auto; }
    .event { display:grid; grid-template-columns:72px 1fr; gap:10px; padding:10px 0; border-bottom:1px solid #26271f; font-size:.82rem; }
    .event:last-child { border:0; }
    .event time { color:var(--muted); font-variant-numeric:tabular-nums; }
    .event.retry b { color:var(--blue); } .event.fallback b { color:var(--yellow); } .event.transition b { color:var(--red); } .event.success b { color:var(--green); }
    .endpoint { margin-top:16px; padding:12px; border:1px solid var(--line); border-radius:12px; background:#10110c; }
    .endpoint code { color:var(--yellow); font-size:.83rem; word-break:break-all; }
    footer { color:var(--muted); font-size:.78rem; margin-top:16px; text-align:center; }
    @media (max-width:820px) { header{display:block}.live{display:inline-block;margin-top:16px}.grid{grid-template-columns:1fr}.status-row{grid-template-columns:1fr 1fr}.status-row .stat:last-child{grid-column:1/-1} }
    @media (max-width:480px) { main{width:min(100% - 18px,1180px);padding-top:18px}.panel{padding:14px;border-radius:14px}.form-grid,.actions{grid-template-columns:1fr}h1{font-size:2.5rem} }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">SRE · Resilience4j behavior</div>
        <h1>Circuit Breaker Lab</h1>
        <p>Prueba reintentos con backoff + jitter, apertura del circuito y degradación controlada hacia CORE desde una URL pública.</p>
      </div>
      <div class="live"><span class="dot"></span>API disponible</div>
    </header>
    <section class="grid">
      <div class="panel">
        <h2>Consola de transferencia</h2>
        <div class="status-row">
          <div class="stat"><span>Circuit breaker</span><strong id="circuit">CLOSED</strong></div>
          <div class="stat"><span>Servicio externo</span><strong id="external">UP</strong></div>
          <div class="stat"><span>Degradadas / Total</span><strong id="ratio">0 / 0</strong></div>
        </div>
        <div class="form-grid">
          <div><label for="transferId">ID de transferencia</label><input id="transferId" value="OK-DEMO-001"></div>
          <div><label for="amount">Monto</label><input id="amount" type="number" min="0.01" step="0.01" value="1500.50"></div>
        </div>
        <div class="actions">
          <button class="primary" data-action="success">Éxito por CLOUD</button>
          <button data-action="failure">Falla + FALLBACK</button>
          <button class="danger" data-action="open">Abrir circuito (5 fallas)</button>
          <button data-action="external">Apagar servicio externo</button>
          <button class="ghost" data-action="reset">Reiniciar escenario</button>
          <button class="ghost" data-action="copy">Copiar cURL</button>
        </div>
        <p class="hint"><b>OK-</b> fuerza éxito, <b>FAIL-</b> fuerza HTTP 500 y <b>SLOW-</b> fuerza timeout. Cada falla se reintenta 3 veces antes del fallback.</p>
        <div class="codehead"><h2>Última respuesta</h2><span id="latency" class="hint"></span></div>
        <pre id="output" aria-live="polite">Listo para ejecutar.</pre>
      </div>
      <aside class="panel">
        <h2>Eventos de resiliencia</h2>
        <div id="timeline" class="timeline"><div class="hint">Todavía no hay eventos.</div></div>
        <div class="endpoint">
          <label>Endpoint para Postman</label>
          <code id="endpoint"></code>
        </div>
        <div class="endpoint">
          <label>Health probes</label>
          <code>/actuator/health/liveness</code><br>
          <code>/actuator/health/readiness</code><br>
          <code>/actuator/prometheus</code>
        </div>
      </aside>
    </section>
    <footer>Demo temporal · ventana de 10 llamadas · umbral 50% · OPEN 20 segundos · 3 llamadas en HALF_OPEN</footer>
  </main>
  <script>
    const $ = (selector) => document.querySelector(selector);
    const buttons = [...document.querySelectorAll("button")];
    let latestStatus = null;
    $("#endpoint").textContent = location.origin + "/api/transferencias";

    function busy(value) { buttons.forEach((button) => { button.disabled = value; }); }
    function requestBody(id) {
      return { id, monto: Number($("#amount").value), cuentaOrigen: "1234567890", cuentaDestino: "0987654321" };
    }
    async function api(path, options) {
      const started = performance.now();
      const response = await fetch(path, options);
      const contentType = response.headers.get("content-type") || "";
      const body = contentType.includes("json") ? await response.json() : await response.text();
      return { status: response.status, body, ms: Math.round(performance.now() - started), headers: { circuit: response.headers.get("x-circuit-state"), attempts: response.headers.get("x-retry-attempts") } };
    }
    async function transfer(id) {
      return api("/api/transferencias", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(requestBody(id)) });
    }
    async function refresh() {
      const result = await api("/api/demo/status");
      latestStatus = result.body;
      const circuit = latestStatus.circuitBreaker.state;
      $("#circuit").textContent = circuit + (circuit === "OPEN" ? " · " + latestStatus.circuitBreaker.remainingOpenSeconds + "s" : "");
      $("#circuit").className = circuit.toLowerCase();
      $("#external").textContent = latestStatus.externalService;
      $("#external").className = latestStatus.externalService === "UP" ? "closed" : "open";
      $("#ratio").textContent = latestStatus.metrics.degraded + " / " + latestStatus.metrics.total;
      document.querySelector('[data-action="external"]').textContent = latestStatus.externalService === "UP" ? "Apagar servicio externo" : "Encender servicio externo";
      const timeline = $("#timeline");
      if (!latestStatus.events.length) timeline.innerHTML = '<div class="hint">Todavía no hay eventos.</div>';
      else timeline.innerHTML = latestStatus.events.map((event) => '<div class="event ' + event.type + '"><time>' + new Date(event.timestamp).toLocaleTimeString() + '</time><div><b>' + event.type.toUpperCase() + '</b><br>' + event.message + '</div></div>').join("");
    }
    async function act(action) {
      busy(true);
      try {
        let result;
        if (action === "success" || action === "failure") {
          const prefix = action === "success" ? "OK-" : "FAIL-";
          const id = prefix + "DEMO-" + Date.now();
          $("#transferId").value = id;
          result = await transfer(id);
        } else if (action === "open") {
          const calls = [];
          for (let index = 1; index <= 5; index += 1) {
            calls.push(await transfer("FAIL-CB-" + index + "-" + Date.now()));
          }
          result = { status:200, body:{ message:"Se enviaron 5 fallas controladas", calls:calls.map((call) => call.body) }, ms:calls.reduce((sum, call) => sum + call.ms, 0), headers:{} };
        } else if (action === "reset") {
          result = await api("/api/demo/reset", { method:"POST" });
        } else if (action === "external") {
          result = await api("/api/demo/external", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ available: latestStatus.externalService !== "UP" }) });
        } else if (action === "copy") {
          const quote = String.fromCharCode(39);
          const command = 'curl -X POST "' + location.origin + '/api/transferencias" -H "Content-Type: application/json" -d ' + quote + JSON.stringify(requestBody($("#transferId").value)) + quote;
          await navigator.clipboard.writeText(command);
          result = { status:200, body:{ message:"cURL copiado al portapapeles", command }, ms:0, headers:{} };
        }
        $("#output").textContent = JSON.stringify(result, null, 2);
        $("#latency").textContent = result.ms + " ms";
      } catch (error) {
        $("#output").textContent = JSON.stringify({ error:error.message }, null, 2);
      } finally {
        await refresh();
        busy(false);
      }
    }
    buttons.forEach((button) => button.addEventListener("click", () => act(button.dataset.action)));
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;

export default {
  async fetch(request, env, ctx) {
    void env;
    void ctx;
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/$/, "") || "/";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    // El estado también viaja en una cookie de 4 horas para que la secuencia de
    // la demo sobreviva aunque Cloudflare atienda peticiones en otro isolate.
    demo = stateFromRequest(request);

    if (request.method === "GET" && path === "/") {
      return new Response(page, { headers: corsHeaders("text/html; charset=utf-8") });
    }

    if (request.method === "POST" && path === "/cloud/transferir") {
      const body = await readJson(request);
      const validationError = validateTransfer(body);
      if (validationError) return json({ error: validationError }, 400);
      try {
        return json(await cloudAttempt(body));
      } catch (error) {
        return json({ id: body.id, estado: "ERROR", source: "CLOUD", degraded: false, timestamp: new Date().toISOString(), message: error.message }, 500);
      }
    }

    if (request.method === "POST" && path === "/core/transferir") {
      const body = await readJson(request);
      const validationError = validateTransfer(body);
      if (validationError) return json({ error: validationError }, 400);
      try {
        return json(await coreFallback(body, "direct request"));
      } catch (error) {
        return json({ error: error.message }, 503);
      }
    }

    if (request.method === "POST" && path === "/api/transferencias") {
      const body = await readJson(request);
      const validationError = validateTransfer(body);
      if (validationError) return json({ error: validationError }, 400);
      const processed = await processTransfer(body);
      return json(processed.result, processed.status, {
        "x-circuit-state": currentCircuitState(),
        "x-retry-attempts": String(processed.attempts),
      });
    }

    if (request.method === "GET" && path === "/api/demo/status") {
      return json(statusPayload());
    }

    if (request.method === "POST" && path === "/api/demo/reset") {
      demo = initialState();
      addEvent("transition", "Escenario reiniciado");
      return json({ message: "Demo reiniciada", ...statusPayload() });
    }

    if (request.method === "POST" && path === "/api/demo/external") {
      const body = await readJson(request);
      if (typeof body?.available !== "boolean") return json({ error: "available debe ser boolean" }, 400);
      demo.externalAvailable = body.available;
      addEvent("transition", "Servicio externo → " + (body.available ? "UP" : "DOWN"));
      return json(statusPayload());
    }

    if (request.method === "GET" && path === "/actuator/health") {
      const payload = healthPayload("all");
      return json(payload, payload.status === "UP" ? 200 : 503);
    }
    if (request.method === "GET" && path === "/mock/actuator/health") {
      const status = demo.externalAvailable ? "UP" : "DOWN";
      return json({ status }, status === "UP" ? 200 : 503);
    }
    if (request.method === "GET" && path === "/actuator/health/liveness") {
      return json(healthPayload("liveness"));
    }
    if (request.method === "GET" && path === "/actuator/health/readiness") {
      const payload = healthPayload("readiness");
      return json(payload, payload.status === "UP" ? 200 : 503);
    }
    if (request.method === "GET" && (path === "/actuator/prometheus" || path === "/actuator/metrics")) {
      return new Response(prometheusPayload(), { headers: corsHeaders("text/plain; version=0.0.4; charset=utf-8") });
    }

    return json({ error: "Not found", path }, 404);
  },
};
