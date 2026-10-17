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

function respuestaDeAnthropic(json: any): RespuestaModelo {
  const contenido: ContenidoMensaje[] = [];
  for (const bloque of json.content ?? []) {
    if (bloque.type === "text") {
      contenido.push({ tipo: "texto", texto: bloque.text });
    } else if (bloque.type === "tool_use") {
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

    const resp = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const texto = await resp.text().catch(() => "");
      throw new Error(`Anthropic API respondió ${resp.status}: ${texto.slice(0, 300)}`);
    }

    const json = await resp.json();
    return respuestaDeAnthropic(json);
  }
}
