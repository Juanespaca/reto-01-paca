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

## Cómo correr `demo.ts` (verificación sin modelo)

```bash
bun install
bun run demo.ts
```

Procesa los 4 casos de `fixtures/reto-01/casos/` llamando directamente a las
herramientas (sin tocar ningún proveedor LLM ni gastar ninguna clave) e
imprime un resumen por caso. Genera los mismos archivos en `out/` que
produciría el agente conversacional.

## Link de prueba

_(Completar con la URL del despliegue — ver sección "Despliegue" abajo.)_

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
├── modulo/                        # bonus: agente empaquetado (ver PRD 9.4)
├── SOLUCION.md
└── README.md
```

## API

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation }` |
| `GET` | `/api/sessions/:id` | Historial completo de la sesión |
| `GET` | `/api/health` | `{ ok, provider, model }` — nunca expone la clave |

## Despliegue

Pensado para desplegarse en cualquier plataforma que corra Bun (Railway,
Render, Fly.io). Build: `bun install`. Start: `bun run start`. Variable de
entorno requerida: `ANTHROPIC_API_KEY`.
