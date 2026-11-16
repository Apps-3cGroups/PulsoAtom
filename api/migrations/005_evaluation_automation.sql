-- Assignments reserve quota before inference and survive retries/settings edits.
CREATE TABLE IF NOT EXISTS evaluation_daily_assignments (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY,
  payload JSON NOT NULL,
  activity_date VARCHAR(10) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(payload, '$.activityDate'))) STORED,
  country_code VARCHAR(10) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(payload, '$.country'))) STORED,
  conversation_key VARCHAR(200) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(payload, '$.conversationId'))) STORED,
  UNIQUE KEY uq_daily_assignment (activity_date, country_code, conversation_key)
) ENGINE=InnoDB;
