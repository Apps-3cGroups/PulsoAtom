# Dashboard y Activas

El dashboard conserva Hoy, 3 días y 30 días. Los países múltiples se guardan en `countries=HN,PA`; `country=HN` sigue siendo compatible. Las figuras se guardan en `figures`; ausencia significa todas y una cadena vacía significa ninguna. Las métricas corresponden al mismo conjunto de conversaciones que el mapa. `normal` permanece como valor interno y se presenta como Menor.

El resumen oculta por defecto las conversaciones sin evaluar o pendientes de una revisión de modelo. «Mostrar pendientes», a la derecha de las figuras, las incluye y conserva la selección con `pending=1` al recargar o volver del detalle. Las evaluaciones con incidencias siguen visibles. El filtro se aplica sobre los datos recibidos, sin otra consulta; mapa y métricas usan el mismo conjunto.

`GET /active` devuelve `items`, `total`, `metrics`, `pending`, `page`, `pageSize` y `runs`. La selección habitual incluye ABIERTO, REASIGNADO y REINGRESO sin cierre. Cada tarjeta incluye `activeReason`; la fuente nunca se modifica.

## Corrida excepcional

Actualización del 12/11/2026: la solicitud vigente sustituye la ejecución de las 10:30 por la continuación completa del jueves. Al preparar `settings.thursdayHandoff`, la entrada excepcional queda `superseded` y no puede ejecutarse por el scheduler ni por una solicitud directa. Se conserva su regla de vigencia en Activas. El alcance se determina por actividad del jueves en HN/PA, sin cupo; espera que termine la recuperación del martes/miércoles y las 00:01 del viernes. La descripción siguiente documenta la programación original de la migración, ya sustituida al preparar la continuación.

La migración 003 agrega `settings.oneOffEvaluations` sin cambiar la programación diaria. Viernes 13/11/2026, desde 10:30 America/Tegucigalpa (16:30 UTC), HN y PA, Clef y Gemma, 200 conversaciones por país, concurrencia 2. La selección se realiza por lotes de ingesta iniciados ese viernes, no por fechas de mensajes. Se requiere carga LISTO en ambos países y se espera cualquier lote relevante incompleto. Los lotes sin país determinado bloquean la selección hasta poder identificarlos.

El scheduler respeta mantenimiento y trabajos en curso, congela IDs de conversación/documento/lote en el trabajo y en configuración y utiliza una clave de idempotencia fija. Reanuda tareas inconclusas tras un reinicio. Una modificación incompatible de fuente/modelo/checklist queda visible como bloqueo y no se fuerza la reanudación.

Todas las conversaciones listas de las cargas del viernes se consideran vigentes durante esa jornada, incluidas las no seleccionadas por el límite. La excepción termina el 14/11/2026 a las 00:00 Honduras (06:00 UTC). Una ejecución iniciada puede continuar después; una no iniciada vence sin ejecutarse tarde.

La carga de datos es responsabilidad del importador existente. No se cambia ni se ejecuta ese importador.

## Validación

Pruebas unitarias y de rutas cubren filtros, métricas, país único/múltiple, paginación, estados de origen, vencimiento, espera, límite, idempotencia y reanudación. Validación final: 423 pruebas API, 98 pruebas web y compilación correctas. La revisión directa en navegador del 11/11/2026 utilizó 3066 conversaciones sintéticas, 37 asesores y un grupo de alta densidad. Se comprobaron Hoy, 3 días y 30 días; HN + PA y limpieza de países; figuras, métricas y estado vacío; regreso desde detalle conservando filtros y página; Activas con 12 tarjetas; y tamaños de 1440 × 900, 1230 × 954 y 390 × 844. El compacto ajusta la altura usando sus encabezados reales y reduce controles en móvil para evitar solapar los nombres.
