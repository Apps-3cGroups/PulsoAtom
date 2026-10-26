import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { databaseConfig } from '../src/config.js';
import { MysqlStore } from '../src/store.js';
import { hashPassword } from '../src/auth.js';

if (!process.stdin.isTTY) throw new Error('Ejecuta este comando en una terminal interactiva.');
const options = databaseConfig();
if (!options) throw new Error('Configura APP_DB_* en api/.env.');
let muted = false;
const output = new Writable({ write(chunk, _encoding, callback) { if (!muted) process.stdout.write(chunk); callback(); } });
const prompt = readline.createInterface({ input: process.stdin, output, terminal: true });
const store = new MysqlStore(options);
try {
  const name = z.string().trim().min(2).max(100).parse(await prompt.question('Nombre: '));
  const email = z.string().email().max(254).parse((await prompt.question('Correo: ')).trim().toLowerCase());
  const role = z.enum(['admin', 'supervisor']).parse((await prompt.question('Rol (admin / supervisor): ')).trim());
  process.stdout.write('Contraseña (mínimo 12 caracteres, entrada oculta): '); muted = true;
  const password = await prompt.question(''); muted = false; process.stdout.write('\n');
  z.string().min(12).max(200).parse(password);
  process.stdout.write('Repite la contraseña: '); muted = true;
  const confirmation = await prompt.question(''); muted = false; process.stdout.write('\n');
  if (password !== confirmation) throw new Error('Las contraseñas no coinciden.');
  await store.transaction(state => {
    if (state.users.some(u => u.email.toLowerCase() === email)) throw new Error('Ya existe una cuenta con ese correo.');
    state.users.push({ id: randomUUID(), name, email, role, active: true, passwordHash: hashPassword(password), createdAt: new Date().toISOString() });
  });
  console.log('Cuenta creada.');
} finally { muted = false; prompt.close(); await store.close(); }
