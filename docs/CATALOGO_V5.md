# Catálogo v5 · 3 de noviembre de 2026

## Implementación

Fuente: `Catalogo_variables_calidad_contact_center_v5_26.11.03_v2.xlsx`, hoja Catálogo, A1:I94, y notas asociadas. El importador `api/scripts/import-catalog-v5.py` permite reproducir los archivos del catálogo sin modificar el libro.

| Tipo | Cantidad |
|---|---:|
| Flags críticos | 30 |
| Flags normales | 43 |
| Flags positivos | 6 |
| Métricas | 7 |
| Descriptores | 4 |
| Calculados | 3 |
| Total | 93 |

La fase 1 habilita 64 variables: 49 IA, 10 código y 5 cálculo. Fases 2 y 3 quedan inactivas. El catálogo distingue habilitación de disponibilidad. Las integraciones y reglas no implementadas no se pueden activar desde filas, lotes ni formularios; el backend también impide su ejecución.

Pendientes explícitos de fase 1:

- Primera respuesta mayor a cinco minutos: falta horario de atención por país. Se muestra la métrica de tiempo transcurrido.
- Varios humanos atendieron: falta identidad de agente por mensaje; nunca se infiere del asesor actual.
- Botones no usados: faltan botones ofrecidos y seleccionados.

El motor no evalúa multimedia ni introduce fuentes externas nuevas. Código y cálculo se ejecutan una vez por conversación, antes de las llamadas a modelos, resolviendo sus dependencias internamente. Las tres variables pendientes no bloquean las restantes.

## Histórico y puesta en funcionamiento

La migración de datos `migrateCatalogV5` usa el marcador `metadata.catalogRevision`. Conserva snapshots previos, evaluaciones, revisiones y políticas. Los IDs retirados se guardan con `retired:true` e `active:false`; se excluyen del catálogo vigente. Renombres y fusiones no generan equivalencias artificiales entre resultados.

El arranque de la API aplica la migración de forma transaccional e idempotente antes de iniciar el scheduler. También puede ejecutarse explícitamente desde `api/` con `npm run db:catalog-v5`, una vez disponible el esquema propio. No requiere cambios de credenciales ni modifica Atom.

No ejecutar el importador antiguo v2 sobre `catalog.json`. Para regenerar la fuente v5: `python3 api/scripts/import-catalog-v5.py --workbook <ruta-del-excel-v5>`.

Las evaluaciones anteriores continúan mostrando sus propias definiciones y clasificaciones. Las etiquetas P1/P2 se traducen visualmente a crítico/normal; no se aplican las reglas actuales a valores históricos. Las nuevas ejecuciones usan v5. Una reanudación con reglas, instrucciones o catálogo distintos se rechaza antes de modificar el lote.

La implementación no borra ni vuelve a evaluar el histórico, no cambia los perfiles GPT/Gemini ni la programación existente. Al desplegar, la programación que ya esté habilitada continuará con el nuevo catálogo. Una prueba real adicional debe delimitarse expresamente; todas las pruebas de esta entrega usan datos sintéticos o proveedores simulados.

## Interfaces y resultados

- Listados: `critical`, `normal`, `positive`, `dualDetected`, `pendingFlags`, `evaluationErrors`, `evaluationIncomplete`; se conservan `p1`/`p2` como alias técnicos de compatibilidad.
- Filtros: `classification=critical|normal|positive|all`, `agreement=both|all`. Los filtros se intersectan sobre la misma marca, además de país y fechas. Los parámetros antiguos `priority=P1|P2` siguen admitidos.
- Marcas: clasificación, origen, vigencia y resumen de coincidencia. La refutación conserva la respuesta original, pero excluye la marca de los conteos vigentes y del distintivo de ambos modelos.
- Detalle: `metrics` y `descriptors` separados; `variables` conserva los registros completos para compatibilidad. Las métricas no se entregan en las muestras comparativas ni en los diagnósticos de tareas.
- Catálogo: `availability` contiene `status`, `reason` y `canActivate`.

Positivos y alertas pueden coexistir. El positivo no compensa un evento crítico. Métricas y descriptores no se convierten en flags, no se pueden refutar y no generan votos. Los resultados positivos sí admiten revisión humana con autor, fecha, motivo y evidencia.

La coincidencia exige la misma variable, contenido, catálogo, instrucciones y reglas. Perfiles duplicados, reintentos y resultados impuestos por código no incrementan los votos. Un error técnico no se considera ausencia del evento ni abstención legítima.

Los adaptadores validan cada ítem, conservan resultados válidos y reintentan únicamente los inválidos, dentro del límite existente. Los diagnósticos incluyen la variable y las reglas fallidas, sin registrar credenciales ni respuestas brutas. Se mantiene la identidad del proveedor; no se mezclan respuestas de respaldo bajo el nombre del principal.

## Minidashboard diario de Conversación

El detalle `GET /pulsoAtom/api/conversations/:id` incorpora `dailyMetrics`, calculado por código a partir de los mensajes actuales de Atom. El bloque contiene los días disponibles, siete métricas por día, esperas pendientes y referencias de cruces de fecha. Solo se entrega en el detalle, nunca en listados, Resumen o comparación de modelos.

El día corresponde a la fecha del mensaje en `APP_TIMEZONE` (por defecto `America/Tegucigalpa`), no a la fecha de carga. Se selecciona inicialmente el último día con mensajes; `metricDate=YYYY-MM-DD` conserva la selección en la URL. Cambiarlo no consulta la IA ni vuelve a cargar la conversación. Solo cambia el minidashboard: la transcripción, el checklist, sus flags y las revisiones conservan su alcance original.

La presentación prioriza cuatro bloques: tiempo transcurrido, primera respuesta humana, espera más larga con respuesta y distribución de mensajes entre cliente y equipo (personas + bot). Los tiempos se muestran en horas/minutos/segundos, con redondeo al segundo. La línea de actividad usa exclusivamente timestamps reales del día; los intervalos cliente → persona requieren evidencia de esa fecha. El anillo representa conteos, no calidad ni cumplimiento. Ratio y mensajes por turno aparecen en un segundo nivel. La ayuda consultable conserva cálculo, cobertura y alcance; la animación breve respeta `prefers-reduced-motion`.

- Las siete métricas comparten el mismo día. Se excluyen eventos de sistema.
- **Tiempo transcurrido del día:** primer → último mensaje de ese día, incluidas sus pausas. No significa tiempo de trabajo ni separa el chat en atenciones.
- **Mayor silencio humano:** mayor espera completada cliente → humano dentro del día. El bot y los mensajes adicionales del cliente no reinician la espera. Un pendiente posterior no oculta los intervalos completados.
- **Espera pendiente:** se presenta aparte, observada solo hasta el último mensaje disponible de ese día, nunca hasta la hora actual. Cero minutos observados sigue significando pendiente, no atendida.
- **Cruces de día:** se conserva la referencia entre el primer cliente pendiente y el humano de otra fecha, marcada como continuidad no confirmada. No se agrega esa separación al silencio diario ni se interpreta como SLA.
- Una fecha inválida de cliente/bot/humano impide asignar todo el contenido a días. Se conservan las fechas válidas disponibles, pero las siete métricas quedan no disponibles con motivo; no se deducen esperas de una secuencia incompleta.

La regla de presentación se identifica con `pulso-daily-metrics-v1`. No modifica las reglas del evaluador ni las huellas de equivalencia, no escribe métricas nuevas en MySQL y no requiere migración. Los campos históricos `metrics`, `variables`, evaluaciones y revisiones se mantienen para compatibilidad; el minidashboard no reutiliza métricas acumuladas como si fueran diarias. Si la API aún no entrega `dailyMetrics`, la interfaz indica que no están disponibles.

## Reglas del evaluador guardado y repetición

Estas reglas conservan el alcance del contenido evaluado y el significado de los flags guardados; son independientes del selector diario del minidashboard.

- Primera respuesta: primer cliente → siguiente humano; tiempo transcurrido sin descontar horarios.
- Silencio: primer cliente pendiente → siguiente humano. El bot y nuevos mensajes del cliente no reinician la espera. Si queda una espera sin respuesta, el máximo queda no disponible.
- Duración: primer → último mensaje del contenido evaluado, sin separación por atenciones.
- Conteos: cliente y asistente (bot + humano), excluyendo eventos de sistema.
- Ratio: mensajes del asistente / cliente; sin divisor válido queda no disponible.
- Turnos: series consecutivas del asistente sin mensaje del cliente intermedio; sin turnos no hay promedio.
- Timestamps ausentes o inválidos impiden el cálculo temporal, nunca producen cero ficticio.
- Umbrales de flags son estrictamente mayores que 10 y 120 minutos. El de 5 permanece pendiente por horarios.
- Repetición: normalización Unicode NFKC, mayúsculas y espacios; igualdad exacta o similitud de edición ≥90%, mínimo 20 caracteres para aproximación y sin cambios en números o negaciones. Se conserva la pareja de mensajes y versión de regla.

## Validación

Pruebas automatizadas: `npm test` en `api/` y `web/`; compilación: `npm run build` en `web/`. Se prueban migración repetida, histórico, dependencias, tipos, datos faltantes, límites temporales, similitud, votos, discrepancias, error parcial, reanudación, permisos y activaciones bloqueadas.

Validación visual con una API demo aislada: Resumen y Activas caben sin scroll exterior en 1366×768, 1440×900 y 1920×1080. Conversación conserva desplazamiento vertical y no presenta desbordamiento horizontal. Se verifican navegación directa, filtro de ambos modelos, dos columnas de evidencia, catálogo CRUD y revisión positiva.

El helper `addV5Demo(state)` de `api/src/data/v5-demo.js` añade cuatro casos sintéticos de v5 a un estado demo, de forma idempotente. Rechaza estados reales. No llama a proveedores y no altera la semilla histórica predeterminada.
