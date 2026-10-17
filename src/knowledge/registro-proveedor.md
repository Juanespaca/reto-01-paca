# Conocimiento del proceso — Registro como proveedor

Este documento es el "conocimiento de negocio" del agente. No contiene
comportamiento (eso vive en `agent/prompt.md`) ni ejecución (eso vive en
`src/tools/proveedor.ts`): solo explica el proceso para que el system prompt
pueda razonar sobre él y el equipo de negocio pueda actualizarlo sin tocar
código.

## El proceso en una frase

Un cliente pide a Periferia IT Group registrarse como proveedor; el agente
llena el formulario del cliente con datos del repositorio maestro de
Periferia, arma un paquete con los soportes vigentes y deja todo listo para
que el representante legal firme — el agente nunca firma ni envía nada por
su cuenta.

## Identificadores tributarios por país

| País | Identificador | Nota |
|---|---|---|
| Colombia (CO) | NIT | Periferia tiene NIT colombiano real en el maestro. |
| Ecuador (EC) | RUC | Periferia no tiene RUC ecuatoriano; se usa el NIT y se marca para confirmación humana. |
| Perú (PE) | RUC | Igual que Ecuador. |
| Panamá (PA) | RUC | Igual que Ecuador. |
| Honduras (HN) | RTN | Periferia no tiene RTN hondureño; se usa el NIT y se marca para confirmación humana. |

Cuando el formulario de un cliente extranjero pide su propio identificador
tributario, Periferia no lo tiene — por eso ese campo SIEMPRE se marca
`requiere_confirmacion`, nunca se rellena en silencio.

## Soportes y vigencia

Los soportes (Cámara de Comercio, RUT, certificación bancaria, parafiscales,
estados financieros, ISO 9001) viven en el repositorio y algunos vencen.
Un soporte vencido o ausente bloquea el estado `listo_para_firma`; un dato
de formulario simplemente faltante no lo bloquea, pero queda listado.

## Datos sensibles

Los datos bancarios (número de cuenta, SWIFT) solo se incluyen en el
formulario cuando el cliente los pide explícitamente en su plantilla.
Nunca se escriben en el borrador de correo.

## Qué decide el agente y qué decide un humano

El agente lee, mapea, genera el formulario y arma el paquete. La decisión
de firmar (representante legal) y la decisión de enviar (analista
administrativa, con confirmación explícita) son siempre humanas.
