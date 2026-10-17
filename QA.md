# QA — Reto 1: Agente "Registro como Proveedor"

Revisión: 17 de octubre de 2026 · Versión: rama `main` desplegada en
**https://reto-01-paca.onrender.com** · Modelo: `claude-sonnet-5`

## 1. Alcance y método

Se cruzó **cada requisito del `PRD.md` (v2.0, 2026-09-03)** y del instructivo
del reto contra el código, las pruebas y la aplicación desplegada. Los 21
archivos de `fixtures/reto-01/` se compararon byte a byte con los originales
entregados por Periferia: son idénticos (no se modificaron).

Métodos usados:

- **Pruebas automáticas sin modelo:** `bun test` (65 pruebas), `bun run demo.ts` y `bunx tsc --noEmit`.
- **Interfaz:** navegador automatizado en escritorio y móvil, en modo claro y oscuro, con un modelo simulado.
- **En vivo con el modelo real:** sobre el link público, incluido el guion exacto de la sección 11 del PRD.

Leyenda: ✅ cumple · ⚠️ cumple con observación · ❌ no cumple

## 2. Demo del PRD §11 (en vivo, modelo real)

| Paso | Esperado según el PRD | Observado | Estado |
|---|---|---|---|
| 1. Prompt de la demo en una sesión nueva | Resumen estructurado, herramientas visibles, ruta `out/ec-corp-andina/`, faltantes, estado `listo_para_firma` y una pregunta al cierre | 4 herramientas visibles en vivo (leer, mapear, generar, paquete). Resumen: 13 llenos, RUC por confirmar, "Número de contribuyente especial" faltante, ruta del PDF, "NO listo para firma", Cámara de Comercio vencida y certificado de cumplimiento tributario ausente. Cierra con pregunta | ✅ |
| 2. "envía" | Solo procede tras una confirmación explícita | No llamó ninguna herramienta: resumió los pendientes y preguntó "¿Confirmas que quieres que envíe…?". La tarjeta de confirmación se resaltó en el front | ✅ |
| 3. Confirmación ("Sí, confirmo el envío") | Produce solo `ENVIO-SIMULADO.md` | Una sola herramienta (`proveedor_simular_envio`). En `out/ec-corp-andina/` aparece únicamente `ENVIO-SIMULADO.md` como archivo nuevo | ✅ |
| Caso negativo: "procésalo y envíalo ya" | No debe enviar sin confirmación en un turno aparte | El modelo intentó enviar y el backend lo bloqueó (tarjeta roja "bloqueado por el backend") | ✅ |

## 3. Historias de usuario (PRD §5)

| Criterio | Evidencia | Estado |
|---|---|---|
| **HU-1** Devuelve campos, país, formato y soportes | Prueba por caso contra `solicitud.json`, la plantilla y `soportes-exigidos.json` | ✅ |
| **HU-1** Campo ambiguo ("Identificación tributaria") → `requiere_confirmacion` con el equivalente del país | Caso sintético en Colombia: se marca ambiguo y se propone NIT. RUC (EC, PA) y RTN (HN) se marcan como identificador extranjero | ✅ |
| **HU-2** Tres estados: `lleno` con ruta, `faltante` o `requiere_confirmacion` | Cada campo cae en exactamente un estado; los llenos llevan `ruta` | ✅ |
| **HU-2** Nunca inventa un valor | Prueba: cada valor lleno es idéntico al del maestro en su ruta. En vivo, el resumen coincide con las herramientas | ✅ |
| **HU-2** Sinónimos del glosario resueltos automáticamente | "Nombre de la empresa", "Domicilio fiscal", "Nombre o razón social del proveedor", etc. | ✅ |
| **HU-2** Confianza < 0.8 | El mapeo es exacto por glosario (confianza 1); no hay mapeo difuso. Lo que no está en el glosario queda faltante | ⚠️ Decisión documentada en SOLUCION §8 |
| **HU-3 P0** `formulario.xlsx`: etiqueta y valor en la hoja y celda exactas | Prueba que relee el `.xlsx` (CO: 2 hojas, 17 celdas; HN: 11 celdas) | ✅ |
| **HU-3 P1** `formulario.pdf` con todos los campos en orden | PDF válido; campos en el orden de `plantilla-campos.json`, obligatorios marcados con `*` | ✅ |
| **HU-3 P2** Portal → "formato no soportado" + `valores-portal.md` | `{ formato: "portal", soportado: false, mensaje: "formato no soportado…" }` | ✅ |
| **HU-4** `paquete/` con formulario, copias de los soportes exigidos que existan, `checklist.md` y `borrador-correo.md` | Prueba de archivos; también copia `valores-portal.md` en el caso portal; no copia soportes no pedidos (ISO 9001) | ✅ |
| **HU-4** Soporte con `vigencia_hasta` anterior a la fecha de ejecución → vencido y bloquea | Cámara de Comercio (30-09-2026) y parafiscales (31-08-2026) vencidos | ✅ |
| **HU-4** Resumen + pregunta explícita antes de cualquier envío; "enviar" solo escribe `ENVIO-SIMULADO.md` | Sección 2 de este informe | ✅ |
| **HU-5** Plantilla corrupta, caso inexistente o formato no soportado: mensaje claro, sin traza, y el proceso continúa | Casos sintéticos: con plantilla corrupta igual se arma el paquete y el checklist; con solicitud corrupta el error es claro | ✅ |
| **HU-5** Ninguna herramienta lanza; siempre `{ok,data}` o `{ok:false,error}` | Prueba sobre las 5 herramientas con entradas inválidas | ✅ |

Valores verificados por caso (al 15–17 de octubre de 2026):

| Caso | ID tributario | Formato | Llenos | Por confirmar | Faltantes | Soportes con problema | Listo |
|---|---|---|---|---|---|---|---|
| co-industrias-delta | NIT (lleno) | xlsx | 17 | 0 | 0 | Cámara de Comercio vencida | No |
| ec-corp-andina | RUC | pdf | 13 | 1 | 1 | Cámara vencida; certificado de cumplimiento tributario ausente | No |
| hn-agroexport-sula | RTN | xlsx | 9 | 1 | 1 | Cámara y parafiscales vencidos | No |
| pa-logistica-istmo | RUC | portal | 8 | 1 | 0 | Cámara vencida | No |

## 4. Arquitectura y contrato (PRD §6)

| Requisito | Evidencia | Estado |
|---|---|---|
| Front: historial, entrada e indicador de "pensando" | `web/index.html` | ✅ |
| Front: cada llamada a herramienta con nombre, argumentos y resultado resumido | Tarjetas expandibles en vivo (streaming NDJSON) | ✅ |
| Front: resalta cuando el agente pide confirmación | Tarjeta con botones; el envío bloqueado se marca en rojo | ✅ |
| Backend: API del chat, ciclo con tope de iteraciones, sesión en memoria | `src/server.ts` y `src/agent.ts` | ✅ |
| Herramientas zod separadas del servidor e importables desde `demo.ts` | `src/tools/proveedor.ts` | ✅ |
| Adaptador LLM propio; cambiar de proveedor no toca el ciclo | Interfaz `AdaptadorLLM`; las pruebas usan adaptadores simulados | ✅ |
| System prompt en `agent/prompt.md` | Se carga desde el archivo | ✅ |
| Contrato §6.2: `description`, `args` zod con `.describe()`, `execute` devuelve string, nunca lanza; el backend valida antes de ejecutar | Las 5 herramientas | ✅ |
| Nombres `proveedor_<export>` y salidas de la tabla §6.2 | `leer_solicitud`, `mapear_campos`, `generar_formulario`, `armar_paquete` y `simular_envio` con los campos pedidos | ✅ |
| Separación comportamiento / conocimiento / ejecución (§6.5) | `agent/prompt.md` / `src/knowledge/` / `src/tools/` | ✅ |

## 5. Reglas del ciclo del agente (PRD §6.3)

| Regla | Evidencia | Estado |
|---|---|---|
| **CA1** Tope de iteraciones por turno; al alcanzarlo responde con lo que tiene | 25 por defecto (`TOPE_ITERACIONES`); prueba con un modelo que nunca termina | ✅ |
| **CA2** El modelo no afirma valores que no salieron de una herramienta | Prompt + herramientas como única fuente de datos; el modelo recibe la fecha de hoy para no "corregir" vigencias | ✅ |
| **CA3** Confirmación humana: pregunta explícita, procede solo con confirmación en el turno siguiente, el front lo resalta | Triple gate: prompt, herramienta y backend. Pruebas G1–G6 y demo §11 | ✅ |
| **CA4** Toda llamada visible en el chat y en `out/log.jsonl` | Log global `out/log.jsonl` (incluye intentos bloqueados) + tarjetas en el chat | ✅ |
| **CA5** Error de herramienta o del proveedor → mensaje claro y la sesión sigue | Timeout (`LLM_TIMEOUT_MS`), 401, 429 y 5xx con mensajes en español; la sesión conserva su historial | ✅ |

## 6. Reglas de negocio (PRD §7.3)

| Regla | Evidencia | Estado |
|---|---|---|
| **RN1** CO→NIT, EC/PE/PA→RUC, HN→RTN; el campo extranjero se llena con el NIT y se marca con la nota "identificador extranjero" | Pruebas EC, PA y HN; el motivo contiene "identificador extranjero" | ✅ |
| **RN2** Datos bancarios solo si la plantilla los pide; nunca en `borrador-correo.md` | HN no los pide (no aparecen); CO y EC sí. Ningún borrador contiene número de cuenta ni SWIFT | ✅ |
| **RN3** Vencido o ausente bloquea; un campo faltante no bloquea pero aparece en el checklist | `checklist.md` tiene la sección "Campos del formulario pendientes"; HN al 15-08-2026 queda listo con 1 faltante | ✅ |
| **RN4** Ninguna acción externa sin confirmación explícita en el turno inmediatamente anterior | Gate en el backend; prueba "sí sin pregunta previa → bloqueado" | ✅ |
| **RN5** `out/<caso>/log.jsonl` con `{ ts, herramienta, ok, resumen }` | Prueba de claves exactas | ✅ |

## 7. API mínima (PRD §6.4)

| Ruta | Estado |
|---|---|
| `POST /api/chat` → `{ reply, toolCalls[], needsConfirmation }` (+ `sessionId`, `uso`) | ✅ |
| `POST /api/chat/stream` (stream de eventos, opcional en el PRD) | ✅ |
| `GET /api/sessions/:id` | ✅ |
| `GET /api/health` → `{ ok, provider, model }` sin claves | ✅ |
| Documentada en el README | ✅ |

## 8. Requisitos no funcionales (PRD §8)

| Categoría | Evidencia | Estado |
|---|---|---|
| Arranque en un comando | `bun install && bun run dev`; también `Dockerfile` | ✅ |
| Determinismo de `demo.ts` | Limpia `out/`; prueba de doble corrida; `FECHA_REFERENCIA` fija las vigencias | ✅ |
| Seguridad: clave solo en el entorno del backend | No está en el repo (verificado), ni en el front, `/api/health`, los logs o los errores (prueba). Las herramientas no ejecutan shell. Datos 100 % ficticios | ✅ |
| Costo: tope de iteraciones y de tokens configurables | `TOPE_ITERACIONES` y `TOPE_TOKENS_SESION` (el contador de tokens se corrigió en este QA); consumo visible en el front | ✅ |
| Robustez: errores tipados, timeout al LLM, un caso malo no impide el siguiente | Pruebas HU-5, CA5 y casos sintéticos | ✅ |
| Legibilidad: TypeScript sin `any` | `tsc` estricto sin errores y 0 apariciones de `any` en `src/`, `tests/` y `demo.ts` | ✅ |
| Dependencias justificadas; zod obligatorio | Tabla en SOLUCION §6 | ✅ |

## 9. Entregables (PRD §9 e instructivo)

| Entregable | Estado |
|---|---|
| `SOLUCION.md` con las 10 secciones obligatorias (§9.1), incluido el uso de IA declarado | ✅ (más una sección 11 de verificación) |
| `README.md`: un comando, variables, `demo.ts`, link y acceso (público, sin clave) | ✅ |
| Link público activo (§9.3) | ⚠️ En el plan gratuito de Render tarda unos 50 s en despertar tras inactividad |
| Bonus §9.4: `modulo/agent.md` (frontmatter `description`, `mode: primary`, `permission {edit: deny, bash: deny}`), `tools/proveedor.ts` y `SKILL.md` (`name`, `description`) | ✅ Pruebas que verifican que las tres piezas son idénticas a las de la aplicación |
| §9.5: repo Git con historial, sin `node_modules/`, `out/` ni `.env` | ✅ |

## 10. Hallazgos corregidos durante el QA

| # | Severidad | Hallazgo | Corrección |
|---|---|---|---|
| 1 | Alta | El gate de confirmación dependía de `confirmado`, un valor que pone el mismo modelo: "procésalo y envíalo ya" enviaba | Gate en el backend (pregunta previa + confirmación explícita en un turno aparte) |
| 2 | Alta | El tope de tokens por sesión nunca se activaba | El ciclo suma el uso y el servidor lo acumula |
| 3 | Alta | El modelo no conocía la fecha y en vivo "dudaba" de las vigencias ("parece futura pero marcada vencida") | Se le inyecta la fecha de hoy y el prompt le indica no cuestionar las vigencias |
| 4 | Media | HU-1: "Identificación tributaria" en Colombia se llenaba sin marcarse como ambigua | Las etiquetas genéricas van siempre a `requiere_confirmacion` con el equivalente del país |
| 5 | Media | HU-4: el paquete no copiaba los soportes vencidos; el caso portal no incluía `valores-portal.md` | Se copian todos los exigidos que existen y el formulario de cualquier formato |
| 6 | Media | RN3: los campos faltantes no aparecían en `checklist.md` | Sección "Campos del formulario pendientes" en el checklist y en la respuesta |
| 7 | Media | HU-5: una plantilla corrupta tumbaba todo el caso | Advertencia clara; el paquete y el checklist se generan igual |
| 8 | Media | CA4: no existía `out/log.jsonl` global | Log global con el caso; incluye envíos bloqueados |
| 9 | Media | §8: sin timeout al proveedor LLM; errores genéricos | Timeout configurable y mensajes por tipo de error |
| 10 | Media | El paquete conservaba archivos de corridas anteriores | Se rearma desde cero |
| 11 | Media | `simular_envio` aceptaba casos inexistentes y rutas `../` | Validación del nombre del caso y paquete previo obligatorio |
| 12 | Baja | `any` en el adaptador y en las pruebas; tope de iteraciones no configurable | Tipos explícitos; `TOPE_ITERACIONES` |
| 13 | Baja | Detección de confirmación fallaba con tildes y daba falsos positivos | Solo cuentan preguntas `¿…?` sobre envío o firma |
| 14 | Baja | Costo subestimado en SOLUCION | Reescrito con tokens medidos (~25K por caso) |

## 11. Observaciones abiertas (para la defensa)

1. **Vigencias contra la fecha de hoy.** Los 4 paquetes salen "no listos" porque la Cámara de Comercio venció el 30-09-2026. Es lo que pide HU-4; con `FECHA_REFERENCIA=2026-09-15`, CO y PA quedan listos.
2. **Plan gratuito de Render.** El servidor se duerme por inactividad, tarda unos 50 s en despertar y pierde las sesiones en memoria y `out/`. Hay que abrir el link antes de la defensa.
3. **`out/` es compartido entre sesiones**: el PRD excluye multiusuario (§3.2). En producción iría separado por solicitud.
4. **HU-2 "confianza < 0.8"**: no hay mapeo difuso. Todo lo que no está en el glosario queda faltante, la opción más conservadora.
5. **"País" se llena con `CO`**, el código ISO del maestro (supuesto documentado).

## 12. Cómo reproducir

```bash
bun install
bun test                       # 65 pruebas
bunx tsc --noEmit              # tipos
bun run demo.ts                # 4 casos sin modelo
FECHA_REFERENCIA=2026-09-15 bun run demo.ts
cp .env.example .env && bun run dev    # requiere ANTHROPIC_API_KEY
```
