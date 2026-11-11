# Monitor de la corrida del 11 de noviembre de 2026

Dashboard independiente en `/pulsoAtom/monitor-evaluaciones/index.html`. Reutiliza la sesión de administrador de Pulso y consulta únicamente el endpoint autenticado de ejecuciones cada 30 segundos, sin solapar consultas ni descargar intentos o respuestas de modelos. Conserva la última lectura si hay un fallo y distingue sesión vencida, datos desactualizados y corrida interrumpida.

El alcance es la corrida del 11 de noviembre sobre actividad del 10 de noviembre, America/Tegucigalpa. Al preparar esta versión se verificaron 367 conversaciones listas de HN y 164 de PA: el objetivo inicial es 200 HN + 164 PA, 364 conversaciones y 728 revisiones. El primer lote solo tiene 52 HN; el resto se incluye como pendiente de asignación. Las 167 HN fuera del cupo no aumentan el objetivo. Las tarjetas distinguen completas, parciales, fallidas, en proceso y pendientes por modelo. El objetivo aumenta si se asignan más conversaciones de esa misma fecha; nunca se cuentan los intentos como revisiones adicionales. Los totales disponibles se verificaron al preparar esta versión; la API de avance actualiza lotes y resultados, no el inventario de ingesta.

La actualización continúa cada 30 segundos incluso después de completar los lotes para detectar asignaciones posteriores. El encabezado distingue la fecha de ejecución de la fecha de actividad. No se mezcla el resultado del 9 de noviembre.

## Publicación sin interrupción

La operación `daily-activity-monitor` de `.github/workflows/deploy-pulso-atom.yml` instala solo los archivos compilados del dashboard. No hace pull de main, no recompila el portal en el servidor, no cambia base de datos o modelos y no reinicia procesos. El instalador valida inventario, tipos de archivos y hashes, rechaza enlaces simbólicos y respalda un monitor previo de su propiedad antes del reemplazo atómico.

Se publica desde `codex/monitor-diario-hn-pa`, sin merge durante la corrida. El despliegue vigente de main conserva `web/dist/monitor-evaluaciones` al reconstruir el portal; también puede reinstalarse con la misma operación. No debe presentarse como un monitor genérico de otras fechas sin cambiar y verificar su alcance.

## Construcción y verificación

- `node --test web/monitor/test/progress.test.js`
- `web/node_modules/.bin/vite build --config web/monitor/vite.config.js`
- `node web/monitor/write-artifact.js`

Se verifican cuotas entre varios lotes, ambas fases, incorporación de Panamá, parciales, exclusión de otros días, duplicados, acceso, actualización sin superposición y cierre de la corrida. Se contrastaron las sumas contra agregados reales de MySQL y se revisó visualmente el dashboard con ese corte.
