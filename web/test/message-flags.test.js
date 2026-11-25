import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMessageFlags, evidenceMessageLookup, filterMessageRows, groupFlagOptions } from '../src/services/messageFlags.js';

const message = (id, text = 'Mensaje sintético') => ({ id, text });
const evidence = messageId => ({ messageId, quote: 'Cita sintética' });
const positive = ids => ({ status: 'evaluado', value: 1, evidence: ids.map(evidence) });
const flag = (id, classification = 'normal', ids = []) => ({ id, name: `Flag ${id}`, type: 'Flag', classification,
  kind: classification, order: 1, result: positive(ids) });

test('published agreement links both models’ real evidence IDs once, excluding errors, abstentions and guessed text', () => {
  const variable = flag('repeat', 'normal', ['one', 'one']);
  variable.result.comparison = { cells: [
    { status: 'completed', result: positive(['one', 'two', 'two', 'absent']) },
    { status: 'completed', result: { status: 'no_evaluado', value: null, evidence: [evidence('three')] } },
    { status: 'failed', result: positive(['three']) },
    { status: 'completed', error: { code: 'AI_TRANSIENT' }, result: positive(['three']) },
    { status: 'completed', result: { ...positive(['three']), error: { code: 'INVALID_AI_RESULT' } } },
    { status: 'running', result: positive(['three']) },
  ] };
  const conversation = { messages: [message('one'), message('two'), message('three', 'Cita sintética')], variables: [variable] };
  const original = structuredClone(conversation);
  const index = buildMessageFlags(conversation);
  assert.deepEqual([...index.byMessage.keys()], ['one', 'two']);
  assert.deepEqual(index.byMessage.get('two'), [variable]);
  assert.equal(index.byMessage.get('one').length, 1);
  assert.deepEqual(index.unlinkedVariables, []);
  assert.deepEqual(conversation, original);
});

test('human evidence overrides AI evidence; refutations retain the original messages and classification', () => {
  const human = { ...flag('human', 'critical', ['ai']), kind: 'human', origin: 'human',
    review: { action: 'levantar', evidence: evidence('person'), mode: 'blind', outcome: 'present' } };
  human.result.comparison = { cells: [{ result: positive(['ai']), status: 'completed' }] };
  const refuted = { ...flag('refuted', 'positive', ['ai']), kind: 'refuted', effective: false,
    review: { action: 'refutar', evidence: null } };
  const index = buildMessageFlags({ messages: [message('ai'), message('person')], variables: [human, refuted] });
  assert.deepEqual(index.byMessage.get('person'), [human]);
  assert.deepEqual(index.byMessage.get('ai'), [refuted]);
  assert.deepEqual(filterMessageRows([message('ai'), message('person')], index, { classification: 'human' }).map(row => row.message.id), ['person']);
  assert.deepEqual(filterMessageRows([message('ai'), message('person')], index, { classification: 'refuted' }).map(row => row.message.id), ['ai']);
});

test('metrics, descriptors and suppressed single-model detections never become message marks', () => {
  const suppressed = { ...flag('single', 'normal', ['m']), kind: null, consensusSuppressed: true };
  const metric = { ...flag('duration', 'normal', ['m']), type: 'Métrica' };
  const descriptor = { ...flag('products', 'normal', ['m']), type: 'Descriptor' };
  const visible = flag('published', 'normal', ['m']);
  const index = buildMessageFlags({ messages: [message('m')], variables: [suppressed, metric, descriptor, visible, visible] });
  assert.deepEqual(index.markedVariables, [visible]);
  assert.deepEqual(index.byMessage.get('m'), [visible]);
  assert.deepEqual(buildMessageFlags(), { byMessage: new Map(), markedVariables: [], unlinkedVariables: [] });
});

test('source changes and missing evidence stay accessible as unlinked flags rather than attaching to new content', () => {
  const linked = flag('linked', 'critical', ['same-id']);
  const missing = flag('missing', 'normal', ['gone']);
  const empty = flag('empty', 'positive');
  const conversation = { messages: [message('same-id')], variables: [linked, missing, empty] };
  assert.deepEqual(buildMessageFlags(conversation).unlinkedVariables, [missing, empty]);
  for (const changed of [{ sourceChanged: true }, { evaluation: { sourceChanged: true } }]) {
    const index = buildMessageFlags({ ...conversation, ...changed });
    assert.equal(index.byMessage.size, 0);
    assert.deepEqual(index.unlinkedVariables, [linked, missing, empty]);
    assert.equal(filterMessageRows(conversation.messages, index, { onlyMarked: true }).length, 0);
  }
});

test('combined filters match the same flag while each returned message retains all its marks and source order', () => {
  const messages = [message('unmarked'), message('shared'), message('normal-only')];
  const critical = flag('critical', 'critical', ['shared']);
  const normal = flag('normal', 'normal', ['shared', 'normal-only']);
  const index = buildMessageFlags({ messages, variables: [normal, critical] });
  assert.deepEqual(filterMessageRows(messages, index).map(row => row.message.id), ['unmarked', 'shared', 'normal-only']);
  assert.deepEqual(filterMessageRows(messages, index, { onlyMarked: true }).map(row => row.message.id), ['shared', 'normal-only']);
  const rows = filterMessageRows(messages, index, { variableId: 'normal', classification: 'normal' });
  assert.deepEqual(rows.map(row => row.message.id), ['shared', 'normal-only']);
  assert.deepEqual(rows[0].flags, [critical, normal]);
  assert.equal(filterMessageRows(messages, index, { variableId: 'normal', classification: 'critical' }).length, 0);
  assert.equal(filterMessageRows(messages, index, { variableId: 'unknown' }).length, 0);
  assert.deepEqual(filterMessageRows(messages, index.byMessage, { classification: 'critical' }).map(row => row.message.id), ['shared']);
});

test('grouped options retain severity for human marks, separate refuted marks, and do not mutate inputs', () => {
  const human = { ...flag('human', 'critical', [0]), kind: 'human' };
  const normal = flag('normal', 'normal');
  const plus = flag('plus', 'positive');
  const refuted = { ...flag('refuted', 'critical'), kind: 'refuted' };
  const variables = [refuted, plus, normal, human, { ...flag('hidden'), kind: null }];
  const original = structuredClone(variables);
  assert.deepEqual(groupFlagOptions(variables), [
    { label: 'Flag crítico', options: [{ value: 'human', label: 'Flag human' }] },
    { label: 'Flag menor', options: [{ value: 'normal', label: 'Flag normal' }] },
    { label: '+ Positivo', options: [{ value: 'plus', label: 'Flag plus' }] },
    { label: 'Refutados', options: [{ value: 'refuted', label: 'Flag refuted' }] },
  ]);
  assert.deepEqual(variables, original);
  assert.deepEqual(groupFlagOptions(), []);
  const index = buildMessageFlags({ messages: [message('0')], variables: [human] });
  assert.deepEqual(index.byMessage.get('0'), [human]);
});


test('restored historical flags stay unlinked when the original citation does not match current text', () => {
  const variable = { ...flag('old', 'critical', ['same-id']), kind: null, effective: false, dualDetected: false,
    historicalAutomaticFlagVisible: true, historicalKind: 'critical' };
  const conversation = { sourceChanged: true, historicalFlagsAvailable: true,
    messages: [message('same-id', 'Contenido actualizado')], variables: [variable] };
  const original = structuredClone(conversation);
  const index = buildMessageFlags(conversation);
  assert.equal(index.markedVariables.length, 1);
  assert.equal(index.markedVariables[0].historical, true);
  assert.equal(index.markedVariables[0].kind, 'critical');
  assert.equal(index.markedVariables[0].effective, false);
  assert.equal(index.markedVariables[0].dualDetected, false);
  assert.equal(index.byMessage.size, 0);
  assert.equal(index.unlinkedVariables.length, 1);
  assert.equal(buildMessageFlags({ ...conversation, historicalFlagsAvailable: false }).markedVariables.length, 0);
  assert.equal(buildMessageFlags({ ...conversation, sourceChanged: false }).markedVariables.length, 0);
  assert.deepEqual(conversation, original);
});

test('historical flags link unchanged original evidence after timestamp or actor corrections without changing provenance', () => {
  const variable = { ...flag('saved', 'critical', ['one', 'two']), kind: null, effective: false, dualDetected: false,
    historicalAutomaticFlagVisible: true, historicalKind: 'critical' };
  variable.result.evidence = [{ messageId: 'one', quote: 'Texto original completo.' }];
  variable.result.comparison = { cells: [
    { status: 'completed', result: { status: 'evaluado', value: 1, evidence: [{ messageId: 'two', quote: 'Segundo texto completo.' }] } },
    { status: 'failed', result: { status: 'evaluado', value: 1, evidence: [{ messageId: 'three', quote: 'Otro texto.' }] } },
  ] };
  const conversation = { sourceChanged: true, historicalFlagsAvailable: true,
    messages: [{ ...message('one', 'Texto original completo.'), actor: 'humano', timestamp: '2026-11-18T18:00:00Z' },
      message('two', 'Segundo texto completo.'), message('three', 'Otro texto.')], variables: [variable] };
  const original = structuredClone(conversation), index = buildMessageFlags(conversation);
  assert.deepEqual([...index.byMessage.keys()], ['one', 'two']);
  assert.deepEqual(index.unlinkedVariables, []);
  assert.equal(index.markedVariables[0].historical, true);
  assert.equal(index.markedVariables[0].effective, false);
  assert.equal(index.markedVariables[0].dualDetected, false);
  assert.deepEqual(conversation, original);
});

test('historical evidence rejects changed, ambiguous, missing and empty citations without guessing another message', () => {
  const cases = [
    { messages: [message('same', 'maybe yes')], quote: 'yes' },
    { messages: [message('same', 'Mensaje editado'), message('other', 'Original')], quote: 'Original' },
    { messages: [message('other', 'Original')], quote: 'Original' },
    { messages: [message('same', 'Original'), message('same', 'Original')], quote: 'Original' },
    { messages: [message('same', 'Original')], quote: '' },
    { messages: [message('same', '   ')], quote: '   ' },
    { messages: [message('same', 'Original')], quote: null },
    { messages: [message('same', ' Original ')], quote: 'Original' },
  ];
  for (const { messages, quote } of cases) {
    const variable = flag('saved', 'critical');
    variable.result.evidence = [{ messageId: 'same', quote }];
    const conversation = { evaluation: { sourceChanged: true }, messages, variables: [variable] };
    assert.equal(evidenceMessageLookup(conversation)(variable.result.evidence[0]), null);
    assert.equal(buildMessageFlags(conversation).byMessage.size, 0);
    assert.equal(buildMessageFlags(conversation).unlinkedVariables.length, 1);
  }
});

test('historical evidence accepts the exact 2000-character evaluator prefix and keeps current-source ID behavior', () => {
  const quote = 'a'.repeat(2000), current = message('same', `${quote} Original suffix.`);
  const lookup = evidenceMessageLookup({ sourceChanged: true, messages: [current] });
  assert.equal(lookup({ messageId: 'same', quote }), current);
  assert.equal(lookup({ messageId: 'same', quote: quote.slice(1) }), null);
  assert.equal(lookup({ messageId: 'same', quote: `${quote.slice(1)}b` }), null);
  assert.equal(evidenceMessageLookup({ messages: [current] })({ messageId: 'same' }), current);
  assert.equal(evidenceMessageLookup({ messages: [message(0), message('0')] })({ messageId: 0 }), null);
});
