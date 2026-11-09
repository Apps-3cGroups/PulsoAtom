# Consolidación de herramientas de modelos

Revisión del 9 de noviembre de 2026, sobre `main` en `e028fce` (incluye la revisión de conversaciones por mensaje del PR #26).

## Qué llega al código mantenido

| Rama de origen | Decisión |
| --- | --- |
| `codex/clef-decisions-adapter` · `4938950` · PR #23 | Integrar la distinción entre una abstención válida y una variable que el adaptador no puede evaluar. En comparación se muestra «No evaluada»; para calidad cuenta como sin resultado, no como abstención. |
| `codex/clef-gateway-route` · `630a9b4` | Conservar la inspección estructural de respuestas y convertir el inspector en una herramienta offline con archivo explícito. Los adaptadores, contratos e instrucciones más recientes de `main` se mantienen. |
| `codex/clef-same-500` · `2cec740` | El tratamiento seguro de límites de contexto ya está en `main`, al igual que el progreso por modelo en Evaluaciones. No reincorporar lanzadores del primer lote ni el monitor temporal con datos fijados a ese lote. |
| `codex/new500-status-detail` · `acdc167` | Extraer la auditoría agregada a una utilidad para cualquier lote operativo dual existente. Conservar compatibilidad con `start-next-local-batch.js --inspect`. |

No se copian respuestas, capturas, credenciales, archivos de estado, fuentes compiladas del monitor ni dependencias. Tampoco se incorporan scripts antiguos que modificaban Gateway, importaban resultados experimentales o reanudaban conversaciones concretas. La reanudación antigua filtrada por perfiles solo la necesitan esos scripts descartados.

La integración conserva los commits de las cuatro ramas como antecedentes mediante un merge de conservación de historial después de portar los cambios seleccionados. Ese merge conserva el árbol ya revisado: **no afirma que todos los experimentos históricos estén en producción**. Para conservar esta relación al llevar el PR a `main`, usar **Create a merge commit**, no squash. Después se pueden borrar las cuatro ramas de origen y la rama de consolidación. Los scripts excluidos siguen consultables en sus commits anteriores.

El PR #27 (`codex/dashboard-comparativo-clef-gemma`) es independiente y no forma parte de esta consolidación.

## Inspección offline de una respuesta ya capturada

Desde `api/`:

```sh
node scripts/inspect-captured-response.js --file /ruta/privada/captura.json
```

Acepta un objeto JSON de hasta 10 MiB, incluidos envoltorios conocidos de Gateway. Devuelve tipos y longitudes de `content` y razonamiento, presencia de un objeto JSON/resultados, cantidad de opciones y causa normalizada de fin. No devuelve el contenido, nombres de campos arbitrarios, argumentos de herramientas, identidad del modelo ni errores libres del proveedor. Un fallo de lectura produce un mensaje genérico sin la ruta privada.

No consulta servicios, no evalúa, no modifica la captura ni convierte una respuesta capturada en una evaluación. La estructura por sí sola no demuestra la calidad o validez de una evaluación.

## Auditoría de un lote operativo dual

Desde `api/`, en el entorno con la configuración habitual de Pulso y Atom:

```sh
node scripts/inspect-evaluation-batch.js --job-id UUID_DEL_LOTE
```

Usa el ID de ejecución completo del lote guardado, no un ID de conversación ni de mantenimiento. Exige dos perfiles independientes, valida las tareas y evaluaciones pertenecientes al lote y consulta Atom únicamente para sus conversaciones. No admite seleccionar conversaciones nuevas ni iniciar, reintentar o reanudar evaluaciones.

Devuelve:

- `coverage`: conversaciones evaluadas, pendientes de segunda revisión, parciales, sin evaluación, con origen ausente o modificado y con resultados guardados. `sourceMissing` está incluido en `notEvaluated`; no sumar ambos.
- `agreed`: flags vigentes coincidentes, por clasificación, y conversaciones con coincidencias. Respeta refutaciones, equivalencia y reglas de publicación actuales.
- `models`: tareas completas, parciales, fallidas, en curso y pendientes; evaluaciones guardadas, intentos, tiempos y códigos de error normalizados.
- `aiResults`: resultados evaluados, abstenciones válidas, no disponibles por limitación del adaptador, errores técnicos y resultados faltantes. Los resultados de código no se cuentan como votos de IA.

El alcance es siempre el lote solicitado, aunque existan evaluaciones posteriores de las mismas conversaciones. No se cambian las referencias oficiales. La fuente y las revisiones humanas consultadas son las actuales, por lo que cambios posteriores pueden modificar la cobertura y los flags visibles del diagnóstico.

`elapsedSeconds` representa el intervalo entre el primer intento y la última finalización del modelo (o la hora de consulta si sigue pendiente); incluye esperas y reintentos. No es tiempo puro de inferencia ni una estimación de finalización. Este diagnóstico no verifica si el proceso trabajador sigue vivo.

La salida contiene conteos, fechas, IDs de perfil y claves de variables del catálogo para errores agregados. No contiene transcripciones, razones libres, respuestas crudas, claves, rutas privadas ni IDs de conversación. Si no se puede demostrar el alcance, falla sin presentar cifras parciales como válidas.

### Desde GitHub Actions

En `Deploy PulsoAtom`, seleccionar **evaluation-batch-inspect** e indicar `job_id`. También se puede despachar manualmente:

```sh
gh workflow run deploy-pulso-atom.yml --repo Apps-3cGroups/PulsoAtom --ref main -f operation=evaluation-batch-inspect -f job_id=UUID_DEL_LOTE
```

La opción solo existe en la revisión que contiene esta consolidación. Usa código aislado del commit seleccionado y el entorno existente; no despliega ni reinicia servicios. `job_id` se valida antes de formar el comando remoto. Al hacer push o merge, los diagnósticos no se ejecutan automáticamente; la ruta normal de despliegue sigue separada.

No se han ejecutado consultas de producción, llamadas de IA, reanudaciones ni cambios de políticas para validar esta consolidación. Las pruebas usan datos sintéticos.
