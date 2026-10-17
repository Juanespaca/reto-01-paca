// src/llm/anthropic.ts
//
// Implementación del AdaptadorLLM para Anthropic (Claude), usando fetch
// directo a la Messages API — sin el SDK oficial, para que cada línea de
// la llamada al proveedor sea explícita y fácil de explicar en la defensa.
//
// La clave SOLO se lee de la variable de entorno ANTHROPIC_API_KEY. Nunca
// se imprime, nunca se envía al front, nunca queda en out/log.jsonl.

import type { AdaptadorLLM, Mensaje, DefinicionHerramienta, RespuestaModelo, ContenidoMensaje } from "./adapter.ts";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

function mensajesAFormatoAnthropic(mensajes: Mensaje[]) {
  return mensajes.map((m) => ({
    role: m.rol,
    content: m.contenido.map((c) => {
      if (c.tipo === "texto") return { type: "text", text: c.texto };
      if (c.tipo === "llamada_herramienta") {
        return { type: "tool_use", id: c.id, name: c.nombre, input: c.args };
      }
      // resultado_herramienta
      return { type: "tool_result", tool_use_id: c.id_llamada, content: c.resultado };
    }),
  }));
}

// Forma mínima de la respuesta de la Messages API que este adaptador usa.
type BloqueAnthropic =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: string };
type RespuestaAnthropic = {
  content?: BloqueAnthropic[];
  stop_reason?: string;
  usage?: { input_tokens: number; output_tokens: number };
};

// Error del proveedor con un mensaje ya apto para mostrarse al usuario (CA5).
export class ErrorProveedorLLM extends Error {
  constructor(public mensajeUsuario: string, detalle: string) {
    super(detalle);
    this.name = "ErrorProveedorLLM";
  }
}

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 60_000);

function respuestaDeAnthropic(json: RespuestaAnthropic): RespuestaModelo {
  const contenido: ContenidoMensaje[] = [];
  for (const bloque of json.content ?? []) {
    if (bloque.type === "text" && "text" in bloque) {
      contenido.push({ tipo: "texto", texto: bloque.text });
    } else if (bloque.type === "tool_use" && "id" in bloque) {
      contenido.push({ tipo: "llamada_herramienta", id: bloque.id, nombre: bloque.name, args: bloque.input });
    }
  }
  const detenido_por = json.stop_reason === "tool_use" ? "llamada_herramienta" : json.stop_reason === "max_tokens" ? "max_tokens" : "fin_turno";
  return {
    contenido,
    detenido_por,
    uso: json.usage
      ? { tokens_entrada: json.usage.input_tokens, tokens_salida: json.usage.output_tokens }
      : undefined,
  };
}

export class AdaptadorAnthropic implements AdaptadorLLM {
  nombreProveedor = "anthropic";
  nombreModelo: string;
  private apiKey: string;

  constructor(opts?: { modelo?: string }) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      throw new Error("Falta la variable de entorno ANTHROPIC_API_KEY");
    }
    this.apiKey = key;
    this.nombreModelo = opts?.modelo ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
  }

  async enviar(mensajes: Mensaje[], systemPrompt: string, herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo> {
    const body = {
      model: this.nombreModelo,
      max_tokens: 2048,
      system: systemPrompt,
      messages: mensajesAFormatoAnthropic(mensajes),
      tools: herramientas.map((h) => ({
        name: h.nombre,
        description: h.descripcion,
        input_schema: h.esquemaArgs,
      })),
    };

    let resp: Response;
    try {
      resp = await fetch(ANTHROPIC_API_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        // Robustez (PRD §8): timeout al proveedor con mensaje claro.
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const esTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
      throw new ErrorProveedorLLM(
        esTimeout
          ? `El modelo tardó más de ${Math.round(TIMEOUT_MS / 1000)} s en responder. Intenta de nuevo.`
          : "No se pudo contactar al proveedor del modelo. Intenta de nuevo en un momento.",
        e instanceof Error ? e.message : String(e)
      );
    }

    if (!resp.ok) {
      const texto = await resp.text().catch(() => "");
      const mensaje =
        resp.status === 429
          ? "El proveedor del modelo está limitando las solicitudes (429). Espera unos segundos e intenta de nuevo."
          : resp.status === 401
            ? "La clave del modelo no es válida o no está configurada en el servidor."
            : resp.status >= 500
              ? "El proveedor del modelo está con fallas temporales. Intenta de nuevo en un momento."
              : `El proveedor del modelo rechazó la solicitud (${resp.status}).`;
      throw new ErrorProveedorLLM(mensaje, `Anthropic API respondió ${resp.status}: ${texto.slice(0, 300)}`);
    }

    const json = (await resp.json()) as RespuestaAnthropic;
    return respuestaDeAnthropic(json);
  }
}
