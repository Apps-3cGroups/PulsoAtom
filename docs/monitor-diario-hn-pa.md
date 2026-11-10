# Monitor de la corrida del 9 de noviembre de 2026

Dashboard independiente en `/pulsoAtom/monitor-evaluaciones/index.html`. Reutiliza la sesión de administrador de Pulso y consulta únicamente el endpoint autenticado de ejecuciones cada 30 segundos, sin solapar consultas ni descargar intentos o respuestas de modelos. Conserva la última lectura si hay un fallo y distingue sesión vencida, datos desactualizados y corrida interrumpida.

El alcance es actividad del 9 de noviembre, America/Tegucigalpa: 200 conversaciones HN y las 197 PA verificadas disponibles. Suma todos los lotes de esa fecha, incluye las conversaciones aún no asignadas y excluye las 206 HN diferidas por cupo. Las tarjetas distinguen completas, parciales, fallidas, en proceso y pendientes por modelo. El objetivo aumenta si se asignan más conversaciones de esa misma fecha; nunca se cuentan los intentos como revisiones adicionales.

## Publicación sin interrupción

La operación `daily-activity-monitor` de `.github/workflows/deploy-pulso-atom.yml` instala solo los archivos compilados del dashboard. No hace pull de main, no recompila el portal en el servidor, no cambia base de datos o modelos y no reinicia procesos. El instalador valida inventario, tipos de archivos y hashes, rechaza enlaces simbólicos y respalda un monitor previo de su propiedad antes del reemplazo atómico.

Se publica desde `codex/monitor-diario-hn-pa`, sin merge durante la corrida. Un despliegue completo posterior que reconstruya `web/dist` elimina este monitor temporal; puede reinstalarse con la misma operación. No debe presentarse como un monitor genérico de otras fechas sin cambiar y verificar su alcance.

## Construcción y verificación

- `node --test web/monitor/test/progress.test.js`
- `web/node_modules/.bin/vite build --config web/monitor/vite.config.js`
- `node web/monitor/write-artifact.js`

Se verifican cuotas entre varios lotes, ambas fases, incorporación de Panamá, parciales, exclusión de otros días, duplicados, acceso, actualización sin superposición y cierre de la corrida. Se contrastaron las sumas contra agregados reales de MySQL y se revisó visualmente el dashboard con ese corte.
