import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export const CATALOG_REVISION = 'v5-2026-11-03';
export const catalogV5 = JSON.parse(readFileSync(new URL('./data/catalog.json', import.meta.url), 'utf8'));
export const catalogNotesV5 = JSON.parse(readFileSync(new URL('./data/catalog-v5-notes.json', import.meta.url), 'utf8'));
const instructionTopics = new Set(['Cliente', 'Asistente', 'Petición', 'Resuelta', 'Cuando una variable dice "pregunta"', 'Permitidos', 'Cantidad', 'Cuándo', 'Nunca', 'Evaluación']);
export const CATALOG_RULES_INSTRUCTIONS = catalogNotesV5.filter(n => instructionTopics.has(n.topic)).map(n => `${n.topic}: ${n.text}`).join('\n');

/** Upgrade only the current catalog. Historical snapshots and evaluation references are immutable. */
export function migrateCatalogV5(state, { now = new Date().toISOString() } = {}) {
  state.metadata ||= {};
  if (state.metadata.catalogRevision === CATALOG_REVISION) return false;
  state.catalog ||= [];
  state.catalogVersions ||= [];
  state.catalogAudit ||= [];
  const old = new Map(state.catalog.map(item => [item.id, item]));
  const currentIds = new Set(catalogV5.map(item => item.id));
  const actor = 'Migración del catálogo v5';
  const snapshot = item => {
    if (!state.catalogVersions.some(v => v.id === `${item.id}:${item.version}`)) {
      state.catalogVersions.push({ id: `${item.id}:${item.version}`, itemId: item.id, version: item.version, snapshot: structuredClone(item), actor, createdAt: now });
    }
  };
  // A manually edited current record may not yet have a historical snapshot.
  for (const item of state.catalog) snapshot(item);
  const nextVersion = id => Math.max(0, old.get(id)?.version || 0, ...state.catalogVersions.filter(v => v.itemId === id).map(v => v.version)) + 1;
  const save = (item, action) => {
    snapshot(item);
    state.catalogAudit.push({ id: randomUUID(), itemId: item.id, version: item.version, action, authorId: 'catalog-v5-migration', authorName: actor, createdAt: now });
    return item;
  };
  const current = catalogV5.map(definition => save({ ...structuredClone(definition), version: nextVersion(definition.id) }, old.has(definition.id) ? 'importar_v5' : 'crear_v5'));
  // Keep retired records persisted: MysqlStore intentionally does not delete catalog rows.
  const retired = state.catalog.filter(item => !currentIds.has(item.id)).map(item => item.retired && !item.active ? item : save({ ...item, retired: true, active: false, version: nextVersion(item.id) }, 'retirar_v5'));
  state.catalog = [...current, ...retired];
  state.metadata.catalogRevision = CATALOG_REVISION;
  return true;
}
