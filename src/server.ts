// src/server.ts
//
// API HTTP mínima + servidor de archivos estáticos del front de chat.
// Expone POST /api/chat, GET /api/sessions/:id y GET /api/health.

import fs from "node:fs";
import path from "node:path";
import { AdaptadorAnthropic } from "./llm/anthropic.ts";
import { correrTurno, type EventoEnVivo } from "./agent.ts";
import type { Mensaje } from "./llm/adapter.ts";

const PROJECT_DIR = process.cwd();
const PORT = Number(process.env.PORT ?? 3000);

// Limpia out/ al iniciar para que demo.ts y el servidor sean deterministas
// en cada corrida (requisito no funcional de "Determinismo").
const outDir = path.join(PROJECT_DIR, "out");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const adaptador = new AdaptadorAnthropic();

// Sesiones en memoria: sessionId -> historial de mensajes.
const sesiones = new Map<string, Mensaje[]>();

// Tope de tokens por sesión (requisito no funcional de "Costo"). Es un
// control simple: si una sesión excede el tope, el servidor deja de llamar
// al modelo y responde con un mensaje claro en vez de seguir gastando la clave.
const TOPE_TOKENS_SESION = Number(process.env.TOPE_TOKENS_SESION ?? 200_000);
const tokensUsadosPorSesion = new Map<string, number>();

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function servirArchivoEstatico(pathname: string): Promise<Response> {
  const relativo = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.join(PROJECT_DIR, "web", relativo);
  if (!filePath.startsWith(path.join(PROJECT_DIR, "web"))) {
    return new Response("Prohibido", { status: 403 });
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return new Response("No encontrado", { status: 404 });
  }
  const ext = path.extname(filePath);
  const tipo =
    { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[ext] ?? "application/octet-stream";
  return new Response(fs.readFileSync(filePath), { headers: { "content-type": `${tipo}; charset=utf-8` } });
}

const CASOS_DIR = path.join(PROJECT_DIR, "fixtures", "reto-01", "casos");
const CASO_VALIDO = /^[a-z0-9][a-z0-9-]*$/i;

function listarCasos() {
  if (!fs.existsSync(CASOS_DIR)) return [];
  return fs
    .readdirSync(CASOS_DIR)
    .filter((d) => fs.statSync(path.join(CASOS_DIR, d)).isDirectory())
    .sort()
    .map((id) => {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(CASOS_DIR, id, "solicitud.json"), "utf-8"));
        const soportes = JSON.parse(fs.readFileSync(path.join(CASOS_DIR, id, "soportes-exigidos.json"), "utf-8"));
        return { id, pais: s.pais, cliente: s.cliente, formato: s.formato, fecha: s.fecha, asunto: s.asunto, soportes: soportes.length };
      } catch {
        return { id };
      }
    });
}

// Lista los archivos generados para un caso (out/<caso>/...), sin el log interno.
function listarArchivos(caso: string) {
  const base = path.join(outDir, caso);
  if (!CASO_VALIDO.test(caso) || !fs.existsSync(base)) return [];
  const res: Array<{ ruta: string; bytes: number }> = [];
  const recorrer = (dir: string) => {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) recorrer(full);
      else if (f !== "log.jsonl") res.push({ ruta: path.relative(base, full), bytes: fs.statSync(full).size });
    }
  };
  recorrer(base);
  return res.sort((a, b) => a.ruta.localeCompare(b.ruta));
}

const TIPOS: Record<string, string> = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

// Ejecuta un turno del agente; comparte validación y tope de tokens entre
// /api/chat (respuesta única) y /api/chat/stream (eventos en vivo).
async function prepararTurno(req: Request): Promise<{ error: Response } | { sessionId: string; message: string }> {
  const body = (await req.json().catch(() => ({}))) as { sessionId?: string; message?: string };
  if (!body.message || typeof body.message !== "string" || !body.message.trim()) {
    return { error: json({ ok: false, error: "falta 'message'" }, 400) };
  }
  if (body.message.length > 4000) {
    return { error: json({ ok: false, error: "El mensaje es demasiado largo (máx. 4000 caracteres)." }, 400) };
  }
  const sessionId = body.sessionId && typeof body.sessionId === "string" ? body.sessionId : crypto.randomUUID();
  const usados = tokensUsadosPorSesion.get(sessionId) ?? 0;
  if (usados >= TOPE_TOKENS_SESION) {
    return {
      error: json(
        { sessionId, reply: "Esta sesión alcanzó su tope de uso del modelo. Inicia una sesión nueva.", toolCalls: [], needsConfirmation: false },
        429
      ),
    };
  }
  return { sessionId, message: body.message.trim() };
}

async function ejecutarTurno(sessionId: string, message: string, onEvento?: (e: EventoEnVivo) => void) {
  const historial = sesiones.get(sessionId) ?? [];
  const { historialActualizado, resultado } = await correrTurno(adaptador, historial, message, PROJECT_DIR, sessionId, onEvento);
  sesiones.set(sessionId, historialActualizado);
  // Acumula el consumo para el tope de costo por sesión (TOPE_TOKENS_SESION).
  const total = (tokensUsadosPorSesion.get(sessionId) ?? 0) + resultado.uso.tokens_entrada + resultado.uso.tokens_salida;
  tokensUsadosPorSesion.set(sessionId, total);
  return { ...resultado, tokensSesion: total, topeTokensSesion: TOPE_TOKENS_SESION };
}

const server = Bun.serve({
  idleTimeout: 120,
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/health" && req.method === "GET") {
      return json({ ok: true, provider: adaptador.nombreProveedor, model: adaptador.nombreModelo });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const p = await prepararTurno(req);
        if ("error" in p) return p.error;
        const resultado = await ejecutarTurno(p.sessionId, p.message);
        return json({ sessionId: p.sessionId, ...resultado });
      } catch (e) {
        console.error("Error en /api/chat:", e instanceof Error ? e.message : e);
        return json({ ok: false, error: "El agente no pudo responder (error con el proveedor del modelo). Intenta de nuevo en un momento." }, 500);
      }
    }

    // Igual que /api/chat, pero devuelve NDJSON con cada llamada a herramienta
    // a medida que ocurre, para que el front muestre el progreso en vivo.
    if (url.pathname === "/api/chat/stream" && req.method === "POST") {
      const p = await prepararTurno(req);
      if ("error" in p) return p.error;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const enviar = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          enviar({ tipo: "inicio", sessionId: p.sessionId });
          try {
            const resultado = await ejecutarTurno(p.sessionId, p.message, (e) => enviar(e));
            enviar({ tipo: "fin", sessionId: p.sessionId, ...resultado });
          } catch (e) {
            console.error("Error en /api/chat/stream:", e instanceof Error ? e.message : e);
            enviar({ tipo: "error", error: "El agente no pudo responder (error con el proveedor del modelo). Intenta de nuevo en un momento." });
          }
          controller.close();
        },
      });
      return new Response(stream, {
        headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache" },
      });
    }

    if (url.pathname === "/api/casos" && req.method === "GET") {
      return json({ ok: true, casos: listarCasos() });
    }

    // GET /api/archivos/<caso> → lista; GET /api/archivos/<caso>/<ruta> → descarga
    if (url.pathname.startsWith("/api/archivos/") && req.method === "GET") {
      const partes = decodeURIComponent(url.pathname.slice("/api/archivos/".length)).split("/").filter(Boolean);
      const caso = partes.shift() ?? "";
      if (!CASO_VALIDO.test(caso)) return json({ ok: false, error: "caso inválido" }, 400);
      if (partes.length === 0) return json({ ok: true, caso, archivos: listarArchivos(caso) });
      const base = path.join(outDir, caso);
      const archivo = path.join(base, ...partes);
      if (!archivo.startsWith(base + path.sep) || path.basename(archivo) === "log.jsonl" || !fs.existsSync(archivo) || fs.statSync(archivo).isDirectory()) {
        return json({ ok: false, error: "archivo no encontrado" }, 404);
      }
      const tipo = TIPOS[path.extname(archivo)] ?? "application/octet-stream";
      const inline = url.searchParams.get("ver") === "1";
      return new Response(fs.readFileSync(archivo), {
        headers: {
          "content-type": tipo,
          "content-disposition": `${inline ? "inline" : "attachment"}; filename="${path.basename(archivo)}"`,
        },
      });
    }

    if (url.pathname.startsWith("/api/sessions/") && req.method === "GET") {
      const sessionId = url.pathname.replace("/api/sessions/", "");
      const historial = sesiones.get(sessionId);
      if (!historial) return json({ ok: false, error: "sesión no encontrada" }, 404);
      return json({ ok: true, sessionId, historial });
    }

    if (url.pathname.startsWith("/api/")) {
      return json({ ok: false, error: "ruta no encontrada" }, 404);
    }

    return servirArchivoEstatico(url.pathname);
  },
});

console.log(`Servidor escuchando en http://localhost:${server.port}`);
console.log(`Proveedor LLM: ${adaptador.nombreProveedor} · modelo: ${adaptador.nombreModelo}`);
