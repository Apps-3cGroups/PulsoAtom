# Monitor temporal de Clef

Página independiente React/Ant Design para `/pulsoAtom/monitor-clef/index.html`.
Usa la sesión administrativa existente y solo consulta API del mismo origen.
No inicia evaluaciones ni cambia la política. El endpoint existente de
evaluaciones puede marcar trabajos inactivos como interrumpidos según su regla
de recuperación. El monitor no reanuda trabajos.

Desde `web/`, con sus dependencias instaladas:

```sh
node --test monitor/test/*.test.js
npx vite build --config monitor/vite.config.js
node monitor/write-artifact.js
```

El resultado autocontenido se genera en `web/temporary-clef/`. El instalador
verifica `artifact.json` antes de copiarlo a `web/dist/monitor-clef/`. No requiere
reiniciar los servicios ni volver a compilar la aplicación principal. Una
compilación posterior del portal elimina esta pantalla temporal.

Actualización cada 30 segundos, sin consultas concurrentes superpuestas; máximo
dos solicitudes de detalle a la vez. Los bloques que no cambian usan caché.
Solo se cuentan tareas Clef del cohorte fijo de 500. Gemma y reintentos no inflan
los totales. No se conserva contenido de conversaciones ni respuestas de IA en
el estado del monitor.

La pantalla indica la fecha de la última lectura y la última actividad guardada.
No verifica el PID del worker, no fabrica una hora de término y no afirma que un
fallo parcial sea ausencia de flags. Una consulta fallida conserva la última
lectura, identificada como desactualizada. La actualización automática termina
cuando todos los casos y bloques son terminales o cuando la sesión deja de ser
válida. El botón de actualización permite volver a consultar tras iniciar sesión.
