CREATE TABLE IF NOT EXISTS operational_refs (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY, payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS comparison_samples (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY, payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS evaluation_tasks (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY, payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS evaluation_attempts (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY, payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS human_verdicts (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY, payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS evaluation_exposures (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY, payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS validation_sessions (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY, payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS model_policies (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY, payload JSON NOT NULL
) ENGINE=InnoDB;
INSERT IGNORE INTO operational_refs (id, payload)
SELECT JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.conversationId')),
  JSON_OBJECT('id', JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.conversationId')), 'evaluationId', e.id)
FROM evaluations e
WHERE COALESCE(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.purpose')), '') <> 'comparison'
AND NOT EXISTS (
  SELECT 1 FROM evaluations newer
  WHERE JSON_UNQUOTE(JSON_EXTRACT(newer.payload, '$.conversationId')) = JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.conversationId'))
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(newer.payload, '$.purpose')), '') <> 'comparison'
    AND (JSON_UNQUOTE(JSON_EXTRACT(newer.payload, '$.createdAt')) > JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.createdAt'))
      OR (JSON_UNQUOTE(JSON_EXTRACT(newer.payload, '$.createdAt')) = JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.createdAt')) AND newer.sequence_id < e.sequence_id))
);
