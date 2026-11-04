# Checklist QA · catálogo v5

## Flujo, navegación y acciones

- Estado: cumple. Criticidad: crítica. Catálogo conserva agregar, editar, activar/inactivar, selección por lotes y listado en la misma pantalla. API y prueba de navegador verifican persistencia; las acciones de supervisor permanecen restringidas. Evidencia: `api/test/portal.test.js`, `web/src/pages/Catalog.jsx` y prueba local con base demo aislada.
- Estado: cumple. Criticidad: media. Resumen abre Conversación directamente y el filtro de ambos modelos devuelve la misma variable coincidente. Rutas mantienen `/pulsoAtom`, recarga y período inicial de siete días. Evidencia: pruebas de rutas web, `api/test/catalog-presentation.test.js` y navegación de navegador.

## Formularios, estado y consistencia

- Estado: cumple. Criticidad: crítica. La disponibilidad se distingue de habilitación; fase 2/3 y reglas sin implementación no pueden activarse ni desde API ni desde interfaz. Las tres dependencias pendientes de fase 1 no bloquean el resto. Evidencia: pruebas de catálogo y `web/test/catalog-availability.test.js`.
- Estado: cumple. Criticidad: crítica. Cambios de definición y estado crean versiones; conflictos de edición no sobreescriben resultados históricos. Migración repetida no duplica snapshots. Evidencia: `api/test/catalog-v5.test.js` y `api/test/portal.test.js`.
- Estado: cumple. Criticidad: media. Métricas y descriptores no tienen marcas de alerta. Positivos admiten refutación conservando la respuesta del modelo y excluyendo el resultado de conteos vigentes. Evidencia: `api/test/catalog-presentation.test.js` y prueba de refutación positiva en demo.

## Tablas, carga, mensajes y modales

- Estado: cumple. Criticidad: media. Tablas mantienen cabeceras, filtros, paginación y animación Pulso. Nuevos contadores usan plurales y etiquetas crítico/normal/positivo. Evidencia: vistas web, pruebas `flags-v5` y capturas locales.
- Estado: cumple. Criticidad: crítica. Fallos técnicos y resultados incompletos se muestran como pendientes; valores ausentes no se representan como cero ni como ausencia de flags. Evidencia: pruebas del motor y de presentación.
- Estado: cumple. Criticidad: media. Modal de revisión de modelos conserva ambas columnas, justificación y evidencia; los positivos usan la identificación verde. El modal de refutación guarda el motivo y refleja el estado resultante. Evidencia: prueba de navegador en demo.

## Diseño y robustez

- Estado: cumple. Criticidad: media. Resumen y Activas no tienen scroll exterior en 1366×768, 1440×900 y 1920×1080. Métricas se muestran solo al principio de Conversación. No hay desbordamiento horizontal de documento ni errores JavaScript en la navegación comprobada.
- Estado: cumple. Criticidad: crítica. Código, cálculos, perfiles repetidos y reintentos no suman votos. La comparación exige contenido y versiones equivalentes. Evidencia: pruebas multi-model y evaluator-v5.
- Estado: revisar. Criticidad: media. La migración contra MySQL real y el resultado de los proveedores sobre una muestra real v5 no forman parte de estas pruebas. El comportamiento se verificó con almacenes y proveedores simulados. Recomendación: comprobar una muestra explícita después del despliegue y verificar los resultados persistidos.

## Resumen ejecutivo

Pruebas locales aprobadas: 107 API y 31 web; compilación aprobada. Se conservaron el estilo y las rutas existentes. Los datos de prueba son sintéticos y permanecen separados del entorno real.

## Hallazgos críticos

No quedan hallazgos críticos confirmados en el alcance comprobado. Se corrigió la activación de integraciones no implementadas y la presentación de resultados parciales como si fueran completos.

## Riesgos funcionales

Faltan horarios por país, identidad de agente por mensaje y eventos de botones. Las variables afectadas quedan pendientes explícitamente. Los flags que necesitan integraciones de fases posteriores permanecen inactivos.

## Desviaciones visuales

No se detectó desbordamiento exterior en las vistas de monitoreo. Conversación usa scroll vertical para conservar transcripción y checklist junto al minidashboard.

## Recomendaciones prioritarias antes de liberar a producción

Desplegar API y web de la misma revisión. Verificar la migración al arrancar y la programación existente. No ejecutar una reevaluación masiva como prueba de instalación; utilizar una muestra real delimitada cuando se solicite.
