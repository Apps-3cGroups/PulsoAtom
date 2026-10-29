# QA — Resultados oficiales y herramientas internas

## Checklist QA

### Flujo completo, navegación y permisos

- Estado: cumple. Criticidad: critica.
  Hallazgo: Resumen, Histórico, Búsqueda y Conversación consultan un único resultado oficial. El parámetro antiguo de modelo se elimina de la URL.
  Evidencia: componentes operativos sin selector; navegador verifica normalización del enlace y ausencia de controles de modelos.
  Comportamiento esperado: mantener el mismo resultado y los dictámenes humanos en todo el recorrido habitual.
  Recomendación: conservar esta separación al incorporar nuevos proveedores.

- Estado: cumple. Criticidad: critica.
  Hallazgo: perfiles, comparaciones, candidatos e intentos requieren administrador en API; las rutas internas redirigen al Resumen para supervisores.
  Evidencia: prueba `supervisión consulta el resultado oficial y revisa, pero no accede a herramientas de modelos`; recorrido de ambos roles en navegador.
  Comportamiento esperado: la restricción debe existir también al abrir una URL o invocar la API directamente.
  Recomendación: mantener las pruebas de autorización en futuras extensiones.

### Botones, acciones y consistencia funcional

- Estado: cumple. Criticidad: media.
  Hallazgo: Evaluaciones abre en la ejecución habitual; Herramientas internas contiene configuración y acceso al laboratorio. La ida y vuelta del laboratorio conserva esa pestaña.
  Evidencia: navegación realizada con los controles de interfaz; historial operativo separado del historial comparativo.
  Comportamiento esperado: la experimentación no debe ocupar la pantalla de resultados ni reemplazar la evaluación oficial.
  Recomendación: usar la pestaña interna como punto de entrada del equipo administrador.

### Formularios, revisiones y feedback

- Estado: cumple. Criticidad: critica.
  Hallazgo: el supervisor mantiene refutaciones y revisión de conversaciones; el enlace de validación humana no consulta predicciones comparativas ni muestra enlaces al laboratorio.
  Evidencia: pruebas de revisión existentes aprobadas; apertura del checklist de validación como supervisor y regreso al Resumen comprobados.
  Comportamiento esperado: revisar evidencia y guardar dictámenes sin acceder a herramientas de modelos.
  Recomendación: continuar enviando el enlace de validación de la conversación cuando se solicite revisión a ciegas.

### Diseño, texto, tablas y estados de carga

- Estado: cumple. Criticidad: media.
  Hallazgo: el mapa y las métricas conservan protagonismo, sin selector ni nombres de modelos en el Resumen y la vista rápida. El detalle conserva el aviso cuando cambió el contenido de Atom.
  Evidencia: captura `pulso-resultados-demo.png`; documento y viewport coinciden a 1366×768, 1440×900 y 1920×1080; animación Pulso visible durante la carga.
  Comportamiento esperado: la pantalla principal no tiene desplazamiento exterior; la tabla utiliza su área interna.
  Recomendación: mantener esos tamaños como referencia visual.

### Catálogos y modales

- Estado: cumple. Criticidad: menor.
  Hallazgo: no se alteraron el CRUD del catálogo ni los formularios de refutación. La revisión específica de altas, edición y activación no aplica a este ajuste de navegación.
  Evidencia: diff limitado a separación de vistas y permisos; las pruebas existentes del catálogo y de revisiones siguen aprobadas.
  Comportamiento esperado: preservar el mantenimiento y la evidencia de revisiones.
  Recomendación: no trasladar estas acciones al laboratorio de modelos.

### Robustez y arquitectura

- Estado: cumple. Criticidad: critica.
  Hallazgo: 62 pruebas API y 8 web aprobadas. Se eliminó el componente del selector y sus estilos sin uso. Web y API siguen separadas, con prefijo configurable.
  Evidencia: `npm test` en ambas carpetas y build local exitoso; las pruebas cubren acceso directo, resultado oficial y revisión humana.
  Comportamiento esperado: no exponer herramientas administrativas por consultas alternativas ni perder la ruta base.
  Recomendación: publicar esta corrección junto con el PR de modelos, antes de presentar el portal.

## Resumen ejecutivo

El portal presenta un resultado oficial y concentra los controles de modelos en administración. El ajuste no cambia evaluaciones, políticas de ejecución ni dictámenes guardados, y no inicia nuevas llamadas a proveedores.

## Hallazgos críticos

No quedaron hallazgos críticos confirmados en el alcance del ajuste. Los endpoints internos rechazan el rol supervisor y las revisiones humanas permanecen disponibles.

## Riesgos funcionales

La configuración real de Gemini y la infraestructura local siguen pendientes según la entrega anterior. La validación a ciegas de un supervisor se abre mediante el enlace a una conversación, sin incluir acceso a la comparación.

## Desviaciones visuales

No se detectó desplazamiento exterior del Resumen en los tres tamaños comprobados. La advertencia de tamaño del bundle continúa documentada en el QA general.

## Recomendaciones prioritarias antes de liberar a producción

Confirmar la migración 002 en la base del servidor y presentar primero el Resumen. El laboratorio se reserva para el trabajo interno del administrador. No se requiere otra migración para este ajuste.
