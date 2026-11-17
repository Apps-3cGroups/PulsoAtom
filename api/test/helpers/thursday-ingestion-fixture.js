export const ingestionBatch = ({ id = 'hn', countries = ['HN'], status = 'LISTO', ...values } = {}) => ({
  id, countries, scopeKnown: true, status, finishedAt: '2026-11-13 00:30:00.000000', updatedAt: '2026-11-13 00:30:00.000000',
  expectedDocuments: 20, processedDocuments: 20, failedDocuments: 0, pendingDocuments: 0, documents: 20,
  countryMismatch: false, documentStates: [{ status: 'LISTO', country: countries[0], documents: 20 }], ...values,
});
export const ingestionSnapshot = batches => ({ selection: 'thursday-metadata-v1', activityDate: '2026-11-12',
  countries: ['HN', 'PA'], truncated: false, batches: batches || [ingestionBatch(), ingestionBatch({ id: 'pa', countries: ['PA'] })] });
