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
   (fin del turno) o se alcance el **tope de iteraciones** (25 por defecto, configurable con `TOPE_ITERACIONES`;
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
   confirmación (`detectaNecesitaConfirmacion`, que solo mira las preguntas
   "¿…?" sobre envío o firma y se apaga si el envío ya ocurrió en ese turno) y
   se lo señala al front con `needsConfirmation`, que muestra una tarjeta con
   botones "Sí, confirmo el envío" / "Revisar antes".
6. **Eventos en vivo**: `correrTurno` acepta un callback `onEvento` que
   emite `herramienta_inicio`, `herramienta_fin` y `texto_parcial`.
   `POST /api/chat/stream` los envía como NDJSON y el front ilumina el
   pipeline de 5 pasos a medida que el agente trabaja.
7. **Consumo**: cada respuesta del modelo trae `uso` (tokens de entrada y
   salida); `correrTurno` los suma y el servidor los acumula por sesión para
   aplicar `TOPE_TOKENS_SESION`. El front muestra el consumo de la sesión.

## 4. Elección del modelo

**Proveedor:** Anthropic · **Modelo:** `claude-sonnet-5` (configurable por
`ANTHROPIC_MODEL`). Se eligió porque:
- Tiene soporte nativo y maduro de *tool use* con esquema JSON estricto, que
  es el corazón del reto.
- Es el modelo con el que se construyó esta solución (ver sección 9), así
  que su comportamiento con tool-use ya estaba validado end-to-end durante
  el desarrollo.

**Costo medido por caso procesado (despliegue real, `claude-sonnet-5`):**
el consumo se mide en vivo (el front muestra los tokens de la sesión). En la
prueba sobre el link público:

| Turno | Tokens (entrada + salida) |
|---|---|
| "Procesa el caso hn-agroexport-sula" (4 herramientas, 5 llamadas al modelo) | ≈ 25.200 |
| "Sí, confirmo el envío" (1 herramienta, 2 llamadas al modelo) | ≈ 13.500 |

El grueso es entrada: en cada vuelta del ciclo se reenvía el system prompt
+ conocimiento + definiciones de herramientas + historial con los
resultados de las herramientas. Con precio de lista de Sonnet (USD 3 por
millón de tokens de entrada y USD 15 por millón de salida; verificar la
tarifa vigente en la página de precios de Anthropic), un caso completo
cuesta del orden de **USD 0,08–0,11** y la confirmación otros ~USD 0,05. A
8–12 solicitudes al mes, el costo mensual queda por debajo de **USD 2**.

Optimizaciones si el volumen creciera: *prompt caching* del bloque fijo
(system + conocimiento + herramientas), resumir los resultados grandes de
herramientas antes de devolverlos al modelo (p. ej. no reenviar el mapeo
completo) y ejecutar los pasos 1–4 en una sola herramienta "procesar_caso".
El tope `TOPE_TOKENS_SESION` (200.000 por defecto) acota el gasto de una
sesión a menos de ~USD 1.

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
   Arranque. Aun así el front es interactivo: pipeline en vivo, tarjetas de
   herramientas, panel de resultado con descargas, confirmación con botones,
   modo oscuro y diseño responsive.

5. **Streaming NDJSON en vez de WebSockets o SSE.** Alternativa descartada:
   WebSocket. Un `fetch` con `ReadableStream` basta para empujar eventos del
   servidor al front en un solo turno, sin protocolo extra ni reconexión;
   `/api/chat` (respuesta única) se mantiene para clientes simples y pruebas.

6. **Vigencias contra una fecha de referencia configurable.** Por defecto
   se evalúan contra el día de hoy (lo correcto en producción), pero
   `FECHA_REFERENCIA` permite fijarla para que demos y pruebas sean
   reproducibles. La vigencia es inclusiva: un soporte vale todo el día de
   `vigencia_hasta`.

### Dependencias (PRD §8)

| Dependencia | Para qué | Por qué esta |
|---|---|---|
| `zod` | Esquemas de los argumentos de las herramientas y validación antes de ejecutar | Obligatoria por el PRD |
| `zod-to-json-schema` | Convertir los esquemas zod al JSON Schema que espera el modelo | Evita mantener dos definiciones de cada herramienta |
| `exceljs` | Escribir `formulario.xlsx` en la hoja y celda exactas de la plantilla | Maneja hojas y celdas por dirección (`C3`) sin dependencias nativas |
| `pdf-lib` | Generar `formulario.pdf` | Puro TypeScript; también sirve para rellenar AcroForms reales en una fase posterior |
| `typescript`, `bun-types`, `@types/node` (dev) | Tipado estricto y `tsc --noEmit` | Solo desarrollo |

No se usa el SDK de Anthropic (trade-off 1) ni framework web: Bun sirve el
API y el front con `Bun.serve`.

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
- "Copias de los soportes exigidos que existan" (HU-4) se interpreta
  literalmente: al paquete van todos los soportes exigidos que están en el
  repositorio, incluidos los vencidos, y `checklist.md` marca cuáles están
  vencidos o ausentes. Así la analista ve el documento que debe renovar.
- Las etiquetas tributarias genéricas ("Identificación tributaria",
  "Número de identificación fiscal") siempre quedan `requiere_confirmacion`
  con el equivalente del país propuesto (NIT en CO), incluso para clientes
  colombianos (HU-1). Una etiqueta explícita "NIT" en Colombia se llena directo.
- "Fecha de ejecución" (HU-4) es la fecha del servidor; `FECHA_REFERENCIA`
  permite fijarla para pruebas y demos.
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
| HU-4 Confirmación antes de enviar | Hecho | Triple gate (prompt + herramienta + backend) y botón explícito en la UI. En producción el OK debería quedar firmado con la identidad del usuario (auditoría), no solo en el historial de chat. |
| HU-5 Manejo de errores | Hecho (plantilla corrupta, solicitud corrupta, caso inexistente, soporte ausente, formato no soportado, timeout del modelo) | Todas las herramientas devuelven `{ ok, data }` / `{ ok: false, error }`, nunca lanzan; probado con caso inexistente, rutas maliciosas (`../`) y argumentos inválidos (ver `tests/reto.test.ts`). |

## 9. Uso de IA

Asistente usado: **Claude** (Anthropic), en modo agente con acceso a
terminal y navegador. Tareas:

- **Construcción:** estructura del proyecto a partir del PRD
  (herramientas, adaptador LLM, ciclo del agente, servidor, `demo.ts`) y
  borradores de `README.md` y este documento.
- **QA contra el PRD:** correr `demo.ts`, `tsc` y el agente con la API
  real; revisar cada HU, RN y CA. Encontró y corrigió, entre otros: el gate
  de confirmación que dependía solo del modelo, el tope de tokens que no se
  contabilizaba, soportes viejos que quedaban en el paquete y rutas `../`
  que se salían de `out/`. El detalle está en `QA.md`.
- **Pruebas:** la suite `tests/reto.test.ts` (65 pruebas sin modelo, con
  adaptadores simulados para el gate y los errores del proveedor).
- **Front:** rediseño de `web/index.html` (pipeline en vivo, tarjetas de
  herramientas, panel de resultado, confirmación con botones).
- **Despliegue:** `Dockerfile` y publicación en Render.

Se descartaron explícitamente estas sugerencias:
- Usar el SDK oficial de Anthropic (trade-off #1: se prefirió fetch
  directo por transparencia).
- Una base de datos SQLite para sesiones (el PRD la excluye como no-objetivo).
- Copiar al paquete solo los soportes vigentes: se cambió para seguir el
  texto de HU-4 (copias de los exigidos que existan, con vencidos marcados).
- Un modo "demo sin clave" con modelo simulado en el despliegue: se dejó
  solo en las pruebas para no confundir al evaluador sobre qué es real.

El candidato (Juan Esteban Paca) puede explicar cada archivo y cada
decisión de este documento. La solución se verificó de punta a punta con la
API real de Anthropic en el despliegue público (procesar un caso, confirmar
el envío en un turno aparte y el caso negativo "procésalo y envíalo ya",
que el backend bloquea), además de `demo.ts` y `bun test`.

## 10. Riesgos de llevar esto a producción

| Riesgo | Mitigación |
|---|---|
| El modelo "completa" un campo faltante con un valor plausible. | Las herramientas son la única fuente de valores; el prompt lo prohíbe explícitamente y el diseño no le da al modelo ninguna otra forma de "saber" un dato. |
| Fuga de datos bancarios en el correo o el chat. | RN2 ya implementada: datos bancarios solo si la plantilla los pide explícitamente, nunca en el borrador de correo. |
| El usuario "fuerza" un envío sin confirmar (prompt injection, ambigüedad). | Triple gate: el prompt, la herramienta (`confirmado !== true`) y el backend, que solo deja pasar el envío si el agente preguntó en el turno anterior y el usuario confirmó explícitamente en un mensaje aparte. |
| Clave de API filtrada. | Solo vive en variable de entorno del backend; nunca se expone en `/api/health`, el front ni los logs (`out/log.jsonl` solo registra nombre de herramienta y resumen, no argumentos completos ni la clave). |
| Gasto descontrolado de la clave por una sesión larga. | Tope de iteraciones por turno (25) y tope de tokens por sesión (`TOPE_TOKENS_SESION`, configurable), ambos cubiertos por pruebas. |
| Repositorio maestro desactualizado. | Fuera del alcance del agente: requiere un dueño del dato y un proceso de actualización periódica, no una solución técnica de este reto. |

## 11. Verificación

| Qué | Cómo | Resultado |
|---|---|---|
| Lógica de negocio sin modelo | `bun run demo.ts` | 4 casos procesados; envío sin confirmar rechazado en los 4 |
| Pruebas automáticas | `bun test` | 65 pruebas: HU-1..HU-5, RN1..RN5, CA1..CA5, campo ambiguo, plantilla y solicitud corruptas, soporte ausente, portal "formato no soportado", timeout del proveedor, clave fuera de los errores, módulo bonus idéntico a la app, conteo de tokens y determinismo |
| Tipos | `bunx tsc --noEmit` | Sin errores en modo estricto |
| Agente real | Link público con la API de Anthropic | Flujo de 5 pasos, resumen fiel a los fixtures, envío solo tras confirmación en turno aparte, caso negativo bloqueado |
