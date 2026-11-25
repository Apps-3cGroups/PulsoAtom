import test from 'node:test';
import assert from 'node:assert/strict';
import { AUTHORIZED_REVIEW, assertKnownReviewRequest, authorizeReviewRequest, parseAuthorizationArguments } from './authorize-review-request.mjs';

function fakeDatabase({ authorized = false, jobs = [], missing = false } = {}) {
  const original = { id: AUTHORIZED_REVIEW.id, authorizedForExecution: authorized, preparatoryOnly: !authorized,
    selectionHash: AUTHORIZED_REVIEW.selectionHash, privateCases: [{ text: 'PRIVATE_SENTINEL' }], arbitraryPreservedField: { nested: 'unchanged' } };
  let state = structuredClone(original), draft;
  const statements = [];
  const connection = {
    async beginTransaction() { draft = structuredClone(state); },
    async execute(sql, values) {
      statements.push({ sql, values });
      if (sql.startsWith('SELECT payload')) return [missing ? [] : [{ payload: JSON.stringify(draft) }]];
      if (sql.startsWith('SELECT id FROM evaluation_jobs')) return [jobs];
      assert.match(sql, /^UPDATE portal_settings SET payload = JSON_SET/);
      assert.deepEqual(values, [`reviewRequest:${AUTHORIZED_REVIEW.id}`]);
      assert.match(sql, /CAST\('true' AS JSON\)/); assert.match(sql, /CAST\('false' AS JSON\)/);
      draft.authorizedForExecution = true; draft.preparatoryOnly = false; return [{ affectedRows: 1 }];
    },
    async commit() { state = draft; },
    async rollback() { draft = null; },
  };
  return { original, connection, statements, state: () => state };
}
const validateFixture = manifest => {
  assert.equal(manifest.id, AUTHORIZED_REVIEW.id); assert.equal(manifest.selectionHash, AUTHORIZED_REVIEW.selectionHash); return manifest;
};

test('authorization changes only two booleans in the exact private row and is idempotent', async () => {
  const db = fakeDatabase();
  const result = await authorizeReviewRequest(db.connection, { validate: validateFixture });
  assert.equal(result.changed, true); assert.equal(result.cases, 214); assert.equal(result.expectedReviews, 428);
  assert.deepEqual(db.state(), { ...db.original, authorizedForExecution: true, preparatoryOnly: false });
  const second = await authorizeReviewRequest(db.connection, { validate: validateFixture });
  assert.equal(second.changed, false);
  assert.equal(db.statements.filter(entry => entry.sql.startsWith('UPDATE')).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SENTINEL|privateCases/);
});
test('existing execution, missing request or failed integrity validation never writes', async () => {
  for (const options of [{ jobs: [{ id: 'existing' }] }, { missing: true }, {}]) {
    const db = fakeDatabase(options);
    const validate = options.jobs || options.missing ? validateFixture : () => { throw Object.assign(new Error('mismatch'), { code: 'REVIEW_AUTHORIZATION_MISMATCH' }); };
    await assert.rejects(authorizeReviewRequest(db.connection, { validate }));
    assert.deepEqual(db.state(), db.original);
    assert.equal(db.statements.filter(entry => entry.sql.startsWith('UPDATE')).length, 0);
  }
});
test('CLI has no route to authorize a different request or a larger cohort', () => {
  assert.deepEqual(parseAuthorizationArguments(['--request-id', AUTHORIZED_REVIEW.id]), { requestId: AUTHORIZED_REVIEW.id });
  for (const args of [[], ['--request-id', 'fresh-review414-20261125'], ['--request-id', AUTHORIZED_REVIEW.id, '--force'], ['--manifest', '/tmp/x']]) {
    assert.throws(() => parseAuthorizationArguments(args), { code: 'INVALID_ARGUMENTS' });
  }
  assert.throws(() => assertKnownReviewRequest({ ...AUTHORIZED_REVIEW, cases: [] }));
});
