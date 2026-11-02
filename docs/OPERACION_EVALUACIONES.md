# Operación de evaluaciones

## Flujo diario

La configuración reside en `portal_settings`, sin credenciales. `includeOpenConversations=true` incluye abiertas y cerradas; `refreshChangedConversations=true` detecta contenido nuevo mediante una huella SHA-256. Las abiertas son provisionales. El cierre modifica la huella aunque no haya mensajes nuevos.

El horario de esta instalación es 07:00, `America/Tegucigalpa`. Se conserva al renovar el histórico. La API debe permanecer encendida, con acceso al origen, a la base propia y al proveedor de IA. La programación ejecuta como máximo 100 casos por día; el portal permite lotes manuales de 20. El excedente queda pendiente. Los casos sin texto evaluable no se convierten en evaluaciones vacías.

Una importación idéntica no genera llamadas nuevas. Los fallos y las conversaciones modificadas durante la evaluación quedan pendientes. Se permite un reintento por fallo transitorio o respuesta inválida. Las versiones anteriores se conservan durante actualizaciones ordinarias. La evaluación vigente usa el contenido más reciente que se pudo evaluar; el portal avisa si Atom vuelve a cambiarlo.

Evaluar el 100% de conversaciones no significa que todas las variables tengan una conclusión: «No evaluado» conserva la falta de contexto y no equivale a cero. No se infiere contenido multimedia.

## Renovación autorizada del histórico

Estos comandos son de operación, no forman parte del despliegue. Ejecutar desde `api/`, con su `.env` real y una autorización explícita para borrar los resultados anteriores y procesar los casos seleccionados.

1. Consultar sin modificar: `npm run eval:reset`.
2. Revisar el total y comprobar que no haya ejecuciones en curso.
3. Limpiar usando el total revisado: `npm run eval:reset -- --apply --expected-evaluations TOTAL`.
4. Completar o reanudar: `npm run eval:all -- --execute`.

La limpieza toma el bloqueo de aplicación, crea un respaldo privado en `.data/backups/`, verifica SHA-256 y elimina solo entidades de evaluación y revisiones asociadas. Conserva Atom, usuarios, sesiones, catálogo y versiones. Pausa el horario y marca el mantenimiento para impedir lotes ordinarios mientras se renueva el histórico.

El primer inicio fija los IDs de las conversaciones en `.data/backfills/`. Se procesan lotes de 20 con hasta tres solicitudes simultáneas. El avance se comprueba contra las huellas guardadas en MySQL. Un reinicio retoma los pendientes sin limpiar nuevamente. Se realizan hasta tres pasadas por ejecución; los fallos persistentes quedan identificados. Conservar el manifiesto y el respaldo fuera del repositorio, con permisos privados.

Al terminar todos los IDs fijados, se retira el mantenimiento y se reactiva el horario conservado. Nuevos registros que lleguen después de fijar la lista los toma el proceso diario. Si queda algún caso pendiente, el mantenimiento sigue activo hasta resolverlo y reanudar el mismo comando.

**Nunca repetir la limpieza para reanudar un lote.** No iniciar dos procesos `eval:all` simultáneamente. El bloqueo de lotes impide dos ejecuciones en curso, pero el manifiesto es un archivo local de un único operador.

## Recuperación

`npm run eval:reset -- --restore /ruta/respaldo.json` valida la copia y muestra su contenido en forma de conteos. Añadir `--apply` restaura únicamente si las tablas de evaluación están vacías, la base coincide y el checksum es correcto. Nunca sobrescribe resultados nuevos. La copia contiene evidencia y auditoría privadas: no adjuntarla a GitHub ni imprimirla en logs.

## Despliegue y verificación

El código debe llegar al servidor para que la programación incluya abiertas y actualizaciones. Guardar los indicadores en la base no modifica por sí solo un servidor que siga ejecutando una versión anterior. El workflow de despliegue instala y reinicia API/web; no ejecuta estos comandos ni modifica el esquema.

Validación de esta entrega: 46 pruebas de API, 8 pruebas web y compilación de producción bajo `/pulsoAtom`. Incluye casos de nuevos mensajes, cierre, importación idéntica, cambios durante IA, mantenimiento, horario y concurrencia. La etiqueta provisional se comprobó visualmente en un caso sintético identificado como DEMO.
