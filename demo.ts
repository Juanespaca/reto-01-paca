// demo.ts
//
// Ejecuta todos los casos de fixtures/reto-01/casos/ llamando DIRECTAMENTE a
// las herramientas, sin pasar por ningún modelo de lenguaje. Demuestra que
// la lógica de negocio es determinista y no depende de una clave de API.
//
// Uso: bun run demo.ts   (o: bun install && bun run demo.ts)

import fs from "node:fs";
import path from "node:path";
import { herramientas } from "./src/tools/proveedor.ts";

const PROJECT_DIR = process.cwd();
const CASOS_DIR = path.join(PROJECT_DIR, "fixtures", "reto-01", "casos");

// out/ se limpia al inicio para que las corridas sean deterministas.
const outDir = path.join(PROJECT_DIR, "out");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

function parse(json: string) {
  return JSON.parse(json);
}

async function procesarCaso(caso: string) {
  const ctx = { directory: PROJECT_DIR, sessionId: `demo-${caso}` };
  console.log(`\n=== Caso: ${caso} ===`);

  const leido = parse(await herramientas.proveedor_leer_solicitud.execute({ caso }, ctx));
  if (!leido.ok) {
    console.log(`  ✗ leer_solicitud falló: ${leido.error}`);
    return;
  }
  console.log(`  país=${leido.data.pais} formato=${leido.data.formato} campos=${leido.data.campos.length} soportes=${leido.data.soportes.length}`);

  const campos = leido.data.campos.map((c: { etiqueta: string }) => c.etiqueta);
  const mapeado = parse(await herramientas.proveedor_mapear_campos.execute({ caso, campos }, ctx));
  if (!mapeado.ok) {
    console.log(`  ✗ mapear_campos falló: ${mapeado.error}`);
    return;
  }
  console.log(
    `  llenos=${mapeado.data.llenos.length} faltantes=${mapeado.data.faltantes.length} requiere_confirmacion=${mapeado.data.requiere_confirmacion.length}`
  );
  if (mapeado.data.faltantes.length) console.log(`    faltantes: ${mapeado.data.faltantes.join(", ")}`);
  if (mapeado.data.requiere_confirmacion.length) {
    console.log(
      `    requiere_confirmacion: ${mapeado.data.requiere_confirmacion.map((r: { etiqueta: string }) => r.etiqueta).join(", ")}`
    );
  }

  const generado = parse(
    await herramientas.proveedor_generar_formulario.execute({ caso, mapeo: mapeado.data }, ctx)
  );
  if (!generado.ok) {
    console.log(`  ✗ generar_formulario falló: ${generado.error}`);
  } else {
    console.log(`  formulario: ${generado.data.ruta} (${generado.data.formato})`);
  }

  const paquete = parse(await herramientas.proveedor_armar_paquete.execute({ caso }, ctx));
  if (!paquete.ok) {
    console.log(`  ✗ armar_paquete falló: ${paquete.error}`);
    return;
  }
  console.log(`  paquete: ${paquete.data.ruta} · listo_para_firma=${paquete.data.listo_para_firma}`);
  for (const linea of paquete.data.checklist) console.log(`    ${linea}`);

  // Demuestra la regla de confirmación: sin confirmar, debe fallar.
  const envioSinConfirmar = parse(
    await herramientas.proveedor_simular_envio.execute({ caso, confirmado: false }, ctx)
  );
  console.log(`  simular_envio sin confirmar → ok=${envioSinConfirmar.ok} (esperado: false)`);

  const envioConfirmado = parse(
    await herramientas.proveedor_simular_envio.execute({ caso, confirmado: true }, ctx)
  );
  console.log(`  simular_envio confirmado → ${envioConfirmado.ok ? envioConfirmado.data.ruta : envioConfirmado.error}`);
}

async function main() {
  const casos = fs
    .readdirSync(CASOS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  console.log(`Procesando ${casos.length} casos: ${casos.join(", ")}`);
  for (const caso of casos) {
    await procesarCaso(caso);
  }
  console.log("\nListo. Revisa la carpeta out/ para ver los formularios, paquetes y logs generados.");
}

main();
