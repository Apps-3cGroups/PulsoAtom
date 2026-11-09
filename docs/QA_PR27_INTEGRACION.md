# QA de integración del PR #27

Fecha: 9 de noviembre de 2026. Base: `main` en `d8b0830`, que incorpora el PR #28. Alcance: resolver conflictos y conservar el dashboard de modelos y calendario del PR #27 junto con las evaluaciones duales, configuración local y conversación centrada en mensajes de main.

## Validación ejecutada

| Comprobación | Resultado y evidencia |
| --- | --- |
| API completa | `cd api && npm test`: 398 pruebas aprobadas, ninguna omitida ni fallida. |
| Web completa | `cd web && npm test`: 96 pruebas aprobadas, ninguna omitida ni fallida. |
| Compilación | `cd web && npm run build`: aprobada. Vite conserva aviso de un chunk principal mayor de 500 kB. |
| Conflictos | Sin marcadores de conflicto; `git diff --check` limpio. |
| Dashboard sintético | Cuatro pares comparables; tres con tiempos de ambos. Una tarea fallida conserva su denominador sin convertirse en una respuesta negativa. |
| Filtros del dashboard | Últimos siete días de demostración; Honduras reduce cuatro pares a dos. Restablecer recupera todos los países y mantiene los mismos perfiles. |
| Recarga de rutas | `/pulsoAtom/modelos` carga tras recargar. El Resumen conserva `from=2026-10-22&to=2026-10-25` en URL, calendario y encabezado al recargar. |
| Navegación | Una conversación del mapa abre su detalle directamente. El menú Conversación abre Histórico. Se conserva la conversación con flags por mensaje incorporada en main. |
| Estado de evaluaciones | Pruebas de finalización, abstención, disponibilidad y procedencia nativa aprobadas; el mapa mantiene Sin evaluar, Falta modelo e Incidencias diferenciados. |
| Complemento histórico | Regresión específica valida el enlace Gemma/Clef explícito, excluye laboratorio genérico y acepta protocolo chat implícito en instantáneas antiguas. |
| Fechas | Pruebas de actividad en noviembre con inicio en octubre, zona horaria, timestamps ISO/SQL, último mensaje e inicio como alternativas, sin usar ingesta. |
| Visual | Navegador local con viewport disponible de 1064 × 891: dashboard legible en dos columnas; Resumen con desplazamiento interno del mapa. Sin errores de consola en el recorrido. |

## Regresiones corregidas durante la integración

- Histórico mantiene última actividad por defecto; inicio solo se usa cuando se solicita `dateBasis=started`.
- El dashboard abre siete días en vez de consultar todo el histórico inicialmente.
- Se muestra cobertura de evaluación, sin presentarla como exactitud del modelo.
- Un complemento histórico validado no se descarta por estar almacenado en un job separado ni por omitir el protocolo chat predeterminado.

## Límites y entrega

- Vista previa y pruebas con datos sintéticos locales; sin llamadas a IA, cambios de política, escrituras en bases reales ni despliegues.
- La inspección visual de esta integración se hizo en el viewport disponible; no se afirma una nueva verificación visual en 1366 × 768, 1440 × 900 y 1920 × 1080.
- La comprobación contra las evaluaciones reales queda para el despliegue. Los tiempos sintéticos no son un benchmark de Clef/Gemma.
- API y web deben desplegarse juntas. No requiere migración ni reevaluación del histórico.
