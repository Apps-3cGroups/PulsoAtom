# Monitor de la corrida del 11 de noviembre de 2026

Dashboard independiente en `/pulsoAtom/monitor-evaluaciones/index.html`. Reutiliza la sesión de administrador de Pulso y consulta únicamente el endpoint autenticado de ejecuciones cada 30 segundos, sin solapar consultas ni descargar intentos o respuestas de modelos. Conserva la última lectura si hay un fallo y distingue sesión vencida, datos desactualizados y corrida interrumpida.

El alcance es la corrida del 11 de noviembre sobre actividad del 10 de noviembre, America/Tegucigalpa. Al preparar esta versión se verificaron 367 conversaciones listas de HN y 164 de PA: el objetivo inicial es 200 HN + 164 PA, 364 conversaciones y 728 revisiones. El primer lote solo tiene 52 HN; el resto se incluye como pendiente de asignación. Las 167 HN fuera del cupo no aumentan el objetivo. Las tarjetas distinguen completas, parciales, fallidas, en proceso y pendientes por modelo. El objetivo aumenta si se asignan más conversaciones de esa misma fecha; nunca se cuentan los intentos como revisiones adicionales. Los totales disponibles se verificaron al preparar esta versión; la API de avance actualiza lotes y resultados, no el inventario de ingesta.

La actualización continúa cada 30 segundos incluso después de completar los lotes para detectar asignaciones posteriores. El encabezado distingue la fecha de ejecución de la fecha de actividad. No se mezcla el resultado del 9 de noviembre.

## Publicación y workflow

Esta rama conserva íntegro el workflow de `main`, dedicado exclusivamente al despliegue del portal. La operación `daily-activity-monitor` fue retirada y no se vuelve a incorporar. Fusionar esta rama no instala ni reemplaza automáticamente este monitor histórico: el despliegue normal conserva el directorio `web/dist/monitor-evaluaciones` que ya esté publicado.

Si se necesita publicar este corte histórico, DevOps debe revisar el artefacto `web/temporary-daily` y realizar su instalación por separado. Se conserva `api/scripts/install-daily-monitor.js` como utilidad manual; espera una copia del artefacto en `static-monitor`, junto al directorio `api` dentro del paquete temporal. Valida inventario, tipos de archivos y hashes, rechaza enlaces simbólicos y respalda un monitor previo de su propiedad antes del reemplazo atómico. La utilidad no cambia la base de datos ni reinicia procesos.

Este corte y el monitor del jueves del PR #71 utilizan la misma dirección y son alternativas de publicación. No debe presentarse este monitor como uno genérico de otras fechas sin cambiar y verificar su alcance.

## Construcción y verificación

- `node --test web/monitor/test/progress.test.js`
- `web/node_modules/.bin/vite build --config web/monitor/vite.config.js`
- `node web/monitor/write-artifact.js`

Se verifican cuotas entre varios lotes, ambas fases, incorporación de Panamá, parciales, exclusión de otros días, duplicados, acceso, actualización sin superposición y cierre de la corrida. Se contrastaron las sumas contra agregados reales de MySQL y se revisó visualmente el dashboard con ese corte.
