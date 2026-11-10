# Rendimiento de Dashboard y Activas

La entrega funcional y esta optimización se publican por separado. Esta rama conserva los contratos de resultados y las reglas de consenso de la entrega funcional.

## Lecturas y trazabilidad

- Autenticación consulta únicamente la sesión y su usuario; el inicio/cierre de sesión limita su transacción a usuarios y sesiones, conservando el bloqueo compartido. Bootstrap consulta catálogo y metadatos del origen; scheduler y salud leen configuración, políticas y trabajos.
- Dashboard y Activas aplican país, fechas y estados en SQL antes de recuperar conversaciones. Evaluaciones, tareas, revisiones y muestras se limitan a las conversaciones y trabajos relacionados.
- Las consultas de navegación mantienen una instantánea consistente de las tablas del portal. Verifican huellas de los registros en cada lectura y descargan únicamente las versiones que no están en memoria. La caché de payloads tiene un límite de 128 MiB serializados; el uso real de memoria incluye los objetos JavaScript.
- Las conversaciones sin evaluación no cargan transcripciones. Las evaluadas calculan la huella de contenido por documento/SHA y contexto del emisor; una nueva versión vuelve a leer los mensajes. Los resúmenes derivados se invalidan por cambios de fuente, catálogo, evaluaciones, tareas, trabajos, muestras, referencias o revisiones humanas. Las rutas de detalle y escritura no usan esta caché.
- Las exposiciones se consultan por ID y se insertan puntualmente con `INSERT IGNORE`; las ya existentes conservan su registro original. No se carga ni se reemplaza toda la auditoría.
- Las respuestas grandes de `/summary` y `/active` negocian gzip y mantienen `Cache-Control: private, no-store`. La reutilización interna verifica versiones; el navegador sigue consultando datos actuales.

## Medición reproducible

Se ejecutaron lecturas y serialización desde el servidor, sin invocar modelos, publicar código ni escribir exposiciones. Conjunto fijo por última actividad: 12/10/2026 a 10/11/2026. Las métricas siguientes excluyen autenticación, escritura de auditoría y transporte HTTP hasta el navegador.

| Escenario | Conversaciones | p95 anterior | p95 optimizado | Reducción |
|---|---:|---:|---:|---:|
| 30 días, todos | 6,740 | 11.188 s | 2.770 s | 75.2 % |
| 30 días, HN + PA | 4,145 | 7.891 s | 1.984 s | 74.9 % |
| Activas, HN + PA | 306 | 3.212 s | 0.311 s | 90.3 % |

La referencia usa cinco repeticiones después del primer acceso; la versión optimizada usa diecinueve. Ambos caminos recuperan el mismo universo con los mismos filtros. La comparación de equivalencia se realizó además bajo una misma instantánea del portal: cero diferencias en los tres escenarios, incluidas las respuestas reutilizadas. Los resultados de modelos pueden seguir llegando durante las mediciones.

Evidencias: [comparación inicial](https://github.com/Apps-3cGroups/PulsoAtom/actions/runs/42921680971), [medición final](https://github.com/Apps-3cGroups/PulsoAtom/actions/runs/42923019837).

El primer acceso de 30 días tras iniciar el proceso, sin caché, tardó 16.184 s. El objetivo de p95 se cumple para consultas repetidas; no se afirma que el primer acceso o la carga visual completa estén por debajo de tres segundos. Los índices nuevos aún no estaban disponibles en estas mediciones.

```sh
node --env-file=api/.env api/scripts/benchmark-navigation.js --iterations=20 --trace
node --env-file=api/.env api/scripts/benchmark-navigation.js --paired --baseline-root=/ruta/entrega-funcional
node --env-file=api/.env api/scripts/verify-navigation.js --baseline-root=/ruta/entrega-funcional
```

`verify-navigation` utiliza una instantánea de lectura, compara todos los campos del resumen y las métricas, e informa por separado documentos que cambiaron durante la comprobación. No imprime mensajes ni nombres de clientes.

## Índices, publicación y reversión

La migración 004 añade columnas virtuales derivadas del JSON e índices de conversación en `evaluations`, y conversación/trabajo en `evaluation_tasks`. Reutiliza los índices del origen. Cada paso es repetible y tiene espera de bloqueo limitada a 10 segundos, sin detener transacciones ajenas.

El despliegue ejecuta las migraciones funcionales antes de reiniciar y difiere los índices online hasta liberar las conexiones del código anterior. Si un índice encuentra un bloqueo, la migración falla de forma visible y puede repetirse con `npm run db:migrate --prefix api`; la navegación utiliza un predicado JSON equivalente mientras no exista la columna. La primera comprobación manual sólo alcanzó a crear `evaluations.conversation_key`; no se registró la migración como completada.

Para revertir rendimiento, revertir su PR y desplegar. Las columnas e índices aditivos pueden permanecer: el código anterior no depende de ellos. No se modificaron resultados ni transcripciones. La reversión funcional es independiente y debe coordinarse con cualquier corrida activa para conservar su recuperación. El despliegue preserva el monitor estático de avance existente.

La validación visual y la publicación permanecen pendientes mientras el navegador de Work está deshabilitado.
