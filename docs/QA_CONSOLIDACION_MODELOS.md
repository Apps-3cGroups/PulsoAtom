# QA intensivo - Pulso

Fecha: 9 de noviembre de 2026. Alcance: consolidación de cuatro ramas de modelos sobre `main` (`e028fce`). No es una nueva auditoría integral del portal ni una prueba contra producción.

## Resumen ejecutivo

Los cambios seleccionados son compatibles con la arquitectura y los contratos actuales. La consolidación corrige la presentación de variables no disponibles y agrega herramientas de diagnóstico explícito, sin modificar el evaluador, la programación o las respuestas guardadas. No se encontraron bloqueos en la revisión focalizada.

## Estado y evidencia

| Área | Estado | Evidencia |
| --- | --- | --- |
| API | Aprobada | `npm test` en `api/`: 375 pruebas, 0 fallos, 0 omitidas. |
| Web | Aprobada | `npm test` en `web/`: 81 pruebas, 0 fallos, 0 omitidas. |
| Compilación | Aprobada | `npm run build` en `web/`; conserva `/pulsoAtom`. |
| Alcance del lote | Aprobada | Casos sintéticos de tareas duplicadas, resultados de otro job, perfiles, cambios de fuente, fuente ausente y reintentos. |
| Datos privados | Aprobada | Marcadores privados en transcripciones, razones, errores, IDs y capturas no aparecen en los informes. |
| Operación | Aprobada en pruebas | Inspector de archivo no consulta servicios; auditoría de lote usa exclusivamente la interfaz de lectura. Importar el CLI no carga configuración ni inicia conexiones. |
| Workflow | Revisado y probado estáticamente | Operación manual independiente, validación estricta del UUID, ruta de lectura aislada y despliegue separado. No se ejecutó el runner real. |
| UX | Alcance acotado | Solo cambia la etiqueta «No evaluada» en comparación; no cambia la distribución. No se hizo una nueva revisión visual manual del portal. |
| Producción | No ejecutada | Sin conexiones reales, inferencias, reanudaciones, cambios de política ni despliegues. |

## Hallazgos y límites

| Categoría | Severidad | Hallazgo | Tratamiento |
| --- | --- | --- | --- |
| Datos | Corregido | Limitaciones del adaptador se contaban como abstenciones válidas en comparación. | Se contabilizan como sin resultado; prueba diferencia ambas condiciones. |
| Operación | Prevenido | Herramientas antiguas contienen IDs de lotes y cambios de infraestructura específicos. | Se conserva el historial, pero no se reincorporan al árbol mantenido. |
| Privacidad | Prevenido | Redacción de errores libres por patrones no garantiza eliminar textos privados. | Se excluye esa utilidad; los nuevos diagnósticos solo entregan campos estructurales y códigos permitidos. |
| Rendimiento | Observación | Vite advierte un chunk mayor de 500 kB (principal: 888 kB). | No bloquea la compilación; esta consolidación no agrega librerías ni cambia partición de assets. |
| Compatibilidad | Límite explícito | Registros antiguos sin `unavailabilityCode` no permiten distinguir retroactivamente una limitación del adaptador. | Se conservan los datos históricos; no se inventa ni migra esa clasificación. |
| Diagnóstico | Límite explícito | La auditoría genérica admite lotes operativos duales; no mide vida del worker ni acepta muestras comparativas o lotes individuales. | Documentado en `CONSOLIDACION_MODELOS.md`; los argumentos no permiten iniciar ejecuciones. |

## Checklist verificado

- [x] El PR #23 queda incluido sin restaurar adaptadores antiguos.
- [x] Los diagnósticos no alteran referencias oficiales ni duplican evaluaciones/votos.
- [x] Abstenciones, falta de capacidad y errores técnicos permanecen separados.
- [x] Los resultados posteriores de otros lotes no sustituyen los del lote auditado.
- [x] Los argumentos inesperados se rechazan y los errores no imprimen datos privados.
- [x] Las pruebas no utilizan bases reales, proveedores de IA ni capturas de clientes.
- [x] Compilación y pruebas generales aprobadas.
- [x] No se añaden credenciales, `.env`, dependencias o artefactos del monitor.

## Criterio de salida

Listo para revisión y merge de la consolidación. El despliegue de producción permanece en el workflow normal de `main`. La consulta real de un lote puede hacerse después con la operación documentada; requiere la conectividad habitual a Pulso/Atom. No hay correcciones bloqueantes pendientes dentro de este alcance.
