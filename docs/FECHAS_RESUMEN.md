# Fechas del Resumen

El Resumen se organiza por la última actividad registrada en Atom. Un chat iniciado el 30 de octubre que recibe actividad el 4 de noviembre aparece una sola vez, en el 4 de noviembre. Esto no divide el chat en atenciones ni modifica sus evaluaciones.

Antes, el período se anclaba al mayor día de inicio obtenido al abrir el portal. Eso podía dejar el Resumen en octubre aunque hubiera actividad en noviembre. Ahora, en modo real, los botones consultan días calendario hasta hoy en la zona horaria del portal; el valor inicial es siete días inclusivos. La demo mantiene sus fechas sintéticas.

El calendario permite seleccionar un rango propio, incluso entre meses o años. Limpiarlo restablece siete días. El rango queda en la URL y se conserva al recargar o regresar desde Conversación. País, variable, clasificación y doble detección se combinan con ese período.

En períodos de más de 31 días, los indicadores abarcan el rango completo y el mapa muestra hasta 31 columnas a la vez, con navegación a los días anteriores y siguientes. Se conserva el desplazamiento interno del mapa, sin añadir scroll exterior al Resumen.

## API y compatibilidad

- `dateBasis=activity` usa `FechaUltimaActividadUtc`, convertida a la fecha local del portal. Si no existe, usa el inicio. Nunca se usa la fecha de ingesta para ubicar el chat.
- Sin `dateBasis`, las consultas conservan el criterio histórico de inicio (`started`).
- `date` y `startedAt` permanecen intactos; `displayDate` y `displayAt` indican las fechas del criterio consultado.
- Bootstrap expone `activityDateRange` separado de `dateRange`.
- El enlace desde un país del mapa a Histórico conserva `dateBasis=activity`, y la tabla identifica la columna «Última actividad».
- Consultar un rango no ejecuta IA ni cambia resultados. La huella de contenido evaluado no cambia por estos campos de presentación.

## Comprobación

Resultado local: 112 pruebas de API y 41 de web aprobadas; compilación aprobada. La prueba de navegador confirmó selección del 1 al 4 de noviembre, recarga, navegación a Histórico y Conversación, restablecimiento a siete días, rango de 65 días y recuperación desde un período vacío, sin errores JavaScript.

Pruebas de API: inicio en octubre con actividad en noviembre, cambio de día por zona horaria, fecha de ingesta distinta, fallback sin actividad, orden y filtros compatibles, y consultas sin ejecutar IA.

Pruebas web: rangos inclusivos, cruces de mes/año, hoy frente a una fecha antigua de bootstrap, demo, fechas inválidas, un solo día y ventanas de 31 columnas para períodos largos. La prueba de navegador utiliza únicamente datos sintéticos y comprueba el calendario, recarga, navegación y distribución en 1366×768, 1440×900 y 1920×1080.

API y web deben desplegarse juntas. No se necesita migración de base de datos ni reevaluar conversaciones.
