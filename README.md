# Circuit Breaker Lab

Demo interactiva para explicar resiliencia y degradacion controlada mediante
**Retry**, **Circuit Breaker** y **Fallback**.

La aplicacion contiene una interfaz web y una API publica en el mismo
Cloudflare Worker. La ruta principal simula un servicio `CLOUD`; cuando falla,
la operacion puede continuar mediante `CORE_FALLBACK`.

## Que demuestra

- Reintentos con backoff exponencial y jitter.
- Circuit Breaker con estados `CLOSED`, `OPEN` y `HALF_OPEN`.
- Fallback hacia una ruta secundaria.
- Respuestas exitosas marcadas como degradadas.
- Health checks de liveness y readiness.
- Metricas compatibles con el formato de Prometheus.

## Arquitectura

```text
Navegador / Postman
        |
        v
POST /api/transferencias
        |
        v
Circuit Breaker -> Retry -> CLOUD
        |                    |
        +---- OPEN/error ----+
                 |
                 v
          CORE_FALLBACK
```

## Configuracion de la demo

| Parametro | Valor |
| --- | ---: |
| Ventana deslizante | 10 llamadas |
| Minimo para evaluar | 5 llamadas |
| Umbral de fallas | 50 % |
| Permanencia en `OPEN` | 20 segundos |
| Llamadas en `HALF_OPEN` | 3 |
| Intentos totales | 3 |
| Backoff inicial | 200 ms |
| Jitter | +/- 50 % |

## Ejecutar localmente

Requisitos: Node.js 20 o superior.

```bash
npm install
npm run dev
```

Wrangler mostrara una URL local, normalmente `http://localhost:8787`.

## Validar

```bash
npm test
```

La validacion comprueba que el Worker, la pagina y el JavaScript del navegador
sean validos, y ejecuta los escenarios de CLOUD y fallback.

## Desplegar en Cloudflare Workers

```bash
npx wrangler login
npm run deploy
```

## Escenarios controlados

El prefijo del identificador determina el comportamiento:

- `OK-*`: CLOUD responde correctamente.
- `FAIL-*`: CLOUD devuelve un error HTTP 500.
- `SLOW-*`: CLOUD simula un timeout.

Secuencia recomendada:

1. Presionar **Reiniciar escenario**.
2. Presionar **Exito por CLOUD**.
3. Presionar **Falla + FALLBACK**.
4. Presionar **Abrir circuito (5 fallas)**.
5. Mientras este `OPEN`, enviar otra llamada y observar el fail fast.
6. Esperar 20 segundos y enviar tres exitos en `HALF_OPEN`.

## Endpoints

| Metodo | Ruta | Proposito |
| --- | --- | --- |
| `POST` | `/api/transferencias` | Orquestador resiliente |
| `POST` | `/cloud/transferir` | Ruta principal simulada |
| `POST` | `/core/transferir` | Ruta secundaria simulada |
| `GET` | `/api/demo/status` | Estado, metricas y eventos |
| `POST` | `/api/demo/reset` | Reinicia el escenario |
| `POST` | `/api/demo/external` | Enciende o apaga el servicio externo |
| `GET` | `/actuator/health/liveness` | Comprueba si la aplicacion vive |
| `GET` | `/actuator/health/readiness` | Comprueba si puede recibir trafico |
| `GET` | `/actuator/prometheus` | Expone metricas de la demo |

Ejemplo:

```bash
curl -X POST "http://localhost:8787/api/transferencias" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "OK-DEMO-001",
    "monto": 1500.50,
    "cuentaOrigen": "1234567890",
    "cuentaDestino": "0987654321"
  }'
```

## Nota tecnica

Esta es una fachada funcional para demostracion. Reproduce el contrato y el
comportamiento del proyecto original desarrollado con Spring Boot y
Resilience4j; no ejecuta el JAR de Spring Boot dentro de Cloudflare Workers.

