// src/tools/proveedor.ts
//
// Herramientas del agente "Registro como Proveedor".
// Son la ÚNICA fuente de valores que el modelo puede afirmar (regla CA2 del PRD).
// Cada herramienta devuelve SIEMPRE un string JSON con { ok, data } o { ok: false, error }.
// Ninguna lanza excepción hacia quien la llama.

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// ---------------------------------------------------------------------------
// Rutas base. Todo se resuelve desde ctx.directory, nunca con rutas absolutas
// propias, para que la herramienta funcione igual sin importar quién la invoque
// (servidor HTTP, demo.ts o el módulo reutilizable).
// ---------------------------------------------------------------------------

const FIXTURES_ROOT = (dir: string) => path.join(dir, "fixtures", "reto-01");
const CASOS_ROOT = (dir: string) => path.join(FIXTURES_ROOT(dir), "casos");
const REPO_ROOT = (dir: string) => path.join(FIXTURES_ROOT(dir), "repositorio");
const OUT_ROOT = (dir: string) => path.join(dir, "out");

type Ctx = { directory: string; sessionId: string };

// Identificador tributario esperado por país (regla de negocio RN1 del PRD).
const IDENTIFICADOR_POR_PAIS: Record<string, string> = {
  CO: "NIT",
  EC: "RUC",
  PE: "RUC",
  PA: "RUC",
  HN: "RTN",
};

// Etiquetas genéricas: no dicen qué identificador quieren (HU-1). Se reportan
// como requiere_confirmacion proponiendo el equivalente del país del cliente.
const ETIQUETAS_TRIBUTARIAS_GENERICAS = new Set([
  "identificación tributaria",
  "identificacion tributaria",
  "número de identificación fiscal",
  "numero de identificacion fiscal",
]);

// Etiquetas que el glosario resuelve a "nit" pero que en realidad piden el
// identificador tributario del PAÍS DEL CLIENTE, no necesariamente el NIT
// colombiano que Periferia tiene en su maestro.
const ETIQUETAS_IDENTIFICADOR_TRIBUTARIO = new Set([
  "nit",
  "ruc",
  "rtn",
  "identificación tributaria",
  "identificacion tributaria",
  "número de identificación fiscal",
  "numero de identificacion fiscal",
]);

function readJson<T = unknown>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function ok(data: unknown) {
  return JSON.stringify({ ok: true, data });
}
function fail(error: string) {
  return JSON.stringify({ ok: false, error });
}

// RN5: cada ejecución queda en out/<caso>/log.jsonl con { ts, herramienta, ok, resumen }.
// CA4: además, toda llamada queda en out/log.jsonl (registro global, con el caso).
export function logEvento(dir: string, caso: string, herramienta: string, okFlag: boolean, resumen: string) {
  try {
    const casoSeguro = /^[a-z0-9][a-z0-9-]*$/i.test(caso) ? caso : "_invalido";
    const ts = new Date().toISOString();
    const outDir = path.join(OUT_ROOT(dir), casoSeguro);
    fs.mkdirSync(outDir, { recursive: true });
    fs.appendFileSync(path.join(outDir, "log.jsonl"), JSON.stringify({ ts, herramienta, ok: okFlag, resumen }) + "\n");
    fs.appendFileSync(path.join(OUT_ROOT(dir), "log.jsonl"), JSON.stringify({ ts, caso: casoSeguro, herramienta, ok: okFlag, resumen }) + "\n");
  } catch {
    // El log nunca debe tumbar una herramienta.
  }
}

// Navega un objeto por una ruta tipo "banco.numero_cuenta" o
// "representante_legal.identificacion".
function getByPath(obj: Record<string, unknown>, rutaPunteada: string): unknown {
  return rutaPunteada
    .split(".")
    .reduce<unknown>((acc, key) => {
      if (acc && typeof acc === "object" && key in (acc as Record<string, unknown>)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, obj);
}

function normalizar(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

type CasoInfo = {
  solicitud: {
    id: string;
    de: string;
    para: string;
    asunto: string;
    fecha: string;
    pais: string;
    cliente: string;
    formato: "xlsx" | "pdf" | "portal";
    cuerpo: string;
    adjuntos: string[];
  };
  plantillaCeldas?: Array<{ hoja: string; celda_etiqueta: string; etiqueta: string; celda_valor: string }>;
  plantillaCampos?: Array<{ etiqueta: string; obligatorio: boolean }>;
  soportesExigidos: string[];
  advertencias: string[];
};

export function fechaReferencia(): Date {
  const env = process.env.FECHA_REFERENCIA;
  if (env && /^\d{4}-\d{2}-\d{2}$/.test(env)) return new Date(env + "T00:00:00Z");
  return new Date();
}

// Solo nombres de caso simples (evita rutas tipo "../../").
export function nombreCasoValido(caso: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(caso);
}

function leerJsonDelCaso<T>(archivo: string, caso: string): T {
  try {
    return readJson<T>(archivo);
  } catch {
    throw new Error(`El archivo ${path.basename(archivo)} del caso "${caso}" está corrupto o no es JSON válido.`);
  }
}

function cargarCaso(dir: string, caso: string): CasoInfo {
  if (!nombreCasoValido(caso)) {
    throw new Error(`El nombre de caso "${caso}" no es válido.`);
  }
  const base = path.join(CASOS_ROOT(dir), caso);
  if (!fs.existsSync(base)) {
    throw new Error(`El caso "${caso}" no existe en fixtures/reto-01/casos/.`);
  }
  const solicitud = leerJsonDelCaso<CasoInfo["solicitud"]>(path.join(base, "solicitud.json"), caso);
  const soportesPath = path.join(base, "soportes-exigidos.json");
  const advertencias: string[] = [];
  let soportesExigidos: string[] = [];
  try {
    soportesExigidos = fs.existsSync(soportesPath) ? leerJsonDelCaso<string[]>(soportesPath, caso) : [];
  } catch (e) {
    advertencias.push((e as Error).message);
  }

  // HU-5: una plantilla corrupta no detiene el proceso; se reporta y se
  // continúa con lo que sí se puede hacer (soportes, paquete, faltantes).
  const cargarPlantilla = <T>(archivo: string): T | undefined => {
    if (!fs.existsSync(archivo)) return undefined;
    try {
      return leerJsonDelCaso<T>(archivo, caso);
    } catch (e) {
      advertencias.push((e as Error).message);
      return undefined;
    }
  };

  return {
    solicitud,
    plantillaCeldas: cargarPlantilla(path.join(base, "plantilla-celdas.json")),
    plantillaCampos: cargarPlantilla(path.join(base, "plantilla-campos.json")),
    soportesExigidos,
    advertencias,
  };
}

function listaEtiquetas(info: CasoInfo): string[] {
  if (info.plantillaCeldas) return info.plantillaCeldas.map((c) => c.etiqueta);
  if (info.plantillaCampos) return info.plantillaCampos.map((c) => c.etiqueta);
  return [];
}

// ---------------------------------------------------------------------------
// HU-1 · proveedor_leer_solicitud
// ---------------------------------------------------------------------------

export const leer_solicitud = {
  description:
    "Lee la solicitud de un cliente (correo + plantilla) e identifica país, formato de salida, campos pedidos y soportes exigidos.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/"),
  },
  async execute(args: { caso: string }, ctx: Ctx) {
    try {
      const info = cargarCaso(ctx.directory, args.caso);
      const etiquetas = listaEtiquetas(info);

      const campos = etiquetas.map((etiqueta) => {
        const clave = normalizar(etiqueta);
        if (!ETIQUETAS_IDENTIFICADOR_TRIBUTARIO.has(clave)) return { etiqueta, ambiguo: false };
        const idPais = IDENTIFICADOR_POR_PAIS[info.solicitud.pais] ?? "identificador tributario";
        if (ETIQUETAS_TRIBUTARIAS_GENERICAS.has(clave)) {
          return {
            etiqueta,
            ambiguo: true,
            nota: `Campo ambiguo: en ${info.solicitud.pais} el equivalente es ${idPais}. Se marca requiere_confirmacion.`,
          };
        }
        if (info.solicitud.pais !== "CO") {
          return {
            etiqueta,
            ambiguo: true,
            nota: `El cliente pide "${idPais}" (${info.solicitud.pais}); Periferia solo tiene NIT colombiano. Se propone el NIT y se marca requiere_confirmacion (identificador extranjero).`,
          };
        }
        return { etiqueta, ambiguo: false };
      });

      const data = {
        pais: info.solicitud.pais,
        cliente: info.solicitud.cliente,
        formato: info.solicitud.formato,
        asunto: info.solicitud.asunto,
        campos,
        soportes: info.soportesExigidos,
        ...(info.advertencias.length ? { advertencias: info.advertencias } : {}),
      };

      logEvento(ctx.directory, args.caso, "proveedor_leer_solicitud", true, `${campos.length} campos, formato ${info.solicitud.formato}`);
      return ok(data);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logEvento(ctx.directory, args.caso, "proveedor_leer_solicitud", false, error);
      return fail(error);
    }
  },
};

// ---------------------------------------------------------------------------
// HU-2 · proveedor_mapear_campos
// ---------------------------------------------------------------------------

type ResultadoMapeo = {
  llenos: Array<{ etiqueta: string; ruta: string; valor: unknown }>;
  faltantes: string[];
  requiere_confirmacion: Array<{ etiqueta: string; motivo: string; valor_propuesto?: unknown }>;
};

// Núcleo del mapeo (lo usan proveedor_mapear_campos y proveedor_armar_paquete).
function mapearEtiquetas(dir: string, pais: string, etiquetas: string[]): ResultadoMapeo {
  const maestro = readJson<Record<string, unknown>>(path.join(REPO_ROOT(dir), "maestro.json"));
  const glosario = readJson<Record<string, string>>(path.join(FIXTURES_ROOT(dir), "glosario-campos.json"));
  const r: ResultadoMapeo = { llenos: [], faltantes: [], requiere_confirmacion: [] };

  for (const etiqueta of etiquetas) {
    const ruta = glosario[etiqueta];
    const valor = ruta ? getByPath(maestro, ruta) : undefined;
    if (!ruta || valor === undefined || valor === null || valor === "") {
      r.faltantes.push(etiqueta); // HU-2: sin fuente → faltante, nunca inventado
      continue;
    }
    const clave = normalizar(etiqueta);
    const idPais = IDENTIFICADOR_POR_PAIS[pais] ?? "identificador tributario";
    if (ETIQUETAS_IDENTIFICADOR_TRIBUTARIO.has(clave) && pais !== "CO") {
      // RN1: identificador extranjero → se llena con el NIT y se marca.
      r.requiere_confirmacion.push({
        etiqueta,
        motivo: `identificador extranjero: el cliente pide ${idPais} (${pais}) y Periferia solo tiene NIT colombiano`,
        valor_propuesto: valor,
      });
      continue;
    }
    if (ETIQUETAS_TRIBUTARIAS_GENERICAS.has(clave)) {
      // HU-1: etiqueta ambigua → se propone el equivalente del país.
      r.requiere_confirmacion.push({
        etiqueta,
        motivo: `campo ambiguo: no especifica el identificador; en ${pais} el equivalente es ${idPais}`,
        valor_propuesto: valor,
      });
      continue;
    }
    r.llenos.push({ etiqueta, ruta, valor });
  }
  return r;
}
// ---------------------------------------------------------------------------

export const mapear_campos = {
  description:
    "Cruza los campos solicitados por el cliente con el repositorio maestro de Periferia usando el glosario de sinónimos. Nunca inventa un valor: un campo sin fuente queda como faltante.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso en fixtures/reto-01/casos/"),
    campos: z.array(z.string()).describe("Lista de etiquetas de campos a mapear (de proveedor_leer_solicitud)"),
  },
  async execute(args: { caso: string; campos: string[] }, ctx: Ctx) {
    try {
      const info = cargarCaso(ctx.directory, args.caso);
      const { llenos, faltantes, requiere_confirmacion } = mapearEtiquetas(ctx.directory, info.solicitud.pais, args.campos);
      const data = { llenos, faltantes, requiere_confirmacion };
      logEvento(
        ctx.directory,
        args.caso,
        "proveedor_mapear_campos",
        true,
        `${llenos.length} llenos, ${faltantes.length} faltantes, ${requiere_confirmacion.length} requieren confirmación`
      );
      return ok(data);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logEvento(ctx.directory, args.caso, "proveedor_mapear_campos", false, error);
      return fail(error);
    }
  },
};

// ---------------------------------------------------------------------------
// HU-3 · proveedor_generar_formulario
// ---------------------------------------------------------------------------

type MapeoEntrada = {
  llenos: Array<{ etiqueta: string; ruta: string; valor: unknown }>;
  faltantes: string[];
  requiere_confirmacion: Array<{ etiqueta: string; motivo: string; valor_propuesto?: unknown }>;
};

function valorComoTexto(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "number") return v.toLocaleString("es-CO");
  return String(v);
}

async function generarXlsx(dir: string, caso: string, info: CasoInfo, mapeo: MapeoEntrada): Promise<string> {
  const wb = new ExcelJS.Workbook();
  const hojas = new Map<string, ExcelJS.Worksheet>();
  const valoresPorEtiqueta = new Map<string, unknown>();
  for (const l of mapeo.llenos) valoresPorEtiqueta.set(l.etiqueta, l.valor);
  for (const r of mapeo.requiere_confirmacion) valoresPorEtiqueta.set(r.etiqueta, r.valor_propuesto);

  for (const celda of info.plantillaCeldas ?? []) {
    let hoja = hojas.get(celda.hoja);
    if (!hoja) {
      hoja = wb.addWorksheet(celda.hoja);
      hojas.set(celda.hoja, hoja);
    }
    hoja.getCell(celda.celda_etiqueta).value = celda.etiqueta;
    const valor = valoresPorEtiqueta.get(celda.etiqueta);
    hoja.getCell(celda.celda_valor).value = valor !== undefined ? valorComoTexto(valor) : "(faltante)";
  }

  const outDir = path.join(OUT_ROOT(dir), caso);
  fs.mkdirSync(outDir, { recursive: true });
  const ruta = path.join(outDir, "formulario.xlsx");
  await wb.xlsx.writeFile(ruta);
  return ruta;
}

async function generarPdf(dir: string, caso: string, info: CasoInfo, mapeo: MapeoEntrada): Promise<string> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([595, 842]);
  let y = 800;

  const valoresPorEtiqueta = new Map<string, unknown>();
  for (const l of mapeo.llenos) valoresPorEtiqueta.set(l.etiqueta, l.valor);
  for (const r of mapeo.requiere_confirmacion) valoresPorEtiqueta.set(r.etiqueta, r.valor_propuesto);

  page.drawText(`Formulario de registro como proveedor — ${info.solicitud.cliente}`, {
    x: 50,
    y,
    size: 13,
    font: fontBold,
  });
  y -= 30;

  for (const campo of info.plantillaCampos ?? []) {
    if (y < 60) {
      page = doc.addPage([595, 842]);
      y = 800;
    }
    const valor = valoresPorEtiqueta.get(campo.etiqueta);
    const texto = `${campo.etiqueta}${campo.obligatorio ? " *" : ""}: ${valor !== undefined ? valorComoTexto(valor) : "(faltante)"}`;
    page.drawText(texto, { x: 50, y, size: 10, font });
    y -= 20;
  }

  const outDir = path.join(OUT_ROOT(dir), caso);
  fs.mkdirSync(outDir, { recursive: true });
  const ruta = path.join(outDir, "formulario.pdf");
  fs.writeFileSync(ruta, await doc.save());
  return ruta;
}

function generarValoresPortal(dir: string, caso: string, info: CasoInfo, mapeo: MapeoEntrada): string {
  const valoresPorEtiqueta = new Map<string, unknown>();
  for (const l of mapeo.llenos) valoresPorEtiqueta.set(l.etiqueta, l.valor);
  for (const r of mapeo.requiere_confirmacion) valoresPorEtiqueta.set(r.etiqueta, r.valor_propuesto);

  const lineas = [
    `# Valores para portal — ${info.solicitud.cliente}`,
    "",
    "Formato no soportado por automatización directa (RPA/portal). Copie estos valores manualmente.",
    "",
  ];
  for (const campo of info.plantillaCampos ?? []) {
    const valor = valoresPorEtiqueta.get(campo.etiqueta);
    lineas.push(`- **${campo.etiqueta}**: ${valor !== undefined ? valorComoTexto(valor) : "_(faltante — completar manualmente)_"}`);
  }

  const outDir = path.join(OUT_ROOT(dir), caso);
  fs.mkdirSync(outDir, { recursive: true });
  const ruta = path.join(outDir, "valores-portal.md");
  fs.writeFileSync(ruta, lineas.join("\n") + "\n");
  return ruta;
}

export const generar_formulario = {
  description: "Genera el formulario lleno en el formato pedido por el cliente (xlsx, pdf o valores para portal).",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    mapeo: z
      .object({
        llenos: z.array(z.object({ etiqueta: z.string(), ruta: z.string(), valor: z.unknown() })),
        faltantes: z.array(z.string()),
        requiere_confirmacion: z.array(
          z.object({ etiqueta: z.string(), motivo: z.string(), valor_propuesto: z.unknown().optional() })
        ),
      })
      .describe("Resultado de proveedor_mapear_campos"),
  },
  async execute(args: { caso: string; mapeo: MapeoEntrada }, ctx: Ctx) {
    try {
      const info = cargarCaso(ctx.directory, args.caso);
      let ruta: string;
      let formato: string;

      const sinPlantilla =
        (info.solicitud.formato === "xlsx" && !info.plantillaCeldas) || (info.solicitud.formato === "pdf" && !info.plantillaCampos);
      if (sinPlantilla) {
        const motivo = info.advertencias[0] ?? `el caso no trae la plantilla para el formato ${info.solicitud.formato}`;
        logEvento(ctx.directory, args.caso, "proveedor_generar_formulario", false, motivo);
        return fail(`No se pudo generar el formulario: ${motivo} Se puede continuar con el paquete y el reporte de faltantes.`);
      }

      if (info.solicitud.formato === "xlsx") {
        ruta = await generarXlsx(ctx.directory, args.caso, info, args.mapeo);
        formato = "xlsx";
      } else if (info.solicitud.formato === "pdf") {
        ruta = await generarPdf(ctx.directory, args.caso, info, args.mapeo);
        formato = "pdf";
      } else {
        // HU-3 P2: portal (u otro formato) no se automatiza: valores para copiar.
        ruta = generarValoresPortal(ctx.directory, args.caso, info, args.mapeo);
        formato = info.solicitud.formato;
      }

      const soportado = formato === "xlsx" || formato === "pdf";
      const data = {
        ruta: path.relative(ctx.directory, ruta),
        formato,
        ...(soportado ? {} : { soportado: false, mensaje: `formato no soportado (${formato}): se generaron los valores listos para copiar en ${path.relative(ctx.directory, ruta)}` }),
      };
      logEvento(ctx.directory, args.caso, "proveedor_generar_formulario", true, `formato ${formato} en ${data.ruta}`);
      return ok(data);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logEvento(ctx.directory, args.caso, "proveedor_generar_formulario", false, error);
      return fail(error);
    }
  },
};

// ---------------------------------------------------------------------------
// HU-4 · proveedor_armar_paquete
// ---------------------------------------------------------------------------

export const armar_paquete = {
  description:
    "Arma el paquete para firma (formulario, copias de los soportes exigidos, checklist y borrador de correo); un soporte vencido o ausente bloquea listo_para_firma.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
  },
  async execute(args: { caso: string }, ctx: Ctx) {
    try {
      const info = cargarCaso(ctx.directory, args.caso);
      const indexSoportes = readJson<
        Array<{ tipo: string; archivo: string; vigencia_hasta: string | null; pais_emisor: string; descripcion: string }>
      >(path.join(REPO_ROOT(ctx.directory), "soportes", "index.json"));

      const outDir = path.join(OUT_ROOT(ctx.directory), args.caso);
      const paqueteDir = path.join(outDir, "paquete");
      // Se rearma desde cero: así no quedan copias de soportes de una corrida
      // anterior que hoy ya estén vencidos.
      fs.rmSync(paqueteDir, { recursive: true, force: true });
      fs.mkdirSync(paqueteDir, { recursive: true });

      // Fecha de referencia para vigencias. Por defecto hoy; FECHA_REFERENCIA
      // (YYYY-MM-DD) permite resultados reproducibles en pruebas y demos.
      const hoy = fechaReferencia();
      const filasChecklist: string[] = [];
      let bloqueaFirma = false;

      for (const tipo of info.soportesExigidos) {
        const soporte = indexSoportes.find((s) => s.tipo === tipo);
        const origen = soporte ? path.join(REPO_ROOT(ctx.directory), "soportes", soporte.archivo) : "";
        if (!soporte || !fs.existsSync(origen)) {
          filasChecklist.push(`- ❌ **${tipo}**: ausente — no existe en el repositorio de soportes.`);
          bloqueaFirma = true;
          continue;
        }
        // HU-4: se copian todos los soportes exigidos que existan; el
        // checklist marca cuáles están vencidos. La vigencia es inclusiva.
        fs.copyFileSync(origen, path.join(paqueteDir, soporte.archivo));
        const vencido = soporte.vigencia_hasta ? new Date(soporte.vigencia_hasta + "T23:59:59Z") < hoy : false;
        if (vencido) {
          filasChecklist.push(`- ⚠️ **${tipo}**: vencido (vigente hasta ${soporte.vigencia_hasta}).`);
          bloqueaFirma = true;
        } else {
          filasChecklist.push(`- ✅ **${tipo}**: presente${soporte.vigencia_hasta ? ` (vigente hasta ${soporte.vigencia_hasta})` : ""}.`);
        }
      }

      // El formulario generado (xlsx, pdf o valores para portal) va al paquete.
      for (const nombre of ["formulario.xlsx", "formulario.pdf", "valores-portal.md"]) {
        const f = path.join(outDir, nombre);
        if (fs.existsSync(f)) fs.copyFileSync(f, path.join(paqueteDir, nombre));
      }

      // RN3: un campo faltante NO bloquea la firma, pero aparece en el checklist.
      const mapeo = mapearEtiquetas(ctx.directory, info.solicitud.pais, listaEtiquetas(info));
      const filasCampos = [
        ...mapeo.faltantes.map((f) => `- ❌ **${f}**: faltante — no existe en el repositorio maestro (completar a mano).`),
        ...mapeo.requiere_confirmacion.map((r) => `- ⚠️ **${r.etiqueta}**: requiere confirmación — ${r.motivo}.`),
      ];

      const checklistMd = [
        `# Checklist del paquete — ${info.solicitud.cliente}`,
        "",
        `Fecha de evaluación de vigencias: ${hoy.toISOString().slice(0, 10)}`,
        "",
        "## Soportes exigidos",
        "",
        ...filasChecklist,
        "",
        "## Campos del formulario pendientes (no bloquean la firma)",
        "",
        ...(filasCampos.length ? filasCampos : ["- Ninguno: todos los campos se llenaron desde el repositorio maestro."]),
        ...(info.advertencias.length ? ["", "## Advertencias", "", ...info.advertencias.map((a) => `- ${a}`)] : []),
        "",
        `**Estado:** ${bloqueaFirma ? "NO listo para firma (hay soportes ausentes o vencidos)" : "listo para firma"}`,
      ].join("\n");
      fs.writeFileSync(path.join(paqueteDir, "checklist.md"), checklistMd + "\n");

      const borradorCorreo = [
        `Para: ${info.solicitud.de}`,
        `Asunto: Re: ${info.solicitud.asunto}`,
        "",
        `Estimados,`,
        "",
        `Adjuntamos el formulario de registro como proveedor de Periferia IT Group S.A.S., firmado por el representante legal, junto con los soportes solicitados.`,
        "",
        `Quedamos atentos a cualquier observación.`,
        "",
        `Saludos,`,
        `Periferia IT Group S.A.S.`,
      ].join("\n");
      fs.writeFileSync(path.join(paqueteDir, "borrador-correo.md"), borradorCorreo + "\n");

      const data = {
        ruta: path.relative(ctx.directory, paqueteDir),
        listo_para_firma: !bloqueaFirma,
        checklist: filasChecklist,
        campos_faltantes: mapeo.faltantes,
        campos_por_confirmar: mapeo.requiere_confirmacion.map((r) => r.etiqueta),
      };
      logEvento(ctx.directory, args.caso, "proveedor_armar_paquete", true, `listo_para_firma=${!bloqueaFirma}`);
      return ok(data);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logEvento(ctx.directory, args.caso, "proveedor_armar_paquete", false, error);
      return fail(error);
    }
  },
};

// ---------------------------------------------------------------------------
// HU-4 · proveedor_simular_envio (requiere confirmación explícita — RN4)
// ---------------------------------------------------------------------------

export const simular_envio = {
  description:
    "Simula el envío del paquete al cliente. SOLO debe llamarse con confirmado=true cuando el usuario haya confirmado explícitamente en su último mensaje.",
  args: {
    caso: z.string().describe("Nombre de la carpeta del caso"),
    confirmado: z.boolean().describe("true solo si el usuario confirmó explícitamente el envío en su mensaje anterior"),
  },
  async execute(args: { caso: string; confirmado: boolean }, ctx: Ctx) {
    try {
      if (!args.confirmado) {
        logEvento(ctx.directory, args.caso, "proveedor_simular_envio", false, "sin confirmación explícita");
        return fail("requiere confirmación explícita del usuario antes de simular el envío");
      }
      if (!nombreCasoValido(args.caso) || !fs.existsSync(path.join(CASOS_ROOT(ctx.directory), args.caso))) {
        logEvento(ctx.directory, "_invalido", "proveedor_simular_envio", false, "caso inexistente o inválido");
        return fail(`El caso "${args.caso}" no existe.`);
      }
      const outDir = path.join(OUT_ROOT(ctx.directory), args.caso);
      if (!fs.existsSync(path.join(outDir, "paquete"))) {
        logEvento(ctx.directory, args.caso, "proveedor_simular_envio", false, "paquete no armado");
        return fail("Primero hay que armar el paquete para firma de este caso (proveedor_armar_paquete).");
      }
      const ruta = path.join(outDir, "ENVIO-SIMULADO.md");
      const contenido = [
        `# Envío simulado`,
        "",
        `Caso: ${args.caso}`,
        `Fecha: ${new Date().toISOString()}`,
        "",
        `Este es un envío SIMULADO. No se realizó ninguna acción externa real.`,
      ].join("\n");
      fs.writeFileSync(ruta, contenido + "\n");
      logEvento(ctx.directory, args.caso, "proveedor_simular_envio", true, "envío simulado confirmado");
      return ok({ ruta: path.relative(ctx.directory, ruta) });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      logEvento(ctx.directory, args.caso, "proveedor_simular_envio", false, error);
      return fail(error);
    }
  },
};

export const herramientas = {
  proveedor_leer_solicitud: leer_solicitud,
  proveedor_mapear_campos: mapear_campos,
  proveedor_generar_formulario: generar_formulario,
  proveedor_armar_paquete: armar_paquete,
  proveedor_simular_envio: simular_envio,
};
