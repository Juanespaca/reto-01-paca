# Reto 1 — Agente "Registro como Proveedor"

Agente conversacional que automatiza el llenado del formulario de registro
de Periferia IT Group como proveedor ante sus clientes, a partir del
repositorio maestro interno. Nunca firma ni envía nada: deja el paquete
listo para que un humano confirme.

## Cómo levantar en local (un comando)

```bash
bun install
cp .env.example .env   # y completa ANTHROPIC_API_KEY con tu propia clave
bun run dev
```

Abre `http://localhost:3000`. El chat queda disponible ahí mismo (front y
backend en el mismo proceso, mismo puerto).

## Variables de entorno

| Variable | Obligatoria | Descripción |
|---|---|---|
| `ANTHROPIC_API_KEY` | Sí | Clave de Anthropic. Solo se lee del entorno del backend; nunca aparece en el repo, el front ni los logs. |
| `ANTHROPIC_MODEL` | No | Modelo a usar (default `claude-sonnet-5`). |
| `PORT` | No | Puerto del servidor (default `3000`). |
| `TOPE_TOKENS_SESION` | No | Tope de tokens acumulados por sesión antes de bloquear nuevas llamadas al modelo (default `200000`). |
| `FECHA_REFERENCIA` | No | Fecha `AAAA-MM-DD` contra la que se evalúa la vigencia de los soportes (default: hoy). Sirve para demos y pruebas reproducibles. |

## Cómo correr `demo.ts` (verificación sin modelo)

```bash
bun install
bun run demo.ts
```

Procesa los 4 casos de `fixtures/reto-01/casos/` llamando directamente a las
herramientas (sin tocar ningún proveedor LLM ni gastar ninguna clave) e
imprime un resumen por caso. Genera los mismos archivos en `out/` que
produciría el agente conversacional.

## Pruebas automáticas

```bash
bun test          # 52 pruebas: HU-1..HU-5, reglas por país, RN2, gate de confirmación, costo y determinismo
bunx tsc --noEmit # TypeScript estricto
```

Las pruebas no consumen ningún modelo: el gate de confirmación se prueba con
un modelo simulado "desobediente" que siempre intenta enviar.

## Link de prueba

**https://reto-01-paca.onrender.com** (plan gratuito de Render: la primera
visita después de un rato sin uso puede tardar ~50 s mientras el servidor despierta).

## Frontend

`web/index.html` (HTML + CSS + JS plano, sin paso de build):

- **Casos de prueba** en la barra lateral con país, formato y número de soportes; un clic los procesa.
- **Pipeline en vivo** de los 5 pasos del flujo (leer → mapear → generar → paquete → envío), que se ilumina a medida que el agente llama cada herramienta (streaming NDJSON desde `/api/chat/stream`).
- **Llamadas a herramientas visibles** como tarjetas expandibles con argumentos y resultado; el envío bloqueado por el backend se marca en rojo.
- **Confirmación humana resaltada** con tarjeta y botones ("Sí, confirmo el envío" / "Revisar antes"); el backend sigue exigiendo la confirmación en un mensaje aparte.
- **Panel de resultado** por caso: estado (listo / no listo para firma / enviado), campos llenos, por confirmar y faltantes, checklist de soportes con vigencias, y descarga o vista previa de los archivos generados.
- Pruebas rápidas (caso negativo, portal, caso inexistente), modo claro/oscuro, responsive y consumo de tokens de la sesión.

## Estructura

```
reto-01-paca/
├── agent/prompt.md              # comportamiento del agente (system prompt)
├── src/
│   ├── server.ts                 # API HTTP + estáticos del front
│   ├── agent.ts                  # ciclo del agente (modelo ↔ herramientas)
│   ├── llm/adapter.ts             # interfaz propia del proveedor LLM
│   ├── llm/anthropic.ts           # implementación Anthropic
│   ├── tools/proveedor.ts         # herramientas (única fuente de valores)
│   └── knowledge/registro-proveedor.md  # conocimiento del proceso
├── web/index.html                # front de chat (HTML + JS plano)
├── fixtures/reto-01/              # entregado por Periferia (no se modifica)
├── out/                           # generado en cada ejecución
├── demo.ts                        # verificación sin modelo
├── tests/reto.test.ts             # pruebas automáticas (bun test)
├── Dockerfile                     # despliegue (Render u otra plataforma con Docker)
├── modulo/                        # bonus: agente empaquetado (ver PRD 9.4)
├── SOLUCION.md
└── README.md
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `POST` | `/api/chat/stream` | Igual que `/api/chat`, pero responde NDJSON con eventos `inicio`, `herramienta_inicio`, `herramienta_fin`, `texto_parcial` y `fin` |
| `GET` | `/api/casos` | Casos disponibles en `fixtures/reto-01/casos/` |
| `GET` | `/api/archivos/:caso` | Archivos generados en `out/<caso>/` |
| `GET` | `/api/archivos/:caso/<ruta>` | Descarga un archivo generado (`?ver=1` para verlo en el navegador); rutas fuera de `out/<caso>` se rechazan |
| `GET` | `/api/health` | `{ ok, provider, model }` — nunca expone la clave |

## Despliegue

Desplegado en Render con el `Dockerfile` del repo (imagen `oven/bun:1`).
Sirve en cualquier plataforma que corra Docker o Bun (Railway, Fly.io).
Build: `bun install`. Start: `bun run start`. Variable de entorno requerida:
`ANTHROPIC_API_KEY` (se configura en el panel de la plataforma, nunca en el repo).
