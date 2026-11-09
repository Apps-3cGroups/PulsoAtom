# QA: configuración de Clef y Gemma

Validación del 6 de noviembre de 2026. Datos sintéticos, HTTP local y Gateway simulado; ninguna escritura en bases reales ni llamada a modelos reales.

## Checklist QA

### 1. Flujo, navegación y mantenimiento

- Estado: cumple
  Criticidad: crítica
  Hallazgo: Evaluaciones → Herramientas internas muestra los dos perfiles y permite consultar sus herramientas/modelos, editarlos, habilitarlos, inactivarlos y guardar en la misma pantalla.
  Evidencia: `web/src/components/LocalModelConfiguration.jsx`; nueve verificaciones de navegador.
  Comportamiento esperado: mantener dos perfiles fijos, Clef y Gemma, con estado guardado diferenciado del borrador.
  Recomendación: conservar ese alcance. Agregar/eliminar perfiles arbitrarios no aplica a esta configuración de dos motores.

### 2. Formularios, botones y persistencia

- Estado: cumple
  Criticidad: crítica
  Hallazgo: herramientas/modelos se obtienen del Gateway; campos obligatorios y modelos duplicados se validan. Guardar revalida disponibilidad y versión, guarda auditoría y política dual, y pausa el diario sin ejecutar IA. La respuesta corresponde a datos persistidos.
  Evidencia: `api/test/local-model-configuration.test.js`, `web/test/local-models.test.js`; flujo de navegador de guardar/inactivar/recargar.
  Comportamiento esperado: ausencia de falsos éxitos o sobrescrituras concurrentes.
  Recomendación: mantener el control de versión y reconciliación por GET si se pierde la respuesta de guardado.

### 3. Estados de carga, errores y consistencia

- Estado: cumple
  Criticidad: media
  Hallazgo: error del Gateway visible; conflicto 409 conserva el borrador y permite recarga explícita. Descartar restaura los valores guardados. Apagar un perfil sin cambiar su configuración funciona incluso sin credenciales; activar/editar requiere validación del Gateway. Demo indica su limitación sin consultar el servicio real.
  Evidencia: QA de navegador, seis pruebas web nuevas y pruebas HTTP de desactivación/errores.
  Comportamiento esperado: informar qué está guardado y qué falta, sin confundir configuración con inferencia probada.
  Recomendación: conservar el texto «Catálogo por consultar» tras recargar. No se requieren modales adicionales para esta edición inline.

### 4. Permisos, secretos y ejecución

- Estado: cumple
  Criticidad: crítica
  Hallazgo: todas las rutas administrativas requieren sesión y rol administrador. URL/token permanecen en backend. Entornos con claves y perfiles públicos antiguos solo registran Clef/Gemma. API, scheduler y CLI leen la configuración persistida. Cambiarla durante la creación/reanudación de un trabajo rechaza la operación antes de llamar a IA.
  Evidencia: pruebas de configuración, registry, runtime y piloto; `policyAvailable` rechaza dos perfiles que apuntan al mismo modelo.
  Comportamiento esperado: no ejecutar proveedores públicos ni mezclar configuraciones en un trabajo.
  Recomendación: usar el piloto delimitado para validar inferencia real. El comando heredado de renovación masiva rechaza políticas duales, pues su control de progreso no garantiza ambas revisiones.

### 5. Histórico y compatibilidad

- Estado: cumple
  Criticidad: crítica
  Hallazgo: las nuevas opciones de ejecución excluyen GPT/Luna y Gemini. Sus evaluaciones, revisiones y nombres históricos se preservan. Una política antigua queda pendiente; no se sustituye silenciosamente ni provoca llamadas automáticas.
  Evidencia: pruebas de exclusión pública, hash histórico, scheduler y cinco conversaciones sintéticas con diez tareas.
  Comportamiento esperado: separar resultados guardados de selección de motores futuros.
  Recomendación: realizar limpieza respaldada solo mediante el procedimiento explícito del piloto, nunca durante el despliegue.

### 6. Presentación, copy y accesibilidad

- Estado: cumple
  Criticidad: media
  Hallazgo: tema claro, jerarquía y controles consistentes con el portal. Campos etiquetados, estados visibles y ausencia de desbordamiento horizontal en 1366×768, 1440×900 y 1920×1080.
  Evidencia: capturas y verificaciones de Playwright, formulario probado por controles accesibles, compilación web.
  Comportamiento esperado: que la configuración se encuentre antes de política/comparaciones y no muestre IDs públicos crudos como selección vigente.
  Recomendación: mantener las credenciales fuera del formulario. Paginación/búsqueda de registros no aplica a los dos perfiles fijos; los modelos sí se pueden buscar en el selector.

### 7. Regresión: selectores de modelos bloqueados

- Estado: cumple
  Criticidad: crítica
  Hallazgo: se reprodujo que Consultar Gateway cargaba herramientas, pero no modelos de herramientas ya guardadas. Se corrigió la carga automática al abrir, cambiar herramienta y actualizar el catálogo. Las respuestas antiguas se descartan y no se modifica el borrador por una consulta.
  Evidencia: `web/test/gateway-discovery.test.js` (seis regresiones); prueba nativa de navegador con herramientas y modelos sintéticos. Se abrió y seleccionó cada modelo sin pulsar una consulta adicional, se actualizó conservando la selección y se probó una herramienta sin modelos seguida de Descartar cambios.
  Comportamiento esperado: ambos selectores disponibles cuando existen modelos; explicación y reintento si faltan, sin ejecutar IA ni guardar automáticamente.
  Recomendación: desplegar la corrección web. La versión anterior permite consultar modelos con los botones específicos debajo de cada selector como alternativa temporal.

Validación de esta corrección: 62 pruebas web, compilación correcta y 32 pruebas de contrato/API relacionadas sin fallos. Gateway y datos sintéticos; no se modificó configuración real ni se ejecutaron evaluaciones. La prueba de navegador no guardó el borrador.

## Resumen ejecutivo

198 pruebas de API y 56 de web correctas; compilación web correcta. Nueve verificaciones de navegador, cero llamadas a proveedores y cero escrituras en bases reales. `git diff --check` sin errores.

## Hallazgos críticos

Ninguno confirmado en el alcance probado. Se corrigió la disponibilidad engañosa de una política dual cuyos dos perfiles apuntaban al mismo ID de modelo.

## Riesgos funcionales

Estado: revisar. La disponibilidad real del Gateway, permisos del portal, IDs efectivos y soporte de salida estructurada requieren validación en el servidor. Descubrir y guardar el catálogo no prueba la calidad ni el formato de una respuesta de inferencia.

## Desviaciones visuales

Ninguna confirmada contra el estilo vigente del portal. No se modificó Resumen ni su distribución.

## Recomendaciones prioritarias antes de liberar a producción

Fusionar/desplegar la API y web juntas. Con la conexión del Gateway ya configurada, seleccionar y guardar Clef/Gemma en Modelos locales. Mantener el diario pausado y completar el piloto respaldado de cinco conversaciones antes de ampliar el procesamiento. La limpieza y la evaluación real no se realizaron durante esta entrega.
