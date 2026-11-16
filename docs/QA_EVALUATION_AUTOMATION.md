# Checklist QA

Fecha: 2026-11-16. Base: `origin/main` en `e60ad32`. Rama aislada: `codex/configuracion-automatizacion-paises`.

Evidencia ejecutada: **629 pruebas de API y 128 de web aprobadas**, compilación Vite correcta y revisión del navegador en `/pulsoAtom/configuracion/evaluaciones`. Pruebas de cola en `api/test/automation.test.js`; API administrativa y metadatos Atom en `api/test/automation-routes.test.js`; contratos locales en las pruebas de Gateway y Clef nativo. Las pruebas de servidores locales se ejecutaron fuera de la restricción de escucha del sandbox.

## 1. Flujo completo

- Estado: cumple
  Criticidad: critica
  Hallazgo: se puede entrar desde la navegación administrativa, configurar un país, editar prompts por modelo e ítem, guardar, recargar y consultar el historial.
  Evidencia: navegador de demostración, versiones 2 a 6; `EvaluationConfiguration.jsx`; configuración del ítem «Queja sobre el servicio» persistida tras recarga.
  Comportamiento esperado: un único flujo administrativo con persistencia y salida a Evaluaciones.
  Recomendacion: conservar las comprobaciones al incorporar nuevos controles.

## 2. Botones y acciones

- Estado: cumple
  Criticidad: critica
  Hallazgo: guardar, descartar, volver y restaurar tienen acciones concretas; pausa y reanudación se validan en API. Guardar impide un segundo envío mientras espera respuesta.
  Evidencia: guardado y restauración observados; pruebas de pausa global/país, permisos y conflictos de versión.
  Comportamiento esperado: cada acción actualiza el estado sin perder trabajos.
  Recomendacion: durante el piloto confirmar la reanudación de un trabajo real detenido.

## 3. Links y navegación

- Estado: cumple
  Criticidad: media
  Hallazgo: la ruta administrativa conserva `/pulsoAtom` y ofrece regreso a Evaluaciones.
  Evidencia: URL observada en navegador; `routes.jsx`, `App.jsx`; pruebas web de recarga, proxy y ruta base alternativa.
  Comportamiento esperado: no redirigir al sitio raíz ni perder el prefijo.
  Recomendacion: repetir el smoke test tras desplegar detrás del proxy de destino.

## 4. Catálogos y mantenimientos

- Estado: cumple
  Criticidad: critica
  Hallazgo: listado, edición, habilitación e inhabilitación conviven en la tabla. Las altas de países proceden automáticamente de Atom y empiezan deshabilitadas. No existe alta manual local por esa regla de negocio. Los ítems se administran en el catálogo existente; aquí se editan sus prompts.
  Evidencia: tabla de países, editor por ítem y sincronización versionada en `automation-scheduler.js`.
  Comportamiento esperado: conservar el catálogo de origen y las configuraciones sin datos temporales.
  Recomendacion: validar la primera aparición de un país nuevo en el entorno real.

## 5. Formularios

- Estado: cumple
  Criticidad: critica
  Hallazgo: validación de cupos, orden sin modelos duplicados, zona horaria, concurrencia, tiempos, prompts vacíos y pertenencia de ítems. Conflictos 409 no sobrescriben la revisión de otro administrador.
  Evidencia: pruebas API y de configuración; validación Zod estricta; edición y recarga observadas en navegador.
  Comportamiento esperado: guardar una revisión completa o no guardar ningún cambio.
  Recomendacion: mantener los textos del borrador ante fallos de conexión.

## 6. Ortografía, redacción y tildes

- Estado: cumple
  Criticidad: menor
  Hallazgo: interfaz en español con nombres de modos, estado provisional, fuera de muestra y advertencias de borrador.
  Evidencia: pantalla observada y componentes de configuración.
  Comportamiento esperado: explicar el efecto de los controles sin exponer credenciales ni detalles de transporte.
  Recomendacion: mantener «ítem», «país» y «evaluación» de forma consistente.

## 7. Estados de carga, espera y feedback

- Estado: cumple
  Criticidad: media
  Hallazgo: hay carga inicial, errores, confirmación de guardado, cambios pendientes y verificación de un guardado cuyo resultado se desconoce.
  Evidencia: éxito visible al guardar; `mutate`, `verify`, `ErrorState`, `LoadingState`; monitor vacío visible.
  Comportamiento esperado: evitar reenvíos ambiguos y distinguir falta de detección de cero resultados.
  Recomendacion: probar un corte de red durante el guardado en staging; la rama de respuesta incierta tiene revisión de código, no simulación de navegador.

## 8. Revisión visual y alineación

- Estado: cumple
  Criticidad: media
  Hallazgo: se conservan componentes Ant Design y tipografía del portal. Se corrigió el desbordamiento horizontal de la página a 390 px; el desplazamiento queda dentro de las tablas.
  Evidencia: capturas `evaluation-automation/prompts-por-item.jpg` y `evaluation-automation/listado-movil.jpg`; ancho de documento 375 px con viewport de 390 px.
  Comportamiento esperado: editor legible y controles alcanzables en escritorio y móvil.
  Recomendacion: validación parcial frente al diseño: no se proporcionó mockup externo. Completar dispositivos reales durante el piloto.

## 9. Tablas y listados

- Estado: cumple
  Criticidad: media
  Hallazgo: países e ítems tienen búsqueda, paginación, estado y acción por fila. El monitor distingue disponibles, seleccionadas, cupo, pendientes por modelo y fuera de muestra.
  Evidencia: navegador; pruebas de cupos distintos, país deshabilitado, llegadas parciales y repetidas.
  Comportamiento esperado: no presentar el excedente como trabajo pendiente.
  Recomendacion: medir el rendimiento con el volumen de producción.

## 10. Modales y paneles

- Estado: cumple
  Criticidad: media
  Hallazgo: el editor de ítem abre, cierra y conserva cambios en el borrador; explica que debe guardarse la configuración. La vista previa no invoca modelos.
  Evidencia: edición y recarga observadas; prueba API verifica que la vista previa no crea evaluaciones y que restaurar conserva el historial por ítem.
  Comportamiento esperado: no perder textos al cerrar el panel ni inferir durante una vista previa.
  Recomendacion: conservar el botón de regreso y el aviso del borrador.

## 11. Consistencia funcional

- Estado: cumple
  Criticidad: critica
  Hallazgo: ambos modelos comparten IDs y respetan concurrencia y barreras, también al agotar reintentos. Se conservan resultados/variables completados, prompts congelados y cupos al cambiar de jornada o contenido.
  Evidencia: 20 pruebas de automatización; contratos chat/nativo por ítem; prueba de rechazo de consenso ante huella alterada; integración de comparación y dashboard.
  Comportamiento esperado: ninguna mezcla de versiones ni duplicación de resultado persistido.
  Recomendacion: ejecutar el piloto sintético contra ambos modelos locales.

## 12. Robustez general

- Estado: cumple
  Criticidad: critica
  Hallazgo: detecciones concurrentes, latidos vencidos y respuestas tardías no duplican resultados; una versión de catálogo ausente queda como fallo atendible. Se trasladan tareas diarias seleccionadas anteriores sin repetir el modelo completado.
  Evidencia: pruebas de concurrencia, sustitución de trabajador, transición y revisión por cambio de conexión; alertas sin duplicados y ausencia de lotes vacíos.
  Comportamiento esperado: recuperación duradera con adquisición atómica.
  Recomendacion: monitorizar latencia del bloqueo global y tamaños de lotes en MySQL real.

- Estado: revisar
  Criticidad: critica
  Hallazgo: no se ejecutó la migración sobre un MySQL de destino ni el piloto real del Gateway; la copia aislada carece de conexión y credencial del Gateway.
  Evidencia: `node api/scripts/pilot-evaluation-automation.js` devuelve `GATEWAY_CONFIGURATION_REQUIRED`, sin modificaciones de base.
  Comportamiento esperado: migración aditiva verificada y cuatro revisiones sintéticas completas por modo antes de activar la entrega.
  Recomendacion: aplicar el procedimiento de `EVALUATION_AUTOMATION.md` en staging; no considerar aprobada la puesta en producción con solo estas pruebas locales.

## 13. Estándares adicionales

- Estado: cumple
  Criticidad: critica
  Hallazgo: controles restringidos a administradores; API devuelve 401/403 a accesos no autorizados. Historial registra versión, autor y restauración. Las acciones reversibles de pausa no eliminan asignaciones ni resultados.
  Evidencia: pruebas API, guardado versionado y controles del frontend.
  Comportamiento esperado: cambios administrativos trazables y credenciales solo en backend.
  Recomendacion: verificar permisos del usuario administrador de staging y auditar el primer cambio real.

## Resumen ejecutivo

Implementación y validación local completas: 757 pruebas aprobadas y build correcto. Prompts configurables por cada ítem, compartidos o distintos por modelo, con persistencia comprobada en navegador.

## Hallazgos críticos

No hay fallos críticos confirmados en las pruebas locales. Siguen pendientes de verificación la migración MySQL, el piloto con modelos locales reales y la activación controlada con una única instancia del planificador.

## Riesgos funcionales

- Un reinicio puede repetir una solicitud al Gateway sin idempotencia; el resultado persistido queda protegido.
- Deben medirse el bloqueo global existente y la carga de transcripciones seleccionadas con cupos elevados.
- Un cambio de conexión que altera la identidad del modelo requiere reanudar explícitamente para crear una nueva pareja compatible.

## Desviaciones visuales

Corregidos el desbordamiento móvil y el aviso deprecado de `InputNumber` introducido por los controles de unidades. Sin errores nuevos de navegador tras la recarga final. El build mantiene el aviso de tamaño del bundle compartido ya existente.

## Recomendaciones prioritarias antes de liberar a producción

1. Aplicar y verificar la migración aditiva antes de iniciar la API nueva; conservar respaldo e histórico.
2. Ejecutar el piloto sintético en los tres modos con GatewayAgents real.
3. Confirmar una única instancia del planificador y revisar trabajos extraordinarios pendientes.
4. Guardar la configuración pausada, revisar cupos y prompts por ítem, y activar durante una jornada controlada.
