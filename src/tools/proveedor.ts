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

function logEvento(dir: string, caso: string, herramienta: string, okFlag: boolean, resumen: string) {
  const outDir = path.join(OUT_ROOT(dir), /^[a-z0-9][a-z0-9-]*$/i.test(caso) ? caso : "_invalido");
  fs.mkdirSync(outDir, { recursive: true });
  const linea = JSON.stringify({ ts: new Date().toISOString(), herramienta, ok: okFlag, resumen }) + "\n";
  fs.appendFileSync(path.join(outDir, "log.jsonl"), linea);
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
};

// Solo nombres de caso simples (evita rutas tipo "../../").
export function nombreCasoValido(caso: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(caso);
}

function cargarCaso(dir: string, caso: string): CasoInfo {
  if (!nombreCasoValido(caso)) {
    throw new Error(`El nombre de caso "${caso}" no es válido.`);
  }
  const base = path.join(CASOS_ROOT(dir), caso);
  if (!fs.existsSync(base)) {
    throw new Error(`El caso "${caso}" no existe en fixtures/reto-01/casos/.`);
  }
  const solicitud = readJson<CasoInfo["solicitud"]>(path.join(base, "solicitud.json"));
  const soportesExigidos = readJson<string[]>(path.join(base, "soportes-exigidos.json"));

  const celdasPath = path.join(base, "plantilla-celdas.json");
  const camposPath = path.join(base, "plantilla-campos.json");

  return {
    solicitud,
    plantillaCeldas: fs.existsSync(celdasPath) ? readJson(celdasPath) : undefined,
    plantillaCampos: fs.existsSync(camposPath) ? readJson(camposPath) : undefined,
    soportesExigidos,
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
        const esIdentificadorTributario = ETIQUETAS_IDENTIFICADOR_TRIBUTARIO.has(clave);
        if (esIdentificadorTributario) {
          const idEsperado = IDENTIFICADOR_POR_PAIS[info.solicitud.pais] ?? "identificador tributario";
          return {
            etiqueta,
            ambiguo: info.solicitud.pais !== "CO",
            nota:
              info.solicitud.pais !== "CO"
                ? `El cliente pide "${idEsperado}" (${info.solicitud.pais}); Periferia solo tiene NIT colombiano. Se propone llenar con el NIT y marcar requiere_confirmacion.`
                : undefined,
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
      const maestro = readJson<Record<string, unknown>>(path.join(REPO_ROOT(ctx.directory), "maestro.json"));
      const glosario = readJson<Record<string, string>>(path.join(FIXTURES_ROOT(ctx.directory), "glosario-campos.json"));

      const llenos: Array<{ etiqueta: string; ruta: string; valor: unknown }> = [];
      const faltantes: string[] = [];
      const requiere_confirmacion: Array<{ etiqueta: string; motivo: string; valor_propuesto?: unknown }> = [];

      for (const etiqueta of args.campos) {
        const ruta = glosario[etiqueta];
        const claveNormalizada = normalizar(etiqueta);
        const esIdentificadorTributario = ETIQUETAS_IDENTIFICADOR_TRIBUTARIO.has(claveNormalizada);

        if (!ruta) {
          faltantes.push(etiqueta);
          continue;
        }

        const valor = getByPath(maestro, ruta);
        if (valor === undefined || valor === null || valor === "") {
          faltantes.push(etiqueta);
          continue;
        }

        if (esIdentificadorTributario && info.solicitud.pais !== "CO") {
          requiere_confirmacion.push({
            etiqueta,
            motivo: "identificador extranjero: el cliente pide el identificador tributario de su país, Periferia solo tiene NIT colombiano",
            valor_propuesto: valor,
          });
          continue;
        }

        llenos.push({ etiqueta, ruta, valor });
      }

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

      if (info.solicitud.formato === "xlsx") {
        ruta = await generarXlsx(ctx.directory, args.caso, info, args.mapeo);
        formato = "xlsx";
      } else if (info.solicitud.formato === "pdf") {
        ruta = await generarPdf(ctx.directory, args.caso, info, args.mapeo);
        formato = "pdf";
      } else {
        ruta = generarValoresPortal(ctx.directory, args.caso, info, args.mapeo);
        formato = "portal (no soportado — valores para copiar)";
      }

      const data = { ruta: path.relative(ctx.directory, ruta), formato };
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
    "Arma el paquete para firma: formulario, copias de soportes vigentes, checklist de soportes y borrador de correo. Bloquea listo_para_firma si falta o está vencido un soporte exigido.",
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
      fs.mkdirSync(paqueteDir, { recursive: true });

      const hoy = new Date();
      const filasChecklist: string[] = [];
      let bloqueaFirma = false;

      for (const tipo of info.soportesExigidos) {
        const soporte = indexSoportes.find((s) => s.tipo === tipo);
        if (!soporte) {
          filasChecklist.push(`- ❌ **${tipo}**: ausente — no existe en el repositorio de soportes.`);
          bloqueaFirma = true;
          continue;
        }
        const vencido = soporte.vigencia_hasta ? new Date(soporte.vigencia_hasta) < hoy : false;
        if (vencido) {
          filasChecklist.push(`- ⚠️ **${tipo}**: vencido (vigente hasta ${soporte.vigencia_hasta}).`);
          bloqueaFirma = true;
        } else {
          filasChecklist.push(`- ✅ **${tipo}**: presente${soporte.vigencia_hasta ? ` (vigente hasta ${soporte.vigencia_hasta})` : ""}.`);
          const origen = path.join(REPO_ROOT(ctx.directory), "soportes", soporte.archivo);
          if (fs.existsSync(origen)) {
            fs.copyFileSync(origen, path.join(paqueteDir, soporte.archivo));
          }
        }
      }

      const formularioPath = path.join(outDir, info.solicitud.formato === "pdf" ? "formulario.pdf" : "formulario.xlsx");
      if (fs.existsSync(formularioPath)) {
        fs.copyFileSync(formularioPath, path.join(paqueteDir, path.basename(formularioPath)));
      }

      const checklistMd = [
        `# Checklist de soportes — ${info.solicitud.cliente}`,
        "",
        ...filasChecklist,
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
