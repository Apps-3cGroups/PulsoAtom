# Cupo diario HN/PA

La programación admite `dailyLimitPerCountry`: conversaciones únicas por país y día de actividad, sumando todos los lotes de importaciones tardías. Los dos modelos consumen un solo cupo por conversación. El país se guarda en cada lote para que cambios posteriores en Atom no liberen cupos. La selección conserva el orden del origen y prioriza todo trabajo ya iniciado al reducir un lote existente.

`dailyConcurrency: 2` solapa dos conversaciones del mismo modelo. La fase completa de Clef termina antes de comenzar Gemma. No cambia el checklist, las validaciones ni los reintentos por respuesta incompleta.

## Reducir la carga en curso

Usar `api/scripts/limit-daily-activity.js` con las conexiones reales ya configuradas, sin imprimir credenciales. No realiza llamadas a modelos.

1. `--prepare YYYY-MM-DD VERSION` exige ayer en Honduras, versión vigente y programación HN/PA con Clef y Gemma. Reserva un identificador de mantenimiento que bloquea nuevos lotes. El worker actual continúa hasta el reinicio; sus resultados se siguen guardando.
2. Desplegar el código y confirmar el reinicio del worker anterior. Esperar a que expire su señal de actividad (10 minutos desde el último `updatedAt`). No aplicar mientras el worker anterior siga activo.
3. `--apply UUID VERSION` exige el mantenimiento reservado y ausencia de señales vigentes. Conserva toda conversación con resultados o intentos, completa hasta 200 por país y marca únicamente tareas nunca iniciadas como `deferred`. Registra el alcance original y las exclusiones en el lote. Si ya se iniciaron más de 200, falla sin descartar trabajo.
4. La misma transacción guarda el límite y concurrencia, libera el mantenimiento y deja el lote listo para reanudación automática. No vuelve a ejecutar resultados completos ni parciales terminales del lote ajustado. Las tareas diferidas no aparecen como pendientes ni inflan el progreso.
5. `dailyCatchupRunDate` mantiene la fecha ajustada hasta consumir el cupo disponible de ambos países, incluso si cruza medianoche. Después se retoma el día normal. El horario sigue en 00:01, America/Tegucigalpa.

El exceso queda identificado en `deferredConversationIds`; no se añade automáticamente a otro día ni se borra del origen. Una respuesta parcial sigue siendo parcial: terminar el lote no equivale a que todos los elementos del checklist hayan sido válidos.

Validación: pruebas de cuotas entre lotes y días, fuente modificada o ausente, preservación de resultados e intentos, protección contra cambios de versión, rechazo por exceso ya iniciado, reanudación sin duplicados, continuidad de Panamá tras medianoche y concurrencia de dos sin mezclar modelos.
