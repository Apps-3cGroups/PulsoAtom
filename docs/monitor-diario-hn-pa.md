# Monitor de recuperación y continuación del jueves

El monitor conserva la dirección `/pulsoAtom/monitor-evaluaciones/index.html` y la sesión administrativa de Pulso. Consulta cada 30 segundos, sin solapar solicitudes, y conserva la última lectura ante errores. La pantalla muestra primero el jueves 12 y, por separado, las 212 conversaciones y 422 revisiones de recuperación del martes y miércoles. No se suman ambos alcances porque comparten conversaciones.

## Conteos del jueves

Se identifican únicamente los lotes operativos del handoff autorizado y su huella. El registro de cupos `dailyQuotaCountries` cuenta IDs únicos por país, incluidos los resultados válidos incorporados al crear los lotes. `conversationCountries` identifica el país de cada conversación asignada a nuevas revisiones. Ante varias versiones de una conversación, prevalece la asignación más reciente; no se duplican sus conteos.

Una conversación asignada está completa cuando sus tareas de Clef y Gemma están completas. Los estados por conversación se consultan mediante el endpoint administrativo existente de tareas e intentos. El cliente descarta los intentos y reduce las tareas a identidad de conversación, modelo y estado; no conserva respuestas, evidencias ni transcripciones en su caché. Las respuestas se reutilizan mientras no cambia la firma del lote. Las tarjetas de modelos cuentan exclusivamente revisiones asignadas; las conversaciones con resultados anteriores se indican por separado.

Las cifras corresponden a conversaciones registradas en los lotes de Pulso, no a un inventario completo de la cola interna de Automations. Nuevas selecciones aparecen al asignarse. Cero pendientes significa estar al día con lo registrado, no probar que terminó la importación. El límite continúa en 200 conversaciones únicas por país.

`waiting_thursday` es una espera normal de la recuperación: el estado global utiliza la actividad del jueves y no presenta una interrupción deliberada del martes como un bloqueo de la corrida actual. Las advertencias de datos obsoletos y errores de autenticación se mantienen.

## Publicación y workflow

Esta rama conserva íntegro el workflow de `main`, dedicado exclusivamente al despliegue del portal. La operación `daily-activity-monitor` fue retirada y no se vuelve a incorporar. Fusionar esta rama no instala ni reemplaza automáticamente este monitor histórico: el despliegue normal conserva el directorio `web/dist/monitor-evaluaciones` que ya esté publicado.

Si se necesita publicar este corte histórico, DevOps debe revisar el artefacto `web/temporary-daily` y realizar su instalación por separado. Se conserva `api/scripts/install-daily-monitor.js` como utilidad manual; espera una copia del artefacto en `static-monitor`, junto al directorio `api` dentro del paquete temporal. Valida inventario, tipos y hashes, rechaza enlaces simbólicos y respalda la instalación anterior antes de reemplazarla. La utilidad no actualiza el checkout de producción ni reinicia API, web o workers.

La versión mantenida es este monitor del jueves y su recuperación, consolidado en el PR #71. Sustituye el corte del 11 de noviembre del PR #34 en la misma dirección. El PR #34 se conserva como antecedente histórico; no requiere una fusión ni publicación adicional. El instalador compartido y las correcciones de pruebas ya están incorporados en el PR #71.

El navegador usa los endpoints existentes. `GET /evaluations` conserva su comportamiento previo del portal, incluida la recuperación de trabajos obsoletos implementada por la API; este cambio no modifica ese comportamiento ni agrega acciones de evaluación. El instalador estático no consulta ni modifica la base.

## Verificación

- `node --test web/monitor/test/*.test.js`
- `node --test web/test/monitor-deployment.test.js`
- `web/node_modules/.bin/vite build --config web/monitor/vite.config.js`
- `node web/monitor/write-artifact.js`

Validar varios lotes, reutilización, conteos por país, pares completos, parciales, cambios de versión, autenticación, caché y espera normal de martes. Revisar escritorio y móvil antes de instalar el artefacto.
