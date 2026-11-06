# Operación de evaluaciones

## Flujo diario

La configuración reside en `portal_settings`, sin credenciales. `includeOpenConversations=true` incluye abiertas y cerradas; `refreshChangedConversations=true` detecta contenido nuevo mediante una huella SHA-256. Las abiertas son provisionales. El cierre modifica la huella aunque no haya mensajes nuevos.

El horario de esta instalación es 07:00, `America/Tegucigalpa`. Se conserva al renovar el histórico. La API debe permanecer encendida, con acceso al origen, a la base propia y al proveedor de IA. La programación ejecuta como máximo 100 casos por día; el portal permite lotes manuales de 20. El excedente queda pendiente. Los casos sin texto evaluable no se convierten en evaluaciones vacías.

Una importación idéntica no genera llamadas nuevas. Los fallos y las conversaciones modificadas durante la evaluación quedan pendientes. Se permite un reintento por fallo transitorio o respuesta inválida. Las versiones anteriores se conservan durante actualizaciones ordinarias. La evaluación vigente usa el contenido más reciente que se pudo evaluar; el portal avisa si Atom vuelve a cambiarlo.

Evaluar el 100% de conversaciones no significa que todas las variables tengan una conclusión: «No evaluado» conserva la falta de contexto y no equivale a cero. No se infiere contenido multimedia.

## Renovación autorizada del histórico

Estos comandos son de operación, no forman parte del despliegue. Ejecutar desde `api/`, con su `.env` real y una autorización explícita para borrar los resultados anteriores y procesar los casos seleccionados.

La renovación actual admite únicamente `gemma-local`, con política `single`, sin secundario ni respaldo. La programación diaria debe estar pausada. Clef se añadirá cuando su servicio esté disponible; no se invoca durante esta renovación.

1. Comprobar Gemma sin datos reales: `node scripts/check-gemma-contract.js`. Lee el checklist/configuración de Pulso y envía una conversación sintética; máximo dos solicitudes, sin guardar evaluaciones. Deben pasar el contrato y los tres casos conocidos. Esto no sustituye una revisión de calidad sobre casos reales.
2. Configurar Gemma como único modelo y mantener pausado el diario. Consultar sin modificar: `npm run eval:all -- --plan` y `npm run eval:reset`.
3. Revisar el universo, el total de evaluaciones y que no haya tareas en curso.
4. Iniciar usando `node scripts/start-gemma-renewal.js --start --from INICIO --to FIN --limit 20 --expected-evaluations TOTAL --expected-policy-version VERSION --expected-configuration-hash HASH_MODELO --expected-catalog-hash HASH_CATALOGO --expected-prompt-hash HASH_INSTRUCCIONES`, con los valores revisados. Este comando fija la selección, respalda y limpia los resultados anteriores, verifica la copia y lanza el trabajador. Conservar el `maintenanceId` y la ruta del respaldo devueltos.
5. El primer lote queda limitado a la muestra explícita. El trabajador exige su manifiesto: si falta, se detiene; nunca crea un universo más amplio.
6. Consultar avance sin modificar: `npm run eval:all -- --status --maintenance-id UUID`.
7. Continuar las conversaciones pendientes: `npm run eval:all -- --execute --maintenance-id UUID --resume`. Se puede conservar `--max-batches N` para limitar cada ventana operativa.

La limpieza toma el bloqueo de aplicación, crea un respaldo privado en `.data/backups/`, sincroniza sus archivos a disco, verifica SHA-256 y elimina solo entidades de evaluación y revisiones asociadas. Conserva Atom, usuarios, sesiones, catálogo y versiones. Pausa el horario y marca el mantenimiento para impedir lotes ordinarios mientras se renueva el histórico.

El primer inicio fija conversaciones abiertas y cerradas, documentos de origen, huellas de contenido, checklist, instrucciones, reglas y perfil del modelo en `.data/backfills/UUID.json`. No copia transcripciones. Procesa primero las conversaciones de actividad más reciente y conserva todo el universo: usa actualización o inicio cuando falta una fecha de actividad válida, y desempata por ID descendente. Procesa lotes de 20, una conversación a la vez. Solo una tarea completa con resultado válido y equivalente cuenta como terminada; una respuesta parcial no lo hace. Las abstenciones legítimas se conservan sin transformarlas en ceros.

La reanudación conserva las tareas e IDs de ejecución y permite hasta tres rondas por tarea, cada una con el reintento limitado del evaluador. Los fallos persistentes o contenidos modificados permanecen identificados como pendientes. Un cambio de modelo, política, checklist o instrucciones detiene el proceso. Conservar manifiesto y respaldo fuera del repositorio, con permisos privados.

Al terminar todos los IDs fijados, se retira el mantenimiento y **la programación diaria sigue pausada**. Los registros nuevos posteriores al manifiesto no entran en esta renovación. Si queda algún caso pendiente, el mantenimiento continúa hasta resolverlo y reanudar el mismo comando.

**Nunca repetir la limpieza para reanudar un lote.** No iniciar dos procesos `eval:all` simultáneamente. El archivo `.lock` impide dos operadores sobre el mismo manifiesto. Si el proceso termina abruptamente, comprobar que su PID ya no existe antes de retirar manualmente ese bloqueo; no se elimina por antigüedad.

## Flags y segunda revisión

Los resultados originales de Gemma y las métricas quedan consultables en el detalle. Los flags automáticos permanecen ocultos mientras falte la coincidencia de un segundo modelo independiente. Ni una abstención ni un resultado calculado por código aportan un voto de IA.

La incorporación posterior de Clef requiere una ejecución explícita que vincule sus resultados con los de Gemma sobre el mismo contenido, versión de variable e instrucciones. El cambio de política por sí solo no completa las tareas de un lote individual anterior. Si Atom modifica el contenido, no se puede atribuir acuerdo con la evaluación antigua: hará falta evaluar el contenido nuevo.

## Operación desde GitHub Actions

El workflow existente tiene un selector explícito. `gemma-inspect` consulta conteos y política; `gemma-preflight` ejecuta únicamente la prueba sintética. Ninguna de esas opciones modifica evaluaciones. Sus archivos temporales y credenciales se eliminan al terminar.

`gemma-prepare` guarda Gemma individual y mantiene el diario pausado, usando la versión de política revisada. `gemma-start` requiere el conteo de evaluaciones, la nueva versión de política y las huellas de configuración, catálogo e instrucciones obtenidas en la comprobación. Comprueba otra vez esos valores bajo bloqueo, fija el universo antes de limpiar, verifica el respaldo y lanza un trabajador independiente de la conexión SSH. El workflow no espera que terminen todas las conversaciones. `gemma-status` consulta el avance usando el UUID del mantenimiento, sin ejecutar IA.

Las tres operaciones sobre producción exigen que el commit desplegado coincida con el seleccionado al ejecutar el workflow. La opción `deploy` conserva su función de despliegue y nunca inicia por sí sola una limpieza o renovación.

Los archivos `UUID.operation.json` y `UUID.log` se guardan con permisos privados junto al manifiesto. Un proceso detenido se recupera de forma explícita con `eval:all --execute --resume`; nunca volviendo a seleccionar `gemma-start`. Consultar el checkpoint y las tareas actuales por separado: el checkpoint se actualiza al cerrar un lote y puede ir detrás de las conversaciones ya terminadas dentro de ese lote.

## Recuperación

`npm run eval:reset -- --restore /ruta/respaldo.json` valida la copia y muestra su contenido en forma de conteos. Añadir `--apply` restaura únicamente si las tablas de evaluación están vacías, la base coincide y el checksum es correcto. Nunca sobrescribe resultados nuevos. La copia contiene evidencia y auditoría privadas: no adjuntarla a GitHub ni imprimirla en logs.

## Despliegue y verificación

El código debe llegar al servidor para que la programación incluya abiertas y actualizaciones. Guardar los indicadores en la base no modifica por sí solo un servidor que siga ejecutando una versión anterior. El workflow de despliegue instala y reinicia API/web; no ejecuta estos comandos ni modifica el esquema.

Validación de esta entrega: 46 pruebas de API, 8 pruebas web y compilación de producción bajo `/pulsoAtom`. Incluye casos de nuevos mensajes, cierre, importación idéntica, cambios durante IA, mantenimiento, horario y concurrencia. La etiqueta provisional se comprobó visualmente en un caso sintético identificado como DEMO.
