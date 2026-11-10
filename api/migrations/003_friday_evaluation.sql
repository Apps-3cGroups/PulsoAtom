-- Add the explicitly requested one-time run without changing the daily schedule.
UPDATE portal_settings
SET payload = JSON_SET(payload,
  '$.oneOffEvaluations', JSON_ARRAY(JSON_OBJECT(
    'id', 'friday-2026-11-13-hn-pa', 'label', 'Corrida del viernes · HN y Panamá',
    'timezone', 'America/Tegucigalpa', 'ingestionFrom', '2026-11-13T06:00:00.000Z',
    'notBefore', '2026-11-13T16:30:00.000Z', 'expiresAt', '2026-11-14T06:00:00.000Z',
    'countries', JSON_ARRAY('HN', 'PA'), 'modelIds', JSON_ARRAY('clef-local', 'gemma-local'),
    'limitPerCountry', 200, 'concurrency', 2, 'enabled', CAST('true' AS JSON), 'status', 'scheduled'
  )), '$.version', COALESCE(JSON_EXTRACT(payload, '$.version'), 0) + 1)
WHERE id = 'settings' AND JSON_EXTRACT(payload, '$.oneOffEvaluations') IS NULL;
