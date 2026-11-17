# Configuración y automatización de evaluaciones

Ruta administrativa: `/pulsoAtom/configuracion/evaluaciones`. Solo administradores pueden consultar o modificar la configuración, su historial y el monitor. La navegación respeta una ruta base alternativa.

## Países y selección

La carga de Atom continúa completa a las 00:01 de Honduras. El detector consulta metadatos de documentos `LISTO`, referencias de ingesta y actividad del día anterior. Solo obtiene transcripciones de conversaciones seleccionadas. Las cargas parciales posteriores pueden completar el cupo.

El listado incluye solo países con conversaciones registradas en Atom, no todo el catálogo corporativo mundial. No depende de la actividad de la jornada, del estado del documento ni de que la evaluación esté habilitada. Aquí se habilitan, pausan y editan sus cupos. Las altas se incorporan deshabilitadas mediante una revisión auditada. Desaparecer temporalmente de la fuente no borra su configuración. Las configuraciones anteriores conservan sus datos e historial, pero sus países sin operación no se muestran en el listado. Las evaluaciones manuales no consumen este cupo.

`evaluation_daily_assignments` reserva una conversación por país y fecha de actividad. Las reservas y tareas se guardan en la misma transacción del almacén, protegida por el bloqueo existente y una clave única de MySQL. Reintentos, cambios de límite y reinicios no liberan cupos. El excedente queda fuera de muestra; nunca se convierte automáticamente en deuda del día siguiente.

La selección puede ser aleatoria reproducible, por actividad más reciente o más antigua. La muestra aleatoria utiliza una huella estable de fecha, país e ID. Es reproducible para el mismo conjunto disponible; con llegadas parciales mantiene lo elegido y completa las plazas restantes. Ambos modelos reciben exactamente los mismos IDs.

## Prompts por ítem

Cada ítem del checklist evaluado con IA admite:

- Instrucciones generales y sus criterios existentes, sin instrucciones adicionales.
- Un prompt del ítem compartido por Clef y Gemma.
- Un prompt del ítem para Clef y otro para Gemma.

Los ítems calculados por código se identifican como tales. Las instrucciones del ítem solo se transmiten en su propia entrada del checklist; Clef nativo las recibe tanto al clasificar como al elegir evidencia. Las instrucciones generales también pueden compartirse o separarse por modelo. Ningún modelo recibe respuestas del otro.

Se conservan las reglas técnicas de formato, tipos, evidencia y protocolos locales. La vista previa muestra la composición de instrucciones generales y las adicionales por ítem. El historial guarda todo el conjunto; restaurarlo crea una nueva revisión sin reevaluar el histórico.

El lote congela catálogo, perfiles, configuración y textos de prompts, incluidas las instrucciones por ítem. Cada modelo tiene una huella propia; una huella del conjunto permite comprobar la compatibilidad de la pareja sin exigir textos iguales. Consenso, comparaciones y dashboard verifican ambas identidades. Las huellas nuevas son independientes del orden de claves de JSON en MySQL.

## Ejecución y recuperación

| Modo | Barrera |
|---|---|
| Paralelo | Cada modelo tiene su propia concurrencia y puede solaparse con el otro. |
| Secuencial por lote | El primero termina su pasada e intentos del lote completo antes del segundo. Un bloque técnico no cierra la pasada. |
| Secuencial por conversación | El segundo espera al primero y sus intentos únicamente para esa conversación. |

Tras agotar los intentos, una revisión fallida requiere atención y permite continuar al otro modelo. Se conservan variables ya completadas. Los reintentos transitorios usan esperas persistidas; las respuestas con contrato inválido y los errores de configuración quedan identificados para revisión administrativa. Reanudar explícitamente inicia una nueva ronda de intentos. Si cambió la conexión del modelo, prepara una revisión compatible de ambos modelos conservando el cupo y los prompts originales.

Una sola ejecución se adquiere atómicamente. Los bloques alternan lotes según su último turno; las selecciones distribuyen los países. El trabajador renueva su latido cada 15 segundos. Un trabajo sin latido durante 10 minutos puede recuperarse; su token impide que un trabajador anterior publique resultados tardíos.

La pausa o deshabilitación impide iniciar solicitudes nuevas; las solicitudes en vuelo terminan. Rehabilitar un país permite retomar pendientes. Al detectar contenido distinto, se prepara una nueva revisión de la selección para ambos modelos. Los resultados históricos permanecen y nunca aportan consenso a una versión diferente.

El monitor permite consultar por jornada: disponibles, seleccionadas, cupo, fuera de muestra y progreso por modelo. Al expandir una ejecución se ven versiones, modelos, huellas, próximo reintento y errores. Las alertas persistentes distinguen carga ausente, carga sin elegibles, modelo no disponible, reintentos agotados y errores que requieren atención.

## APIs relativas a `/pulsoAtom/api`

| Método y ruta | Uso |
|---|---|
| `GET /evaluations/settings` | Configuración normalizada, versión, países y checklist. |
| `PATCH /evaluations/settings` | `{ expectedVersion, automation }`; conflicto devuelve 409. |
| `GET /evaluations/settings/history` | Revisiones con autor y fecha. |
| `PATCH /evaluations/settings` | `{ expectedVersion, restoreVersion, restoreScope: "prompts" | "all" }`. |
| `POST /evaluations/settings/preview` | `{ automation }`, sin llamar a modelos. |
| `GET /evaluations/automation?activityDate=YYYY-MM-DD` | Estado de jornada, países, modelos, alertas y trabajos. |
| `POST /evaluations/automation/control` | `{ expectedVersion, action: "pause" | "resume", country?: "HN" }`. |
| `POST /evaluations/:id/resume` | Reutiliza la reanudación existente; conserva resultados completados. |

Los endpoints de descubrimiento y conexión del Gateway se mantienen. Guardar una conexión no cambia el orden configurado ni desactiva la nueva automatización. Las credenciales nunca se guardan en snapshots ni se envían al frontend.

## Transición controlada

1. Verificar respaldo y aplicar la migración aditiva `005_evaluation_automation.sql` **antes de arrancar el código nuevo**. El workflow de despliegue existente espera a que las evaluaciones estén libres, adquiere el bloqueo de mantenimiento y ejecuta `npm run db:migrate --prefix api -- --defer-online-indexes` antes del reinicio. Para un despliegue manual, mantener ese mismo orden. No ejecutar seeds ni reiniciar evaluaciones.
2. Mantener una sola instancia del planificador de API. No añadir cron ni procesos de evaluación independientes. El bloqueo persistente protege adquisiciones concurrentes, pero la operación prevista usa un único planificador.
3. Revisar los trabajos extraordinarios existentes. Sus manifiestos mantienen su flujo hasta finalizar; no se generan nuevas recuperaciones fechadas desde el detector recurrente. Los trabajos diarios anteriores ya seleccionados se trasladan a la cola, preservando perfiles, contexto y resultados completados.
4. Abrir Configuración de evaluaciones. La primera lectura importa países, límites, tiempo, orden y prompts existentes. El primer guardado activa el uso del nuevo planificador; puede guardarse desactivado o pausado para preparar la puesta en marcha.
5. Ejecutar el piloto sintético con las conexiones locales del entorno. Revisar cupos, prompts por ítem y modos antes de habilitar los países previstos. Comprobar la primera carga de las 00:01 y las alertas del monitor.

El código anterior requiere la misma base; para revertir una entrega, primero pausar, esperar a que no existan solicitudes en vuelo y conservar tabla, historial y cola. No borrar las asignaciones ni permitir que el planificador anterior vuelva a asignar la misma jornada.

## Piloto local sin modificar datos de producción

Desde `api/`, con `.env` de backend y conexiones locales configuradas:

```sh
node scripts/pilot-evaluation-automation.js
node scripts/pilot-evaluation-automation.js --run --mode parallel
node scripts/pilot-evaluation-automation.js --run --mode model-first
node scripts/pilot-evaluation-automation.js --run --mode conversation-first
```

La primera orden solo prepara el plan. `--run` realiza primero las sondas sintéticas existentes y luego procesa cinco conversaciones inventadas: selecciona una de Honduras y una de Panamá; Costa Rica permanece deshabilitada. Se esperan cuatro revisiones completas. El estado de evaluación se guarda en un archivo temporal aislado y se retira al finalizar. Solo se lee la configuración de Pulso; no se modifica Pulso, Atom ni su programación. El reporte incluye identidades y huellas, sin credenciales.

En esta entrega el plan del piloto devuelve `GATEWAY_CONFIGURATION_REQUIRED`: la copia aislada no contiene conexión ni credencial de GatewayAgents. Las pruebas usan adaptadores controlados; no sustituyen la ejecución de ese piloto ni la validación de la migración en MySQL de destino.

Un reinicio durante una solicitud puede repetir la llamada si el Gateway no admite idempotencia. La adquisición y persistencia impiden duplicar el resultado guardado.
