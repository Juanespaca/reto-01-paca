// src/llm/adapter.ts
//
// Interfaz propia del proveedor de modelo de lenguaje. El ciclo del agente
// (server.ts) solo conoce esta interfaz, nunca el SDK o la API concreta de
// un proveedor: cambiar de Anthropic a OpenAI/Google implica escribir un
// nuevo archivo en esta carpeta, no tocar el ciclo del agente.

export type Rol = "user" | "assistant";

export type ContenidoMensaje =
  | { tipo: "texto"; texto: string }
  | { tipo: "llamada_herramienta"; id: string; nombre: string; args: unknown }
  | { tipo: "resultado_herramienta"; id_llamada: string; resultado: string };

export type Mensaje = {
  rol: Rol;
  contenido: ContenidoMensaje[];
};

export type DefinicionHerramienta = {
  nombre: string; // "<archivo>_<export>", ej. proveedor_leer_solicitud
  descripcion: string;
  // JSON Schema de los argumentos (se deriva del schema zod en server.ts)
  esquemaArgs: Record<string, unknown>;
};

export type RespuestaModelo = {
  contenido: ContenidoMensaje[];
  detenido_por: "fin_turno" | "llamada_herramienta" | "max_tokens";
  uso?: { tokens_entrada: number; tokens_salida: number };
};

export interface AdaptadorLLM {
  nombreProveedor: string;
  nombreModelo: string;
  enviar(mensajes: Mensaje[], systemPrompt: string, herramientas: DefinicionHerramienta[]): Promise<RespuestaModelo>;
}
