# Monitor de recuperación y continuación del jueves

El monitor conserva la dirección `/pulsoAtom/monitor-evaluaciones/index.html` y la sesión administrativa de Pulso. Consulta cada 30 segundos, sin solapar solicitudes, y conserva la última lectura ante errores. La pantalla muestra primero el jueves 12 y, por separado, las 212 conversaciones y 422 revisiones de recuperación del martes y miércoles. No se suman ambos alcances porque comparten conversaciones.

## Conteos del jueves

Se identifican únicamente los lotes operativos del handoff autorizado y su huella. El registro de cupos `dailyQuotaCountries` cuenta IDs únicos por país, incluidos los resultados válidos incorporados al crear los lotes. `conversationCountries` identifica el país de cada conversación asignada a nuevas revisiones. Ante varias versiones de una conversación, prevalece la asignación más reciente; no se duplican sus conteos.

Una conversación asignada está completa cuando sus tareas de Clef y Gemma están completas. Los estados por conversación se consultan mediante el endpoint administrativo existente de tareas e intentos. El cliente descarta los intentos y reduce las tareas a identidad de conversación, modelo y estado; no conserva respuestas, evidencias ni transcripciones en su caché. Las respuestas se reutilizan mientras no cambia la firma del lote. Las tarjetas de modelos cuentan exclusivamente revisiones asignadas; las conversaciones con resultados anteriores se indican por separado.

Las cifras corresponden a conversaciones registradas en los lotes de Pulso, no a un inventario completo de la cola interna de Automations. Nuevas selecciones aparecen al asignarse. Cero pendientes significa estar al día con lo registrado, no probar que terminó la importación. El límite continúa en 200 conversaciones únicas por país.

`waiting_thursday` es una espera normal de la recuperación: el estado global utiliza la actividad del jueves y no presenta una interrupción deliberada del martes como un bloqueo de la corrida actual. Las advertencias de datos obsoletos y errores de autenticación se mantienen.

## Publicación sin reiniciar evaluaciones

La operación explícita `daily-activity-monitor` instala únicamente `web/temporary-daily` en el directorio del monitor. Valida inventario, tipos y hashes, rechaza enlaces simbólicos, respalda la instalación anterior y reemplaza los archivos. No actualiza el checkout de producción ni reinicia API, web o workers. El despliegue normal del portal conserva este directorio.

El navegador usa los endpoints existentes. `GET /evaluations` conserva su comportamiento previo del portal, incluida la recuperación de trabajos obsoletos implementada por la API; este cambio no modifica ese comportamiento ni agrega acciones de evaluación. El instalador estático no consulta ni modifica la base.

## Verificación

- `node --test web/monitor/test/*.test.js`
- `node --test web/test/recovery-workflow.test.js web/test/monitor-deployment.test.js api/test/deployment.test.js`
- `web/node_modules/.bin/vite build --config web/monitor/vite.config.js`
- `node web/monitor/write-artifact.js`

Validar varios lotes, reutilización, conteos por país, pares completos, parciales, cambios de versión, autenticación, caché y espera normal de martes. Revisar escritorio y móvil antes de instalar el artefacto.
