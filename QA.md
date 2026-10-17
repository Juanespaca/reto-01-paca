# QA — Reto 1: Agente "Registro como Proveedor"

Fecha de la revisión: 17 de octubre de 2026 · Versión revisada: commit `main` desplegado en
**https://reto-01-paca.onrender.com**

## 1. Alcance y fuentes

| Fuente | Uso en este QA |
|---|---|
| Instructivo del reto (PDF "Detalle instrucciones reto 1") | Entregables obligatorios (sección 2) |
| Fixtures `fixtures/reto-01/` | Valores esperados por caso (sección 4) |
| `src/knowledge/registro-proveedor.md` y `SOLUCION.md` | Reglas de negocio (identificadores, vigencias, datos bancarios, humano vs. agente) |
| `PRD.md` | **No estaba en el paquete revisado.** Las historias (HU-1..HU-5) y reglas se verificaron según como las cita `SOLUCION.md`; falta un cruce línea por línea contra el PRD original (ver sección 9). |

Métodos usados:

- **Automático sin modelo:** `bun test` (52 pruebas), `bun run demo.ts` y `bunx tsc --noEmit`.
- **Interfaz con modelo simulado:** navegador automatizado (Playwright) en escritorio 1440×900 y móvil 390×844, en modo claro y oscuro.
- **En vivo con el modelo real:** sesiones manuales sobre el link público con `claude-sonnet-5`.

Leyenda: ✅ cumple · ⚠️ cumple con observación · ❌ no cumple

## 2. Entregables del instructivo

| # | Requisito | Evidencia | Estado |
|---|---|---|---|
| E1 | Agente conversacional completo en TypeScript con Bun o Node 20+ | Bun 1.x, TypeScript estricto (`tsc --noEmit` sin errores) | ✅ |
| E1.1 | System prompt separado en `agent/prompt.md` | Se carga en `agent.ts::cargarSystemPrompt()`; el conocimiento de negocio vive aparte en `src/knowledge/` | ✅ |
| E1.2 | Herramientas tipadas con zod en `src/tools/proveedor.ts` | 5 herramientas con esquemas zod; se convierten a JSON Schema para el modelo | ✅ |
| E1.3 | Lógica de backend separada | `src/server.ts` (HTTP), `src/agent.ts` (ciclo), `src/llm/` (adaptador de proveedor) | ✅ |
| E1.4 | Front de chat que permite interactuar con el agente | `web/index.html`: chat, casos con un clic, pruebas rápidas | ✅ |
| E1.5 | El front muestra las llamadas a herramientas | Tarjetas en vivo (streaming) con argumentos, resultado y estado; pipeline de 5 pasos | ✅ |
| E1.6 | El front resalta las solicitudes de confirmación humana | Tarjeta amarilla con botones "Sí, confirmo el envío" / "Revisar antes"; el envío bloqueado se marca en rojo | ✅ |
| E1.7 | Automatiza lectura → cruce con maestro → formulario Excel o PDF → paquete para firma | Ver sección 4 | ✅ |
| E2 | `demo.ts` procesa los casos sin modelo de lenguaje | Corre los 4 casos llamando directo a las herramientas; no necesita clave | ✅ |
| E2.1 | Robustez y determinismo | Limpia `out/` al inicio; las pruebas verifican que dos corridas den lo mismo; `FECHA_REFERENCIA` fija las vigencias | ✅ |
| E3 | Link público funcional | https://reto-01-paca.onrender.com (Render, Docker) | ⚠️ Plan gratuito: tarda unos 50 s en despertar tras inactividad |
| E4 | `SOLUCION.md`: arquitectura | Sección 2 | ✅ |
| E4.1 | `SOLUCION.md`: ciclo del agente | Sección 3: 7 pasos, incluye eventos en vivo y conteo de tokens | ✅ |
| E4.2 | `SOLUCION.md`: decisiones de diseño | Sección 6: 6 decisiones con la alternativa descartada | ✅ |
| E4.3 | `SOLUCION.md`: análisis de costos del modelo | Sección 4, con tokens **medidos** en el despliegue real | ✅ |
| E4.4 | `SOLUCION.md`: consideraciones de producción | Secciones 5 (portal), 8 (cobertura) y 10 (riesgos) | ✅ |

## 3. Arquitectura y contrato de herramientas

| ID | Verificación | Resultado |
|---|---|---|
| A1 | Toda herramienta devuelve un string JSON `{ok:true,data}` o `{ok:false,error}` y nunca lanza excepción | ✅ Prueba "todas las herramientas responden JSON string con ok booleano" |
| A2 | Argumentos inválidos devuelven error, no rompen el ciclo | ✅ Validación zod en `ejecutarHerramienta` |
| A3 | Tope de 25 iteraciones por turno | ✅ Probado con un modelo que llama herramientas sin parar: se detiene en 25 y avisa |
| A4 | Tope de tokens por sesión (`TOPE_TOKENS_SESION`) | ✅ Corregido en este QA: antes el contador nunca se incrementaba (ver sección 8) |
| A5 | La clave de API no aparece en el front, `/api/health` ni los logs | ✅ `/api/health` solo devuelve proveedor y modelo |
| A6 | Proveedor de modelo intercambiable | ✅ Interfaz `AdaptadorLLM`; las pruebas usan adaptadores simulados sin tocar el ciclo |
| A7 | Descarga de archivos sin salirse de `out/<caso>` | ✅ `../` y nombres de caso inválidos devuelven 400 o 404 |

## 4. Historias de usuario por caso (valores esperados de los fixtures)

| Caso | País / ID tributario | Formato | Llenos | Por confirmar | Faltantes | Soportes con problema | Listo para firma* |
|---|---|---|---|---|---|---|---|
| co-industrias-delta | CO / NIT | xlsx | 17 | 0 | 0 | Cámara de Comercio vencida | No |
| ec-corp-andina | EC / RUC | pdf | 13 | 1 (RUC) | 1 (N.º contribuyente especial) | Cámara vencida; certificado de cumplimiento tributario ausente | No |
| hn-agroexport-sula | HN / RTN | xlsx | 9 | 1 (RTN) | 1 (Referencias comerciales) | Cámara vencida; parafiscales vencidos | No |
| pa-logistica-istmo | PA / RUC | portal | 8 | 1 (RUC) | 0 | Cámara vencida | No |

\* Evaluado al 15–17 de octubre de 2026. Al 15 de septiembre de 2026, CO y PA quedan listos para firma (cubierto por prueba).

| ID | Historia / criterio | Cómo se verificó | Estado |
|---|---|---|---|
| HU-1 | Leer la solicitud: país, formato, campos y soportes | Prueba por caso contra `solicitud.json` y `soportes-exigidos.json`; en vivo el agente lo llama primero | ✅ |
| HU-2 | Mapear cada campo al maestro vía glosario | Cada campo cae en exactamente una categoría; conteos de la tabla | ✅ |
| HU-2 / CA2 | Ningún valor inventado | Prueba: todo valor lleno es idéntico al del maestro en su ruta. En vivo el resumen del modelo coincidió con los datos de las herramientas | ✅ |
| HU-2 | Campo sin fuente → faltante, no se completa a criterio | Contribuyente especial y Referencias comerciales quedan faltantes | ✅ |
| HU-3 | Excel en las celdas de la plantilla | Prueba que relee el `.xlsx`: etiqueta y valor en cada celda indicada (CO y HN) | ✅ |
| HU-3 | PDF | Archivo `%PDF-` válido con todos los campos y los obligatorios marcados con `*` | ✅ (PDF generado, no AcroForm del cliente; ver SOLUCION §8) |
| HU-3 | Portal: valores para copiar | `valores-portal.md` y diseño de automatización en SOLUCION §5 | ✅ |
| HU-4 | Paquete con formulario, soportes vigentes, checklist y borrador de correo | Prueba de archivos y checklist completo por caso | ✅ |
| HU-4 | Soporte vencido o ausente bloquea `listo_para_firma` | Pruebas de los 4 casos y del caso que sí queda listo | ✅ |
| HU-4 | Solo se copian los soportes vigentes | Prueba; corregido en este QA (antes quedaban copias de corridas anteriores) | ✅ |
| HU-4 | Confirmación humana antes de enviar | Sección 6 | ✅ |
| HU-5 | Errores claros, sin JSON crudo ni trazas al usuario | En vivo: el caso inexistente se explica en lenguaje natural; el front muestra mensajes amigables | ✅ |

## 5. Reglas de negocio

| ID | Regla | Evidencia | Estado |
|---|---|---|---|
| RN1 | NIT colombiano se llena directo | Prueba CO: NIT = maestro | ✅ |
| RN1 | RUC (EC, PA) y RTN (HN) nunca se llenan en silencio: van a `requiere_confirmacion` con motivo y valor propuesto | Prueba parametrizada; en vivo el agente lo explica | ✅ |
| RN2 | Datos bancarios solo si la plantilla los pide | Prueba: HN no tiene campos `banco.*`; EC sí los pide y sí se llenan | ✅ |
| RN2 | Datos bancarios nunca en el borrador de correo | Prueba en los 4 borradores (número de cuenta y SWIFT) | ✅ |
| RN | Vigencia de soportes | Inclusiva hasta el día de `vigencia_hasta`; fecha de referencia configurable | ✅ |
| RN | Firmar y enviar son decisiones humanas | El agente nunca firma; el envío es simulado y exige confirmación | ✅ |

## 6. Gate de confirmación humana (crítico)

| ID | Escenario | Automático | En vivo (modelo real) | Estado |
|---|---|---|---|---|
| G1 | "Procesa el caso X" → resume y pregunta antes de enviar, sin enviar | ✅ | ✅ (ec-corp-andina, hn-agroexport-sula) | ✅ |
| G2 | Confirmación en un mensaje aparte → envío simulado | ✅ | ✅ (con texto y con el botón "Sí, confirmo el envío") | ✅ |
| G3 | "Procésalo y envíalo ya" en un solo mensaje → no envía | ✅ Modelo "desobediente" bloqueado por el backend | ✅ El modelo intentó enviar y el backend lo bloqueó | ✅ |
| G4 | "Sí" sin que el agente haya preguntado → no envía | ✅ | — | ✅ |
| G5 | `confirmado:false` → rechazado por la herramienta | ✅ | — | ✅ |
| G6 | Envío de un caso sin paquete armado → rechazado | ✅ | — | ✅ |
| G7 | Paquete "no listo para firma" | — | ✅ El agente advierte y pide confirmación explícita de enviar igual | ✅ |
| G8 | La tarjeta de confirmación no aparece por error (p. ej. "¿necesitas algo más?" después de enviar) | ✅ | ✅ | ✅ Corregido en este QA |

## 7. Requisitos no funcionales y front

| ID | Verificación | Estado |
|---|---|---|
| NF1 | Arranque en un comando (`bun install && bun run dev`) y despliegue con Dockerfile | ✅ |
| NF2 | Determinismo (`out/` limpio, `FECHA_REFERENCIA`, prueba de doble corrida) | ✅ |
| NF3 | Costo acotado (25 iteraciones + tope de tokens) y medido | ✅ |
| NF4 | Seguridad: clave solo en variable de entorno; rutas de archivos saneadas; mensajes ≤ 4000 caracteres | ✅ |
| UI1 | Escritorio, tablet (paneles en cajón) y móvil 390 px sin scroll horizontal | ✅ |
| UI2 | Modo claro y oscuro con contraste legible | ✅ |
| UI3 | Sin errores de consola durante los flujos | ✅ |
| UI4 | Archivos generados descargables y con vista previa (md, txt, pdf) | ✅ |
| UI5 | Estados de carga: servidor despertando, "pensando", herramienta en curso | ✅ |
| UI6 | Uso de tokens de la sesión visible | ✅ |

## 8. Hallazgos corregidos durante el QA

| # | Severidad | Hallazgo | Corrección | Prueba |
|---|---|---|---|---|
| 1 | Alta | El "segundo gate" dependía de `confirmado`, un valor que pone el mismo modelo, así que "procésalo y envíalo ya" enviaba | Gate en el backend: exige pregunta previa del agente y confirmación explícita en un turno aparte | G3, G4 |
| 2 | Alta | El tope de tokens por sesión nunca se activaba (el contador no se sumaba) | `correrTurno` suma el uso y el servidor lo acumula | "correrTurno suma los tokens…" |
| 3 | Media | Al rearmar el paquete quedaban copias de soportes de corridas anteriores (un soporte ya vencido seguía en la carpeta) | El paquete se rearma desde cero | "solo se copian…" |
| 4 | Media | `simular_envio` aceptaba casos inexistentes y rutas `../` (escribía fuera de `out/`) | Validación del nombre de caso y paquete previo obligatorio | HU-5, G6 |
| 5 | Baja | Detección de confirmación fallaba con tildes ("envíe") y daba falsos positivos | Solo cuenta preguntas `¿…?` sobre envío o firma; se apaga tras un envío | G8 |
| 6 | Baja | Error crudo del proveedor llegaba al front | Mensaje amigable; el detalle va al log del servidor | — |
| 7 | Baja | El README decía `claude-sonnet-4-5` y el código usa `claude-sonnet-5` | Docs alineadas | — |
| 8 | Baja | Costo subestimado en SOLUCION (4–6K tokens por caso; lo medido son ~25K) | Sección 4 reescrita con datos medidos | — |

## 9. Observaciones abiertas (para tener listas en la defensa)

1. **PRD.md no revisado.** Falta cruzar línea por línea las historias, criterios de aceptación (CA) y reglas (RN) del PRD original, en especial la sección 7.4 (portal) y la 9.4 (módulo bonus en `modulo/`).
2. **Fecha de evaluación de vigencias.** Hoy los 4 paquetes salen "no listos" porque la Cámara de Comercio venció el 30-09-2026. Es correcto contra la fecha actual, pero conviene explicarlo; con `FECHA_REFERENCIA=2026-09-15`, CO y PA quedan listos.
3. **Sesiones en memoria + plan gratuito.** Si Render apaga el servidor por inactividad, se pierden la conversación y `out/`. Es aceptable para la demo (documentado en SOLUCION §6.3): basta recargar y empezar una sesión nueva.
4. **`out/` es compartido entre sesiones.** Dos personas procesando el mismo caso a la vez sobrescriben los mismos archivos. En producción iría separado por sesión o solicitud.
5. **El borrador de correo dice "firmado por el representante legal"** aunque el paquete no esté listo. Es un borrador para después de la firma; podría condicionarse al estado del paquete.
6. **"País" se llena con el código ISO `CO`**, no con "Colombia" (supuesto documentado en SOLUCION §7).
7. **Seguridad de la clave.** La API key se compartió en un chat durante el despliegue: hay que rotarla en console.anthropic.com y actualizarla en Render (Environment).

## 10. Cómo reproducir

```bash
bun install
bun test                      # 52 pruebas
bunx tsc --noEmit             # tipos
bun run demo.ts               # 4 casos sin modelo
FECHA_REFERENCIA=2026-09-15 bun run demo.ts   # vigencias a una fecha fija
cp .env.example .env && bun run dev            # http://localhost:3000 (requiere ANTHROPIC_API_KEY)
```

Guion de prueba en vivo (link público):

1. Clic en **Procesar** de *Corporación Andina* → ver el pipeline, las 4 herramientas y el panel de resultado.
2. **Sí, confirmo el envío** → envío simulado y `ENVIO-SIMULADO.md` en archivos generados.
3. **Nueva sesión** → prueba rápida *"procésalo y envíalo ya"* → la tarjeta del envío aparece en rojo como "bloqueado por el backend".
4. Prueba rápida *caso inexistente* → el error se explica en lenguaje claro.
