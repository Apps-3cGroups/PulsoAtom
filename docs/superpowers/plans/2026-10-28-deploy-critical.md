# PulsoAtom: correcciones críticas de despliegue

> Ejecución en esta sesión siguiendo superpowers:executing-plans y test-driven-development.

**Objetivo:** corregir exclusivamente la subruta fija y la ausencia de PM2 señaladas en el informe aprobado por el usuario.

**Diseño:** usar `/pulsoAtom`, subruta indicada expresamente por el usuario, y hacer configurables el montaje API, las cookies, Vite, el Router y ambos clientes HTTP. Mantener las aplicaciones independientes y sus puertos actuales como valores de ejemplo. Añadir un ecosystem raíz con dos procesos y solo `PORT` dentro de cada `env`.

**Tecnologías:** React, Vite, Express, Node.js >=20.19.0, PM2.

**Referencia:** informe de auditoría de esta conversación y AGENTS.md de SAF.

## Restricciones

- Cambios locales en PulsoAtom; sin despliegue, push, SQL ni migraciones.
- No corregir los problemas medios: temas, rendimiento del histórico y QA funcional.
- Mantener compatibilidad con API_PORT, WEB_PORT y API_TARGET existentes.
- Subruta aprobada: `/pulsoAtom`, respetando mayúsculas. Se puede cambiar desde los archivos .env; `/` no debe publicar el portal.
- Las pruebas y el build locales fueron autorizados expresamente por el usuario.

## Comprobaciones principales

- Subruta alternativa de varios segmentos, con normalización de barra final.
- Login y logout con cookies limitadas a la subruta elegida.
- Proxy de API conserva el prefijo y las rutas internas se pueden recargar.
- Router, recursos y clientes HTTP usan las mismas variables al compilar.
- PM2 resuelve los dos directorios y cada proceso respeta PORT.

## Tareas

- [x] Añadir pruebas de regresión de API/cookies, servidor web/Vite y configuración PM2; comprobar que fallan por los bloqueos encontrados. Base previa: API 35/35 y web 4/4. Regresiones nuevas: 4 fallos de API y 3 de web antes de corregir.
- [x] Parametrizar rutas y puertos, conservando las variables anteriores como respaldo y usando `/pulsoAtom` como subruta solicitada.
- [x] Añadir ecosystem.config.js y ejemplos mínimos de configuración y arranque.
- [x] Ejecutar suites API/web y build con una subruta alternativa; revisar el diff y el alcance final.

## Evidencia de ejecución

- Suites completas después del cambio: API 39/39 y web 7/7.
- Build de `/pulsoAtom` y de `/operacion/pulsoAtom`: correctos.
- Revisión independiente de código: sin hallazgos bloqueantes en los críticos corregidos.
- Observación diferida: el proxy de desarrollo Vite conserva la coincidencia amplia de prefijos que ya tenía. Producción delimita `/api`; no se amplía este cambio para corregir problemas medios.
- Browser plugin no disponible; comprobación funcional local con Playwright empaquetado, datos demo temporales y sin conexiones reales a BD o IA.
- Navegador: login, histórico, catálogo, recarga, recuperación de ruta inexistente y logout correctos en `/pulsoAtom` y `/operacion/pulsoAtom`; cookies y recursos bajo el prefijo correcto, sin errores de aplicación ni respuestas HTTP inesperadas.
- La comprobación de retorno al inicio acepta ambas formas válidas de la URL, con y sin barra final; React Router conserva el basename en las dos.
- No se modificaron temas, consultas del histórico ni QA funcional anterior. No se ejecutaron SQL, migraciones ni despliegues.
