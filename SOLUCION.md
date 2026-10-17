# SOLUCIÓN — Reto 1: Agente "Registro como Proveedor"

## 1. Problema en una frase

El área administrativa de Periferia transcribe a mano, entre 8 y 12 veces al
mes, los mismos datos de la empresa en formularios de distintos clientes; a
quien le duele es a la analista administrativa, que pierde tiempo y corre
riesgo de error en datos sensibles (cuenta bancaria, NIT).

## 2. Arquitectura

```
┌──────────────┐  HTTP (fetch)  ┌───────────────────────────────────────────┐
│ web/index.html│ ─────────────▶ │ src/server.ts (Bun.serve)                │
│ chat + tool   │ ◀───────────── │   - POST /api/chat                        │
│ calls visibles│                │   - sesiones en memoria (Map)             │
└──────────────┘                │        │                                   │
                                 │        ▼                                   │
                                 │ src/agent.ts — ciclo del agente           │
                                 │   - carga agent/prompt.md (comportamiento)│
                                 │   - carga src/knowledge/*.md (conocimiento)│
                                 │   - llama src/llm/anthropic.ts (adaptador)│
                                 │   - ejecuta src/tools/proveedor.ts        │
                                 └───────┬─────────────────────┬─────────────┘
                                         │                     │
                                  fixtures/ (solo lectura)   out/ (escritura)
```

- **Comportamiento** → `agent/prompt.md` (texto plano, editable sin tocar código).
- **Conocimiento** → `src/knowledge/registro-proveedor.md` (reglas de negocio:
  identificadores por país, vigencias, qué es humano y qué es del agente).
  Se concatena al system prompt en `agent.ts::cargarSystemPrompt()`, así que el
  modelo siempre lo tiene disponible sin necesitar una herramienta de
  búsqueda adicional (ver trade-off #2).
- **Ejecución** → `src/tools/proveedor.ts`. Es la única pieza que toca el
  sistema de archivos y la única fuente de valores que el modelo puede citar.

## 3. Ciclo del agente

Implementado en `src/agent.ts::correrTurno`:

1. Se agrega el mensaje del usuario al historial de la sesión.
2. Se llama al adaptador LLM con el historial completo + el system prompt +
   las definiciones de herramientas (JSON Schema generado desde los esquemas
   `zod` con `zod-to-json-schema`).
3. Si el modelo pide una o más herramientas (`tool_use`), se ejecutan todas
   con `src/tools/proveedor.ts`, se registran en `toolCalls` (lo que ve el
   front) y en `out/<caso>/log.jsonl`, y su resultado se agrega al historial
   como `tool_result`.
4. Se repite desde el paso 2 hasta que el modelo responda solo con texto
   (fin del turno) o se alcance el **tope de 25 iteraciones** (`TOPE_ITERACIONES`
   en `agent.ts`), caso en el que se le avisa al usuario qué se alcanzó a
   hacer.
5. **Confirmación humana**: el prompt instruye al modelo a no llamar
   `proveedor_simular_envio` con `confirmado: true` salvo que el usuario lo
   haya confirmado explícitamente en el mensaje inmediatamente anterior. Como
   defensa en profundidad, la herramienta misma rechaza la llamada si
   `confirmado !== true` (ver `simular_envio` en `proveedor.ts`), y el
   **backend** (`agent.ts`, `envioAutorizado`) bloquea la herramienta si la
   respuesta anterior del agente no pidió confirmación o si el mensaje actual
   del usuario no es una confirmación explícita y aislada — así la
   regla no depende solo de que el modelo "se porte bien". El backend además
   detecta heurísticamente si la respuesta final contiene una pregunta de
   confirmación (`detectaNecesitaConfirmacion`) y se lo señala al front con
   `needsConfirmation`, que resalta un banner.

## 4. Elección del modelo

**Proveedor:** Anthropic · **Modelo:** `claude-sonnet-5` (configurable por
`ANTHROPIC_MODEL`). Se eligió porque:
- Tiene soporte nativo y maduro de *tool use* con esquema JSON estricto, que
  es el corazón del reto.
- Es el modelo con el que se construyó esta solución (ver sección 9), así
  que su comportamiento con tool-use ya estaba validado end-to-end durante
  el desarrollo.

**Costo estimado por caso procesado:** un caso completo ("procesa el caso
X") toma ~4 llamadas a herramienta en 1-2 turnos del modelo: ronda de
tool-use más ronda de respuesta final. Con prompts de ~1.5–2K tokens de
entrada (system + conocimiento + historial corto) y ~300–500 tokens de
salida por turno, un caso completo ronda los 4K–6K tokens totales. A precio
de Claude Sonnet (orden de USD 3 / millón tokens entrada, USD 15 / millón
salida), el costo por caso procesado es del orden de **USD 0.01–0.02**.

## 5. Diseño del portal web (sección 7.4 del PRD)

Para el caso `pa-logistica-istmo` (formato `portal`), el agente **no**
automatiza el portal: genera `out/<caso>/valores-portal.md` con los valores
listos para copiar (ver `generarValoresPortal` en `proveedor.ts`). Diseño
para una fase futura:

- **Estrategia:** un navegador controlado por el agente (Playwright) con
  pasos explícitos y revisables (no un LLM "sueltos" clickeando libremente),
  con cada acción (llenar campo X, clic en "Siguiente") como una herramienta
  separada y loggeada, igual que `proveedor_*`. Límites conocidos: CAPTCHA,
  MFA y cambios de layout del portal rompen el flujo y requieren
  intervención humana inmediata.
- **Credenciales:** nunca en el repositorio, nunca en el prompt, nunca en
  logs. Vivirían en un secret manager (p.ej. variables de entorno inyectadas
  en runtime o un vault), y las ingresa un humano en el primer login o un
  paso de autenticación delegada; el agente nunca las ve en texto plano.
- **Humano vs. agente:** el agente prepara y valida los valores (igual que
  hoy). El ingreso de credenciales y el clic final en "Enviar"/"Guardar" son
  **siempre humanos** — igual que la firma y el envío en este reto.

## 6. Decisiones y trade-offs

1. **Fetch directo a la API de Anthropic en vez del SDK oficial.**
   Alternativa descartada: `@anthropic-ai/sdk`. Se usó `fetch` nativo para
   que cada campo de la petición HTTP (`model`, `system`, `messages`,
   `tools`) sea explícito y fácil de explicar línea por línea en la defensa,
   al costo de reimplementar manualmente el manejo de reintentos/streaming
   que el SDK ya resuelve.

2. **Conocimiento concatenado al system prompt, no una herramienta de
   búsqueda.** Alternativa descartada: una herramienta `consultar_conocimiento`
   que el modelo invoque. Se descartó porque el documento es corto (~1 página)
   y cabe sin problema en el contexto; una herramienta de búsqueda habría
   sumado una llamada extra por turno sin beneficio real a esta escala. Si
   el conocimiento creciera (varios procesos, no solo "registro proveedor"),
   sí convendría convertirlo en una herramienta de recuperación.

3. **Sesiones en memoria (`Map`), no en archivo ni base de datos.**
   Alternativa descartada: persistir en `out/sessions/*.json`. El PRD
   explícitamente permite memoria o archivo y prohíbe base de datos; se
   eligió memoria por simplicidad, con el costo de que la sesión se pierde
   si el proceso se reinicia — aceptable para este reto, no para producción.

4. **Front en HTML + JS plano, sin framework.** Alternativa descartada:
   React. Se descartó para evitar un paso de build (Vite/webpack) que
   complique el "un comando levanta todo" del requisito no funcional de
   Arranque, dado que el chat no necesita componentes complejos.

## 7. Supuestos

- Los fixtures representan la variabilidad real de los clientes (el PRD lo
  dice explícitamente); en producción habrá plantillas peores y campos no
  anticipados.
- El repositorio maestro (`maestro.json`) está actualizado; en producción
  se necesita un dueño del dato que lo mantenga vigente.
- "País" en el maestro y en las plantillas se interpreta como el país del
  **cliente que pide el registro**, no el país de Periferia (que es CO fijo).
- Cuando una plantilla pide un campo que el glosario no resuelve (p.ej.
  "Referencias comerciales", "Número de contribuyente especial"), se trata
  como `faltante` aunque sea opcional en la plantilla — el PRD no distingue
  faltantes obligatorios de opcionales para esta regla, así que se optó por
  ser explícito siempre y dejar que el humano decida si importa.
- El campo "País" cuando se pide como dato de Periferia se llena con el
  código ISO (`CO`) tal como está en el maestro, no con el nombre completo
  ("Colombia") — una mejora razonable sería formatearlo, pero no estaba en
  el alcance de los criterios de aceptación.

## 8. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| HU-1 Leer la solicitud | Hecho | Hoy solo lee JSON normalizado; en producción tendría que parsear correos y adjuntos reales (Excel/PDF subidos, no solo su descripción en JSON). |
| HU-2 Mapear campos al maestro | Hecho | El glosario es estático; en producción convendría matching difuso (fuzzy) para sinónimos no listados, siempre marcándolos `requiere_confirmacion` en vez de autoaceptarlos. |
| HU-3 Generar formulario (xlsx) | Hecho (P0) | Hoy se genera un libro nuevo con la posición de celdas dada; en producción habría que escribir sobre el archivo Excel real del cliente (adjunto), preservando su formato. |
| HU-3 Generar formulario (pdf) | Hecho (P1) | Es un PDF generado, no un AcroForm rellenado (aceptado explícitamente por el PRD). Producción probablemente requiera rellenar el PDF real del cliente. |
| HU-3 Generar formulario (portal) | Hecho (P2, diseño) | Solo diseño + valores para copiar, como pide el PRD; implementación real queda para una fase posterior (sección 5). |
| HU-4 Armar paquete para firma | Hecho | Copia de soportes y checklist funcionan; en producción el "paquete" debería ser un adjunto real de correo, no una carpeta local. |
| HU-4 Confirmación antes de enviar | Hecho | Doble gate (prompt + herramienta); en producción además convendría un gate de UI (botón explícito), no solo lenguaje natural. |
| HU-5 Manejo de errores | Hecho | Todas las herramientas devuelven `{ ok, data }` / `{ ok: false, error }`, nunca lanzan; probado con caso inexistente y plantilla ausente. |

## 9. Uso de IA

Esta solución se construyó con **Claude** (Claude Code / Claude en modo
agente, el mismo asistente con el que Periferia conversó este proceso),
usado para:
- Generar la estructura completa del proyecto (tools, adaptador LLM, ciclo
  del agente, servidor, front, `demo.ts`) a partir de este PRD.
- Redactar la documentación (`README.md`, este `SOLUCION.md`).
- Verificar el comportamiento corriendo `demo.ts` contra los 4 fixtures
  reales y ajustando la lógica de mapeo/vigencia de soportes hasta que el
  resultado coincidiera con las reglas de negocio del PRD (identificadores
  extranjeros, soportes vencidos).

Se descartaron explícitamente estas sugerencias iniciales:
- Usar el SDK oficial de Anthropic (ver trade-off #1: se prefirió fetch
  directo por transparencia).
- Una base de datos SQLite para sesiones (el PRD la excluye como no-objetivo).

El candidato (Juan Esteban Paca) puede explicar cada archivo y cada
decisión de este documento; lo que no pudo verificar en vivo fue la llamada
real a la API de Anthropic con una clave de producción (se validó el
servidor arrancando y sirviendo `/api/health` y el front, y toda la lógica
de negocio vía `demo.ts`, que no depende de ninguna clave).

## 10. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| El modelo "completa" un campo faltante con un valor plausible. | Las herramientas son la única fuente de valores; el prompt lo prohíbe explícitamente y el diseño no le da al modelo ninguna otra forma de "saber" un dato. |
| Fuga de datos bancarios en el correo o el chat. | RN2 ya implementada: datos bancarios solo si la plantilla los pide explícitamente, nunca en el borrador de correo. |
| El usuario "fuerza" un envío sin confirmar (prompt injection, ambigüedad). | Triple gate: el prompt, la herramienta (`confirmado !== true`) y el backend, que solo deja pasar el envío si el agente preguntó en el turno anterior y el usuario confirmó explícitamente en un mensaje aparte. |
| Clave de API filtrada. | Solo vive en variable de entorno del backend; nunca se expone en `/api/health`, el front ni los logs (`out/log.jsonl` solo registra nombre de herramienta y resumen, no argumentos completos ni la clave). |
| Gasto descontrolado de la clave por una sesión larga. | Tope de iteraciones por turno (25) y tope de tokens por sesión (`TOPE_TOKENS_SESION`, configurable). |
| Repositorio maestro desactualizado. | Fuera del alcance del agente: requiere un dueño del dato y un proceso de actualización periódica, no una solución técnica de este reto. |
