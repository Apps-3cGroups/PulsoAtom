CREATE TABLE IF NOT EXISTS schema_migrations (
  name VARCHAR(160) PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS app_lock (id INT PRIMARY KEY) ENGINE=InnoDB;
INSERT IGNORE INTO app_lock (id) VALUES (1);
CREATE TABLE IF NOT EXISTS users (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY,
  email VARCHAR(254) NOT NULL UNIQUE,
  payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS sessions (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY,
  payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS catalog_items (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY,
  payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS catalog_versions (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY,
  payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS catalog_audit (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY,
  payload JSON NOT NULL
) ENGINE=InnoDB;
-- Atom conserva las conversaciones y mensajes. Pulso solo registra sus identificadores
-- para deduplicar sincronizaciones y relacionar las evaluaciones sin copiar transcripciones.
CREATE TABLE IF NOT EXISTS source_conversation_refs (
  source_name VARCHAR(40) NOT NULL,
  source_conversation_id VARCHAR(200) NOT NULL,
  first_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  source_updated_at DATETIME(3) NULL,
  content_fingerprint CHAR(64) NULL,
  PRIMARY KEY (source_name, source_conversation_id),
  KEY ix_source_conversation_refs_updated (source_name, source_updated_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS evaluations (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY,
  payload JSON NOT NULL
) ENGINE=InnoDB;
-- El payload preserva el snapshot completo. Estas filas facilitan consultar resultados
-- por variable sin duplicar la conversación de origen.
CREATE TABLE IF NOT EXISTS evaluation_results (
  evaluation_id VARCHAR(200) NOT NULL,
  variable_id VARCHAR(200) NOT NULL,
  catalog_version INT UNSIGNED NOT NULL,
  status VARCHAR(40) NOT NULL,
  value_json JSON NULL,
  reason TEXT NULL,
  PRIMARY KEY (evaluation_id, variable_id),
  KEY ix_evaluation_results_variable (variable_id, status),
  CONSTRAINT fk_evaluation_results_evaluation FOREIGN KEY (evaluation_id) REFERENCES evaluations(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS evaluation_evidence (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  evaluation_id VARCHAR(200) NOT NULL,
  variable_id VARCHAR(200) NOT NULL,
  source_message_id VARCHAR(200) NOT NULL,
  quote TEXT NOT NULL,
  KEY ix_evaluation_evidence_result (evaluation_id, variable_id),
  CONSTRAINT fk_evaluation_evidence_result FOREIGN KEY (evaluation_id, variable_id)
    REFERENCES evaluation_results(evaluation_id, variable_id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS review_events (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY,
  payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS evaluation_jobs (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY,
  payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ingestion_batches (
  sequence_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT UNIQUE,
  id VARCHAR(200) PRIMARY KEY,
  payload JSON NOT NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS source_sync_cursors (
  source_name VARCHAR(40) PRIMARY KEY,
  last_source_updated_at DATETIME(3) NULL,
  last_source_id VARCHAR(200) NULL,
  last_success_at DATETIME(3) NULL
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS portal_settings (
  id VARCHAR(80) PRIMARY KEY,
  payload JSON NOT NULL
) ENGINE=InnoDB;
