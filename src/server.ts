// src/server.ts
//
// API HTTP mínima + servidor de archivos estáticos del front de chat.
// Expone POST /api/chat, GET /api/sessions/:id y GET /api/health.

import fs from "node:fs";
import path from "node:path";
import { AdaptadorAnthropic } from "./llm/anthropic.ts";
import { correrTurno } from "./agent.ts";
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

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/health" && req.method === "GET") {
      return json({ ok: true, provider: adaptador.nombreProveedor, model: adaptador.nombreModelo });
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      try {
        const body = (await req.json()) as { sessionId?: string; message?: string };
        if (!body.message || typeof body.message !== "string") {
          return json({ ok: false, error: "falta 'message'" }, 400);
        }
        const sessionId = body.sessionId && typeof body.sessionId === "string" ? body.sessionId : crypto.randomUUID();

        const usados = tokensUsadosPorSesion.get(sessionId) ?? 0;
        if (usados >= TOPE_TOKENS_SESION) {
          return json(
            { sessionId, reply: "Esta sesión alcanzó su tope de uso del modelo. Inicia una sesión nueva.", toolCalls: [], needsConfirmation: false },
            429
          );
        }

        const historial = sesiones.get(sessionId) ?? [];
        const { historialActualizado, resultado } = await correrTurno(
          adaptador,
          historial,
          body.message,
          PROJECT_DIR,
          sessionId
        );
        sesiones.set(sessionId, historialActualizado);

        return json({ sessionId, ...resultado });
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        console.error("Error en /api/chat:", error);
        return json({ ok: false, error: "El agente no pudo responder (error con el proveedor del modelo). Intenta de nuevo en un momento." }, 500);
      }
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
