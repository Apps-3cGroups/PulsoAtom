const path = require('node:path').posix;

const DEPLOY_ROOT = '/var/www/nodeapps';
const PROJECT_FOLDER = 'PulsoAtom';

module.exports = {
  apps: [
    {
      name: 'pulso-atom-api',
      cwd: path.join(DEPLOY_ROOT, PROJECT_FOLDER, 'api'),
      script: 'server.js',
      env: { PORT: 4001 },
    },
    {
      name: 'pulso-atom-web',
      cwd: path.join(DEPLOY_ROOT, PROJECT_FOLDER, 'web'),
      script: 'server.js',
      env: { PORT: 3000 },
    },
  ],
};
