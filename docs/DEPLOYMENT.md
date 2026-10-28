# Despliegue de PulsoAtom en Server 214

El despliegue inicial publica `https://apps.3c.group/pulsoAtom/` desde `/var/www/nodeapps/PulsoAtom`, con PM2 bajo el usuario `td` y `PM2_HOME=/home/td/.pm2`.

## Antes de fusionar el workflow

1. Crear un runner **del repositorio Apps-3cGroups/PulsoAtom**, Windows x64, con las etiquetas predeterminadas `self-hosted`, `Windows` y `X64`. Nombre sugerido: `PulsoAtom`.
2. Instalarlo como servicio y confirmar que GitHub lo muestre Online. El equipo debe alcanzar `10.252.1.214:22` y tener `ssh`, `scp` e `icacls`.
3. Mantener los secrets del repositorio `TD_APPS_SSH_KEY` y `GH_DEPLOY_TOKEN`. El token es la contraseña de HTTPS Basic Auth para `jjosegarcia`; no se usa Bearer ni se cambia `origin`.
4. Confirmar que los `.env` reales existen en `api/.env` y `web/.env`, propiedad `td:td`, modo `600`. No se suben a Git ni se reemplazan durante el workflow.

El PR del workflow debe permanecer abierto hasta completar el runner. El workflow se activa con pushes a `main` o manualmente; no se ejecuta por abrir el PR.

## Proceso automático

- Valida secrets y herramientas del runner.
- Ejecuta SSH como `ubuntu` y las operaciones del proyecto como `td`.
- Exige un checkout limpio y existente en `main`, hace `git pull --ff-only origin main`, comprueba que HEAD coincida con el main obtenido y conserva los `.env` sin cambiar `origin`.
- Instala dependencias con `npm ci --ignore-scripts`, compila la web y actualiza únicamente los dos procesos del ecosystem de PulsoAtom.
- Comprueba salud de API y web por loopback antes de finalizar.
- Limpia temporales locales y remotos incluso si falla una transferencia previa; informa si la conexión impide retirar la credencial remota.
- No ejecuta SQL, migraciones, seeds ni scripts de evaluación, ni modifica Apache o la configuración del entorno.

API: `127.0.0.1:4001/pulsoAtom/api/health`. Web: `127.0.0.1:3000/pulsoAtom/`. Apache conserva el prefijo `/pulsoAtom` al reenviar al servidor web.
