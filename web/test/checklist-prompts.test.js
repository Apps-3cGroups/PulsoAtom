import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { catalogItemPrompt, itemPromptDraft, changeItemPromptMode, itemPromptMaxLength } from '../src/services/checklistPrompts.js';

const item = { id: 'flag', name: 'Flag de prueba', type: 'Flag', definition: 'Detecta el evento documentado.', condition: 'Solo con evidencia visible.' };

test('legacy additions are shown together with base criteria and become replacements only when edited', () => {
  const saved = { mode: 'shared', shared: 'Indicación adicional guardada' };
  const draft = itemPromptDraft(item, saved);
  assert.ok(draft.shared.includes(item.definition) && draft.shared.includes(item.condition));
  assert.ok(draft.shared.includes(saved.shared));
  assert.equal(draft.application, 'replace');
  assert.deepEqual(saved, { mode: 'shared', shared: 'Indicación adicional guardada' });
  const replacement = itemPromptDraft(item, { application: 'replace', mode: 'shared', shared: 'Solo el criterio personalizado' });
  assert.equal(replacement.shared, 'Solo el criterio personalizado');
  assert.equal(itemPromptDraft(item, { mode: 'shared', shared: catalogItemPrompt(item) }).shared, catalogItemPrompt(item));
});

test('every AI checklist item starts with its actual definition and condition without truncation', async () => {
  const catalog = JSON.parse(await readFile(new URL('../../api/src/data/catalog.json', import.meta.url), 'utf8'));
  const items = catalog.filter(v => ['IA', 'IA + código'].includes(v.method) && !v.retired);
  assert.ok(items.length > 40);
  for (const variable of items) {
    const text = catalogItemPrompt(variable);
    assert.ok(text.includes(variable.definition), variable.id);
    assert.ok(text.includes(variable.condition || 'Sin condición adicional.'), variable.id);
    assert.ok(text.length <= itemPromptMaxLength, variable.id);
  }
  const longest = catalogItemPrompt({ ...item, definition: 'D'.repeat(5000), condition: 'C'.repeat(5000) });
  assert.ok(longest.includes('D'.repeat(5000)) && longest.includes('C'.repeat(5000)));
  assert.ok(longest.length <= itemPromptMaxLength);
  const legacy = itemPromptDraft({ ...item, definition: 'D'.repeat(5000), condition: 'C'.repeat(5000) },
    { mode: 'shared', shared: 'A'.repeat(12000) });
  assert.ok(legacy.shared.includes('D'.repeat(5000)) && legacy.shared.includes('C'.repeat(5000)) && legacy.shared.includes('A'.repeat(12000)));
  assert.ok(legacy.shared.length <= itemPromptMaxLength, 'The complete previous criterion and additions must remain editable without truncation');
});

test('mode changes prefill empty fields while preserving model-specific drafts', () => {
  let value = itemPromptDraft(item, { mode: 'inherit', shared: '', byModel: { 'clef-local': '', 'gemma-local': '' } });
  value = changeItemPromptMode(item, value, 'shared');
  assert.equal(value.shared, catalogItemPrompt(item));
  value.shared = 'Instrucciones personalizadas compartidas';
  value = changeItemPromptMode(item, value, 'per-model');
  assert.deepEqual(Object.values(value.byModel), [value.shared, value.shared]);
  value.byModel['clef-local'] = 'Instrucciones exclusivas de Clef';
  const before = structuredClone(value);
  const inherited = changeItemPromptMode(item, value, 'inherit');
  const restored = changeItemPromptMode(item, inherited, 'per-model');
  assert.deepEqual(restored, before);
  assert.deepEqual(value, before);
  assert.equal(itemPromptDraft(item, { ...value, mode: 'shared', shared: '' }).shared, '', 'Clearing an active field must not restore text on every keystroke');
});
