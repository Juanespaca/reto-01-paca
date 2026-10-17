// src/agent.ts
//
// El ciclo del agente: toma el historial de una sesión, llama al modelo con
// las herramientas disponibles, ejecuta las herramientas que el modelo pida,
// le devuelve el resultado, y repite hasta que el modelo responda con texto
// final (o hasta el tope de iteraciones — regla CA1 del PRD).

import fs from "node:fs";
import path from "node:path";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import type { AdaptadorLLM, Mensaje, DefinicionHerramienta, ContenidoMensaje } from "./llm/adapter.ts";
import { herramientas } from "./tools/proveedor.ts";

const TOPE_ITERACIONES = 25;

type Herramienta = (typeof herramientas)[keyof typeof herramientas];

function construirDefiniciones(): DefinicionHerramienta[] {
  return Object.entries(herramientas).map(([nombre, h]) => {
    const schema = z.object(h.args as Record<string, z.ZodTypeAny>);
    return {
      nombre,
      descripcion: h.description,
      esquemaArgs: zodToJsonSchema(schema, { target: "openApi3" }) as Record<string, unknown>,
    };
  });
}

const DEFINICIONES_HERRAMIENTAS = construirDefiniciones();

function cargarSystemPrompt(): string {
  const promptBase = fs.readFileSync(path.join(process.cwd(), "agent", "prompt.md"), "utf-8");
  const conocimiento = fs.readFileSync(
    path.join(process.cwd(), "src", "knowledge", "registro-proveedor.md"),
    "utf-8"
  );
  return `${promptBase}\n\n---\n\n# Conocimiento del proceso (consulta esto para resolver dudas de negocio)\n\n${conocimiento}`;
}

const SYSTEM_PROMPT = cargarSystemPrompt();

export type EventoToolCall = {
  nombre: string;
  args: unknown;
  resultado: unknown;
  ok: boolean;
};

export type ResultadoTurno = {
  reply: string;
  toolCalls: EventoToolCall[];
  needsConfirmation: boolean;
};

async function ejecutarHerramienta(nombre: string, args: unknown, ctx: { directory: string; sessionId: string }) {
  const herramienta = (herramientas as Record<string, Herramienta>)[nombre];
  if (!herramienta) {
    return JSON.stringify({ ok: false, error: `Herramienta desconocida: ${nombre}` });
  }
  const schema = z.object(herramienta.args as Record<string, z.ZodTypeAny>);
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return JSON.stringify({ ok: false, error: `Argumentos inválidos para ${nombre}: ${parsed.error.message}` });
  }
  // @ts-expect-error — cada herramienta tipa sus propios args; el esquema zod ya los validó arriba.
  return herramienta.execute(parsed.data, ctx);
}

// Gate de confirmación en el BACKEND (no depende del modelo): el envío solo
// se ejecuta si (a) la última respuesta del agente pidió confirmación y
// (b) el mensaje actual del usuario es una confirmación explícita y no pide
// además procesar algo nuevo ("procésalo y envíalo ya" NO cuenta).
function ultimoTextoAsistente(historial: Mensaje[]): string {
  for (let i = historial.length - 1; i >= 0; i--) {
    const m = historial[i];
    if (m.rol !== "assistant") continue;
    const textos = m.contenido.filter((c) => c.tipo === "texto") as Array<{ tipo: "texto"; texto: string }>;
    if (textos.length > 0) return textos.map((t) => t.texto).join("\n");
  }
  return "";
}

export function esConfirmacionExplicita(mensaje: string): boolean {
  const t = mensaje.toLowerCase().trim();
  if (/proces|arma|genera|mapea|lee /.test(t)) return false;
  return /^(s[ií]|confirmo|confirmado|adelante|dale|de acuerdo|ok|procede)(?![a-záéíóúñ])/.test(t) ||
    /^(env[ií]a(lo)?|puedes enviar)/.test(t);
}

function detectaNecesitaConfirmacion(texto: string): boolean {
  const t = texto.toLowerCase();
  const esPregunta = t.includes("¿") || t.includes("?");
  const mencionaAccionSensible = /env[ií]|confirm|procedo|adelante/.test(t);
  // Además de preguntas explícitas ("¿envío?"), el agente a veces cierra con
  // una instrucción imperativa ("responde 'sí, envía'", "escribe 'confirmo'")
  // que también deja el turno esperando una confirmación del usuario.
  const pideRespuestaLiteral = /responde|escribe|confirma(ndo)?\s*["“']|di\s*["“']/.test(t) && mencionaAccionSensible;
  return (esPregunta && mencionaAccionSensible) || pideRespuestaLiteral;
}

export async function correrTurno(
  adaptador: AdaptadorLLM,
  historial: Mensaje[],
  mensajeUsuario: string,
  directorioProyecto: string,
  sessionId: string
): Promise<{ historialActualizado: Mensaje[]; resultado: ResultadoTurno }> {
  const historialLocal: Mensaje[] = [
    ...historial,
    { rol: "user", contenido: [{ tipo: "texto", texto: mensajeUsuario }] },
  ];

  const envioAutorizado =
    detectaNecesitaConfirmacion(ultimoTextoAsistente(historial)) && esConfirmacionExplicita(mensajeUsuario);

  const toolCalls: EventoToolCall[] = [];
  let textoFinal = "";

  for (let iteracion = 0; iteracion < TOPE_ITERACIONES; iteracion++) {
    const respuesta = await adaptador.enviar(historialLocal, SYSTEM_PROMPT, DEFINICIONES_HERRAMIENTAS);

    historialLocal.push({ rol: "assistant", contenido: respuesta.contenido });

    const llamadas = respuesta.contenido.filter(
      (c): c is Extract<ContenidoMensaje, { tipo: "llamada_herramienta" }> => c.tipo === "llamada_herramienta"
    );
    const textos = respuesta.contenido.filter(
      (c): c is Extract<ContenidoMensaje, { tipo: "texto" }> => c.tipo === "texto"
    );
    if (textos.length > 0) {
      textoFinal = textos.map((t) => t.texto).join("\n");
    }

    if (llamadas.length === 0) {
      // El modelo terminó su turno sin pedir más herramientas.
      break;
    }

    const resultadosHerramienta: ContenidoMensaje[] = [];
    for (const llamada of llamadas) {
      const resultadoCrudo =
        llamada.nombre === "proveedor_simular_envio" && !envioAutorizado
          ? JSON.stringify({
              ok: false,
              error:
                "Bloqueado por el backend: el envío requiere que el usuario confirme explícitamente en un mensaje aparte, después de que el agente se lo pregunte.",
            })
          : await ejecutarHerramienta(llamada.nombre, llamada.args, {
              directory: directorioProyecto,
              sessionId,
            });
      let parseado: unknown;
      try {
        parseado = JSON.parse(resultadoCrudo as string);
      } catch {
        parseado = { ok: false, error: "respuesta no serializable de la herramienta" };
      }
      toolCalls.push({
        nombre: llamada.nombre,
        args: llamada.args,
        resultado: parseado,
        ok: Boolean((parseado as { ok?: boolean })?.ok),
      });
      resultadosHerramienta.push({
        tipo: "resultado_herramienta",
        id_llamada: llamada.id,
        resultado: resultadoCrudo as string,
      });
    }

    historialLocal.push({ rol: "user", contenido: resultadosHerramienta });

    if (iteracion === TOPE_ITERACIONES - 1) {
      textoFinal +=
        "\n\n(Llegué al límite de pasos permitidos en este turno. Te cuento lo que alcancé a hacer y qué falta.)";
    }
  }

  const needsConfirmation = detectaNecesitaConfirmacion(textoFinal);

  return {
    historialActualizado: historialLocal,
    resultado: { reply: textoFinal, toolCalls, needsConfirmation },
  };
}
