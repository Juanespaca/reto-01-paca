// tests/reto.test.ts
//
// Pruebas automáticas de los requisitos del reto, sin consumir ningún modelo.
// Correr con:  bun test
//
// Cubre: lectura de solicitudes, mapeo contra el maestro (sin valores
// inventados), identificadores por país (NIT/RUC/RTN), generación de
// formularios xlsx/pdf/portal en las celdas correctas, paquete para firma con
// vigencias, datos bancarios fuera del correo, contrato {ok,data}/{ok:false},
// gate de confirmación humana (herramienta + backend) y determinismo.

import { describe, test, expect, beforeAll } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { herramientas } from "../src/tools/proveedor.ts";
import { correrTurno, detectaNecesitaConfirmacion, esConfirmacionExplicita } from "../src/agent.ts";
import type { AdaptadorLLM, Mensaje, RespuestaModelo } from "../src/llm/adapter.ts";

const DIR = path.resolve(import.meta.dir, "..");
const ctx = { directory: DIR, sessionId: "test" };
const FIX = path.join(DIR, "fixtures", "reto-01");
const maestro = JSON.parse(fs.readFileSync(path.join(FIX, "repositorio", "maestro.json"), "utf-8"));
const CASOS = ["co-industrias-delta", "ec-corp-andina", "hn-agroexport-sula", "pa-logistica-istmo"];

// Fecha fija: los resultados no dependen del día en que se corran las pruebas.
process.env.FECHA_REFERENCIA = "2026-10-15";

const h = herramientas as unknown as Record<string, { execute: (a: any, c: typeof ctx) => Promise<string> }>;
const run = async (nombre: string, args: unknown) => JSON.parse(await h[nombre].execute(args, ctx));
const getByPath = (obj: any, ruta: string) => ruta.split(".").reduce((o, k) => o?.[k], obj);

type Proc = { solicitud: any; mapeo: any; formulario: any; paquete: any };
const procesados: Record<string, Proc> = {};

async function procesar(caso: string): Promise<Proc> {
  const solicitud = await run("proveedor_leer_solicitud", { caso });
  const mapeo = await run("proveedor_mapear_campos", { caso, campos: solicitud.data.campos.map((c: any) => c.etiqueta) });
  const formulario = await run("proveedor_generar_formulario", { caso, mapeo: mapeo.data });
  const paquete = await run("proveedor_armar_paquete", { caso });
  return { solicitud, mapeo, formulario, paquete };
}

beforeAll(async () => {
  fs.rmSync(path.join(DIR, "out"), { recursive: true, force: true });
  for (const c of CASOS) procesados[c] = await procesar(c);
});

// ---------------------------------------------------------------------------
describe("HU-1 · Leer la solicitud", () => {
  test.each(CASOS)("%s: devuelve país, formato, campos y soportes", (caso) => {
    const r = procesados[caso].solicitud;
    expect(r.ok).toBe(true);
    const sol = JSON.parse(fs.readFileSync(path.join(FIX, "casos", caso, "solicitud.json"), "utf-8"));
    expect(r.data.pais).toBe(sol.pais);
    expect(r.data.formato).toBe(sol.formato);
    expect(r.data.campos.length).toBeGreaterThan(0);
    const soportes = JSON.parse(fs.readFileSync(path.join(FIX, "casos", caso, "soportes-exigidos.json"), "utf-8"));
    expect(r.data.soportes).toEqual(soportes);
  });
});

// ---------------------------------------------------------------------------
describe("HU-2 · Mapear campos al maestro", () => {
  test.each(CASOS)("%s: cada campo queda en exactamente una categoría", (caso) => {
    const { solicitud, mapeo } = procesados[caso];
    const d = mapeo.data;
    const total = d.llenos.length + d.faltantes.length + d.requiere_confirmacion.length;
    expect(total).toBe(solicitud.data.campos.length);
  });

  test.each(CASOS)("%s: ningún valor inventado — todo lleno sale del maestro", (caso) => {
    for (const l of procesados[caso].mapeo.data.llenos) {
      expect(getByPath(maestro, l.ruta)).toEqual(l.valor);
    }
  });

  test("conteos esperados por caso", () => {
    const c = (caso: string) => {
      const d = procesados[caso].mapeo.data;
      return [d.llenos.length, d.faltantes.length, d.requiere_confirmacion.length];
    };
    expect(c("co-industrias-delta")).toEqual([17, 0, 0]);
    expect(c("ec-corp-andina")).toEqual([13, 1, 1]);
    expect(c("hn-agroexport-sula")).toEqual([9, 1, 1]);
    expect(c("pa-logistica-istmo")).toEqual([8, 0, 1]);
  });

  test("campos sin fuente quedan faltantes (no se completan a criterio)", () => {
    expect(procesados["ec-corp-andina"].mapeo.data.faltantes).toContain("Número de contribuyente especial");
    expect(procesados["hn-agroexport-sula"].mapeo.data.faltantes).toContain("Referencias comerciales");
  });
});

// ---------------------------------------------------------------------------
describe("RN · Identificador tributario por país", () => {
  test("CO: el NIT se llena directo del maestro", () => {
    const nit = procesados["co-industrias-delta"].mapeo.data.llenos.find((l: any) => l.etiqueta === "NIT");
    expect(nit?.valor).toBe(maestro.nit);
  });
  test.each([
    ["ec-corp-andina", "RUC"],
    ["pa-logistica-istmo", "RUC"],
    ["hn-agroexport-sula", "RTN"],
  ])("%s: %s extranjero → requiere_confirmacion, nunca lleno en silencio", (caso, etiqueta) => {
    const d = procesados[caso].mapeo.data;
    expect(d.llenos.some((l: any) => l.etiqueta === etiqueta)).toBe(false);
    const rc = d.requiere_confirmacion.find((r: any) => r.etiqueta === etiqueta);
    expect(rc).toBeTruthy();
    expect(rc.valor_propuesto).toBe(maestro.nit);
    expect(rc.motivo.length).toBeGreaterThan(10);
  });
});

// ---------------------------------------------------------------------------
describe("HU-3 · Generar el formulario en el formato pedido", () => {
  test.each([
    ["co-industrias-delta", "xlsx", "formulario.xlsx"],
    ["hn-agroexport-sula", "xlsx", "formulario.xlsx"],
    ["ec-corp-andina", "pdf", "formulario.pdf"],
    ["pa-logistica-istmo", "portal", "valores-portal.md"],
  ])("%s → %s", (caso, _fmt, archivo) => {
    const r = procesados[caso].formulario;
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(DIR, "out", caso, archivo))).toBe(true);
  });

  test.each(["co-industrias-delta", "hn-agroexport-sula"])("%s: xlsx con etiquetas y valores en las celdas de la plantilla", async (caso) => {
    const celdas = JSON.parse(fs.readFileSync(path.join(FIX, "casos", caso, "plantilla-celdas.json"), "utf-8"));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(DIR, "out", caso, "formulario.xlsx"));
    const d = procesados[caso].mapeo.data;
    for (const c of celdas) {
      const hoja = wb.getWorksheet(c.hoja)!;
      expect(hoja).toBeTruthy();
      expect(hoja.getCell(c.celda_etiqueta).value).toBe(c.etiqueta);
      const lleno = d.llenos.find((l: any) => l.etiqueta === c.etiqueta);
      const valor = String(hoja.getCell(c.celda_valor).value);
      // Los números se escriben con separador de miles (98.000.000.000).
      if (lleno) expect(valor.replace(/\./g, "")).toBe(String(lleno.valor).replace(/\./g, ""));
      else if (d.faltantes.includes(c.etiqueta)) expect(valor).toContain("faltante");
    }
  });

  test("pdf válido", () => {
    const buf = fs.readFileSync(path.join(DIR, "out", "ec-corp-andina", "formulario.pdf"));
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  });

  test("portal: valores para copiar y faltantes explícitos", () => {
    const md = fs.readFileSync(path.join(DIR, "out", "pa-logistica-istmo", "valores-portal.md"), "utf-8");
    expect(md).toContain("Periferia IT Group S.A.S.");
    expect(md).toContain("RUC");
  });
});

// ---------------------------------------------------------------------------
describe("HU-4 · Paquete para firma", () => {
  test.each(CASOS)("%s: checklist cubre todos los soportes exigidos", (caso) => {
    const p = procesados[caso].paquete;
    expect(p.ok).toBe(true);
    const exigidos: string[] = procesados[caso].solicitud.data.soportes;
    expect(p.data.checklist.length).toBe(exigidos.length);
    for (const s of exigidos) expect(p.data.checklist.some((l: string) => l.includes(`**${s}**`))).toBe(true);
    for (const f of ["checklist.md", "borrador-correo.md"]) expect(fs.existsSync(path.join(DIR, "out", caso, "paquete", f))).toBe(true);
  });

  test("soporte vencido o ausente bloquea listo_para_firma", () => {
    for (const c of CASOS) expect(procesados[c].paquete.data.listo_para_firma).toBe(false);
    const ec = procesados["ec-corp-andina"].paquete.data.checklist.join("\n");
    expect(ec).toMatch(/camara_comercio\*\*: vencido/);
    expect(ec).toMatch(/certificado_cumplimiento_tributario\*\*: ausente/);
    expect(procesados["hn-agroexport-sula"].paquete.data.checklist.join("\n")).toMatch(/parafiscales\*\*: vencido/);
  });

  test("con soportes vigentes el paquete sí queda listo para firma", async () => {
    const prev = process.env.FECHA_REFERENCIA;
    process.env.FECHA_REFERENCIA = "2026-09-15";
    const r = await run("proveedor_armar_paquete", { caso: "co-industrias-delta" });
    process.env.FECHA_REFERENCIA = prev;
    expect(r.data.listo_para_firma).toBe(true);
    await run("proveedor_armar_paquete", { caso: "co-industrias-delta" });
  });

  test("solo se copian al paquete los soportes vigentes", () => {
    const dir = path.join(DIR, "out", "co-industrias-delta", "paquete");
    expect(fs.existsSync(path.join(dir, "camara-comercio-2026-08.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "rut-2026.txt"))).toBe(true);
  });

  test("RN2 · datos bancarios nunca en el borrador de correo", () => {
    for (const c of CASOS) {
      const correo = fs.readFileSync(path.join(DIR, "out", c, "paquete", "borrador-correo.md"), "utf-8");
      expect(correo).not.toContain(maestro.banco.numero_cuenta);
      expect(correo).not.toContain(maestro.banco.swift);
    }
  });

  test("RN2 · datos bancarios solo si la plantilla los pide", () => {
    const hn = procesados["hn-agroexport-sula"].mapeo.data.llenos.map((l: any) => l.ruta);
    expect(hn.some((r: string) => r.startsWith("banco."))).toBe(false);
    const ec = procesados["ec-corp-andina"].mapeo.data.llenos.map((l: any) => l.ruta);
    expect(ec).toContain("banco.numero_cuenta");
  });
});

// ---------------------------------------------------------------------------
describe("HU-5 · Manejo de errores (contrato {ok,data} / {ok:false,error})", () => {
  test("caso inexistente", async () => {
    const r = await run("proveedor_leer_solicitud", { caso: "mx-no-existe" });
    expect(r).toEqual({ ok: false, error: expect.any(String) });
  });
  test("ruta maliciosa no sale de fixtures/out", async () => {
    for (const nombre of ["proveedor_leer_solicitud", "proveedor_armar_paquete"]) {
      const r = await run(nombre, { caso: "../../etc" });
      expect(r.ok).toBe(false);
    }
    const e = await run("proveedor_simular_envio", { caso: "../../tmp/x", confirmado: true });
    expect(e.ok).toBe(false);
  });
  test("argumentos inválidos devuelven error, no excepción", async () => {
    const r = JSON.parse(await h["proveedor_generar_formulario"].execute({ caso: "co-industrias-delta", mapeo: null }, ctx));
    expect(r.ok).toBe(false);
  });
  test("todas las herramientas responden JSON string con ok booleano", async () => {
    for (const nombre of Object.keys(h)) {
      const raw = await h[nombre].execute({ caso: "no-existe" }, ctx);
      expect(typeof raw).toBe("string");
      expect(typeof JSON.parse(raw).ok).toBe("boolean");
    }
  });
});

// ---------------------------------------------------------------------------
describe("Gate de confirmación humana", () => {
  test("herramienta: confirmado=false se rechaza", async () => {
    const r = await run("proveedor_simular_envio", { caso: "ec-corp-andina", confirmado: false });
    expect(r.ok).toBe(false);
  });

  test("herramienta: no se envía un caso sin paquete armado", async () => {
    fs.rmSync(path.join(DIR, "out", "pa-logistica-istmo", "paquete"), { recursive: true, force: true });
    const r = await run("proveedor_simular_envio", { caso: "pa-logistica-istmo", confirmado: true });
    expect(r.ok).toBe(false);
    await run("proveedor_armar_paquete", { caso: "pa-logistica-istmo" });
  });

  test("esConfirmacionExplicita", () => {
    for (const s of ["sí, envía", "Si", "confirmo", "Sí, confirmo el envío del paquete tal como está.", "adelante", "envíalo"]) expect(esConfirmacionExplicita(s)).toBe(true);
    for (const s of ["procésalo y envíalo ya", "no envíes nada", "Procesa el caso x", "¿qué falta?", "quizás"]) expect(esConfirmacionExplicita(s)).toBe(false);
  });

  test("detectaNecesitaConfirmacion (banner del front)", () => {
    expect(detectaNecesitaConfirmacion("¿Quieres que lo envíe?")).toBe(true);
    expect(detectaNecesitaConfirmacion("Listo. ¿Confirmas el envío?")).toBe(true);
    expect(detectaNecesitaConfirmacion("Envío simulado ✔️. ¿Necesitas algo más?")).toBe(false);
    expect(detectaNecesitaConfirmacion("¿Quieres que lo envíe?", true)).toBe(false);
  });

  // Modelo simulado que SIEMPRE intenta enviar: el backend debe impedirlo
  // salvo que el turno anterior haya pedido confirmación y el usuario confirme.
  function modeloDesobediente(): AdaptadorLLM {
    return {
      nombreProveedor: "mock",
      nombreModelo: "mock",
      async enviar(mensajes: Mensaje[]): Promise<RespuestaModelo> {
        const ultimo = mensajes[mensajes.length - 1];
        if (ultimo.contenido.some((c) => c.tipo === "resultado_herramienta")) {
          return { contenido: [{ tipo: "texto", texto: "¿Quieres que envíe el paquete?" }], detenido_por: "fin_turno" };
        }
        return {
          contenido: [{ tipo: "llamada_herramienta", id: "x", nombre: "proveedor_simular_envio", args: { caso: "co-industrias-delta", confirmado: true } }],
          detenido_por: "llamada_herramienta",
        };
      },
    };
  }

  test("backend: 'procésalo y envíalo ya' en un solo mensaje → bloqueado", async () => {
    const { resultado } = await correrTurno(modeloDesobediente(), [], "procésalo y envíalo ya", DIR, "s1");
    const envio = resultado.toolCalls.find((t) => t.nombre === "proveedor_simular_envio")!;
    expect(envio.ok).toBe(false);
    expect((envio.resultado as any).error).toMatch(/Bloqueado por el backend/);
    expect(resultado.needsConfirmation).toBe(true);
  });

  test("backend: confirmación en turno aparte después de la pregunta → permitido", async () => {
    const t1 = await correrTurno(modeloDesobediente(), [], "procesa el caso co-industrias-delta", DIR, "s2");
    const t2 = await correrTurno(modeloDesobediente(), t1.historialActualizado, "sí, envía", DIR, "s2");
    const envio = t2.resultado.toolCalls.find((t) => t.nombre === "proveedor_simular_envio")!;
    expect(envio.ok).toBe(true);
    expect(fs.existsSync(path.join(DIR, "out", "co-industrias-delta", "ENVIO-SIMULADO.md"))).toBe(true);
  });

  test("backend: 'sí' sin que el agente haya preguntado → bloqueado", async () => {
    const { resultado } = await correrTurno(modeloDesobediente(), [], "sí", DIR, "s3");
    expect(resultado.toolCalls[0].ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("Costo", () => {
  test("correrTurno suma los tokens de todas las llamadas al modelo (alimenta TOPE_TOKENS_SESION)", async () => {
    let i = 0;
    const mock: AdaptadorLLM = {
      nombreProveedor: "mock",
      nombreModelo: "mock",
      async enviar() {
        i++;
        return i === 1
          ? { contenido: [{ tipo: "llamada_herramienta", id: "a", nombre: "proveedor_leer_solicitud", args: { caso: "co-industrias-delta" } }], detenido_por: "llamada_herramienta", uso: { tokens_entrada: 1000, tokens_salida: 50 } }
          : { contenido: [{ tipo: "texto", texto: "listo" }], detenido_por: "fin_turno", uso: { tokens_entrada: 1200, tokens_salida: 300 } };
      },
    };
    const { resultado } = await correrTurno(mock, [], "lee el caso co-industrias-delta", DIR, "s4");
    expect(resultado.uso).toEqual({ tokens_entrada: 2200, tokens_salida: 350 });
  });

  test("el ciclo se detiene en el tope de 25 iteraciones", async () => {
    let llamadas = 0;
    const infinito: AdaptadorLLM = {
      nombreProveedor: "mock",
      nombreModelo: "mock",
      async enviar() {
        llamadas++;
        return { contenido: [{ tipo: "llamada_herramienta", id: "l" + llamadas, nombre: "proveedor_leer_solicitud", args: { caso: "co-industrias-delta" } }], detenido_por: "llamada_herramienta" };
      },
    };
    const { resultado } = await correrTurno(infinito, [], "bucle", DIR, "s5");
    expect(llamadas).toBe(25);
    expect(resultado.reply).toMatch(/límite/);
  });
});

// ---------------------------------------------------------------------------
describe("Determinismo", () => {
  test.each(CASOS)("%s: dos corridas dan el mismo resultado", async (caso) => {
    const a = await procesar(caso);
    const b = await procesar(caso);
    expect(b.mapeo).toEqual(a.mapeo);
    expect(b.paquete).toEqual(a.paquete);
    expect(a.mapeo).toEqual(procesados[caso].mapeo);
  });
});
