# QA — Progreso estable de evaluaciones

Fecha: 29 de octubre de 2026. Alcance: corrección puntual sobre `origin/main` para el parpadeo observado en la grabación de la versión publicada.

## Causa y cambio

`Evaluations` reemplazaba todo el contenido por `LoadingState` cada vez que `useApi` marcaba una consulta como cargando. El intervalo de tres segundos repetía ese ciclo durante un lote y desmontaba el formulario de programación. La tabla también activaba su cargador en cada consulta.

La carga inicial conserva la animación Pulso. Cuando ya hay datos, la pantalla y la tabla siguen visibles. El siguiente sondeo se programa tres segundos después de completar el anterior; una respuesta lenta no se cancela para iniciar otra. Al finalizar el lote cesa el sondeo. Un error conserva los datos visibles y ofrece una consulta manual, sin iniciar evaluaciones. El botón de inicio permanece deshabilitado mientras se obtiene el estado posterior al POST para evitar un segundo clic durante esa espera.

## Validación

- Se reprodujo el fallo antes del cambio usando la compilación de `origin/main` y un servidor sintético en localhost: al iniciar el lote, desaparecieron las tarjetas y apareció el cargador de pantalla completa.
- Después del cambio se probaron respuestas de 4,5 segundos, superiores al intervalo anterior. Las dos tarjetas permanecieron montadas, no apareció el cargador y el lote llegó a 20/20.
- Un cambio de zona horaria sin guardar permaneció en el formulario después de las consultas y al terminar el lote.
- La instrumentación de la prueba registró como máximo una consulta simultánea y cero cancelaciones. El contador de consultas quedó estable al finalizar.
- Ocho pruebas web aprobadas. Builds correctos con `/pulso` y `/pulsoAtom`. Continúa la advertencia existente sobre el tamaño del bundle principal.
- Sin cambios en API, base de datos, horario real ni contratos de evaluación. Las pruebas no enviaron conversaciones a proveedores de IA.

## Publicación

El arreglo debe fusionarse en `main` y completar el despliegue existente para verse en `apps.3c.group`. No requiere migraciones ni configuración adicional. La grabación corresponde al portal publicado; una corrección local por sí sola no cambia ese servidor.
