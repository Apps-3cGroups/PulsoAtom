# Activas: tablero histórico por país

Ruta: `/pulsoAtom/activas` (respeta el prefijo configurado del portal).

Disponible para administradores y supervisores. Reutiliza `/summary` con país y fechas y presenta la evaluación operativa, incluyendo las revisiones humanas existentes. No ejecuta IA ni cambia la selección de la evaluación oficial.

- Un país seleccionado y una tarjeta por ID de asistente, con todas sus conversaciones del período.
- Período inicial: siete días calendario inclusivos terminando en la fecha máxima cargada, igual que Resumen. Alternativas: último día, 14 y 30 días.
- Incluye abiertas y cerradas; es una consulta histórica, no un indicador de presencia en vivo. No muestra cronómetros de actividad.
- Cliente, fecha, ID, nombres de flags y prioridad. Refutaciones identificadas y excluidas del conteo de flags vigentes. Sin Coaching ni adjuntos.
- Las pendientes se distinguen de las evaluadas sin flags visibles. El contenido modificado conserva su aviso de evaluación pendiente.
- Flags críticos primero, luego otros flags, pendientes y evaluadas sin flags. Se conserva la navegación directa a Conversación.
- Seis asistentes por página; listas internas desplazables sin truncar conversaciones. El país y período se conservan en la URL.

Validación: 23 pruebas web, compilación Vite, recarga de ruta, cambio de país/período y apertura directa del detalle. Verificación de distribución en 1366×768, 1440×900, 1920×1080 y 390×844 usando exclusivamente datos sintéticos. Captura: `pulso-activas-demo.png`.

Este cambio parte de `codex/dashboard-navigation-week` (PR #9); integrar ese PR antes de este. Sin migraciones, despliegues ni evaluaciones reales.
