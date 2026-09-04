import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import vm from "node:vm";

const workerPath = resolve("worker/index.js");
const source = await readFile(workerPath, "utf8");
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const worker = (await import(moduleUrl)).default;

assert.equal(typeof worker?.fetch, "function", "El Worker debe exportar default.fetch");

const pageResponse = await worker.fetch(new Request("https://demo.local/"), {}, {});
assert.equal(pageResponse.status, 200);
const page = await pageResponse.text();
const inlineScript = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(inlineScript, "La pagina debe incluir el script de interaccion");
new vm.Script(inlineScript, { filename: "inline-browser-script.js" });

const body = {
  id: "OK-VALIDATION-001",
  monto: 10,
  cuentaOrigen: "1234567890",
  cuentaDestino: "0987654321",
};

const success = await worker.fetch(
  new Request("https://demo.local/api/transferencias", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
  {},
  {},
);
assert.equal(success.status, 200);
assert.equal((await success.json()).source, "CLOUD");

const degraded = await worker.fetch(
  new Request("https://demo.local/api/transferencias", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, id: "FAIL-VALIDATION-001" }),
  }),
  {},
  {},
);
assert.equal(degraded.status, 200);
const degradedBody = await degraded.json();
assert.equal(degradedBody.source, "CORE_FALLBACK");
assert.equal(degradedBody.degraded, true);

console.log("Validacion completada: pagina, CLOUD y fallback funcionan.");

