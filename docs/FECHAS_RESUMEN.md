# Fechas del Resumen

El Resumen se organiza por la última actividad registrada en Atom. Un chat iniciado el 30 de octubre que recibe actividad el 4 de noviembre aparece una sola vez, en el 4 de noviembre. Esto no divide el chat en atenciones ni modifica sus evaluaciones.

En modo real, el Resumen tiene un desfase de un día: sus períodos terminan **ayer según la hora de Honduras (`America/Tegucigalpa`)**. No incluyen el día en curso ni se anclan a la fecha máxima cargada. El período inicial es **3 días**; también están disponibles **Ayer** y **30 días**, todos inclusivos y con el mismo corte.

Por ejemplo, el viernes 13 de noviembre de 2026, la vista de 3 días presenta **jueves 12, miércoles 11 y martes 10**, de izquierda a derecha. Ayer muestra solo el jueves 12 y 30 días abarca del 14 de octubre al 12 de noviembre. El corte cambia a medianoche en Honduras, independientemente de la zona horaria del navegador. La demo conserva como corte su último día sintético válido para mantener sus datos estables.

La selección se guarda en `days=1`, `days=3` o `days=30`; los valores antiguos no admitidos vuelven a 3 días. Los países (`countries`) y las excepciones (`figures`) se conservan al cambiar el período, recargar y regresar desde Conversación. Los parámetros antiguos `from` y `to` no cambian el corte de los períodos del Resumen.

El mapa mensual presenta sus 30 días en una ventana y rotula el extremo más reciente con su fecha real. Las consultas y los enlaces a Histórico utilizan el mismo rango visible. Se conserva el desplazamiento interno del mapa.

## API y compatibilidad

- `dateBasis=activity` usa `FechaUltimaActividadUtc`, convertida a la fecha local del portal. Si no existe, usa el último mensaje con fecha válida y, por último, el inicio. Nunca se usa la fecha de ingesta para ubicar el chat.
- Sin `dateBasis`, las consultas conservan el comportamiento actual de main: última actividad. `dateBasis=started` permite consultar explícitamente por inicio.
- `date` conserva la fecha de actividad; `startedDate` y `startedAt` conservan el inicio. `displayDate` y `displayAt` indican las fechas del criterio consultado.
- Bootstrap expone `activityDateRange` separado de `dateRange`.
- El enlace desde un país del mapa a Histórico conserva `dateBasis=activity`, y la tabla identifica la columna «Última actividad».
- Consultar un rango no ejecuta IA ni cambia resultados. La huella de contenido evaluado no cambia por estos campos de presentación.

## Comprobación

La validación de la integración con main tras el PR #28 figura en [QA_PR27_INTEGRACION.md](QA_PR27_INTEGRACION.md). Las pruebas utilizan datos sintéticos, sin llamar a los modelos ni modificar evaluaciones reales.

Pruebas de API: inicio en octubre con actividad en noviembre, cambio de día por zona horaria, fecha de ingesta distinta, fallback sin actividad, orden y filtros compatibles, y consultas sin ejecutar IA.

Pruebas web: tres días hasta ayer, ausencia del día en curso en todos los períodos, medianoche de Honduras, cruces de mes/año y año bisiesto, independencia de la zona del navegador, fecha máxima antigua o futura, demo estable, etiquetas Ayer y fecha real del mapa mensual, filtros y retorno desde detalle.

El desfase del 13/11/2026 cambia únicamente las fechas consultadas y los textos de la web. No requiere cambios de API, reinicios de evaluadores, migraciones ni reevaluar conversaciones.
