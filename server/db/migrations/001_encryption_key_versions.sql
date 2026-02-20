-- Migration 001: Add encryption key version columns
-- Tracks which keyring version was used to encrypt each credential

ALTER TABLE agents ADD COLUMN encryption_key_version INTEGER DEFAULT NULL;

ALTER TABLE storage_connections ADD COLUMN access_key_id_key_version INTEGER DEFAULT NULL;
ALTER TABLE storage_connections ADD COLUMN secret_access_key_key_version INTEGER DEFAULT NULL;

-- Deterministic backfill: non-null encrypted → v1 (legacy), null encrypted → NULL
UPDATE agents SET encryption_key_version = 1 WHERE provider_api_key_encrypted IS NOT NULL AND encryption_key_version IS NULL;
UPDATE storage_connections SET access_key_id_key_version = 1 WHERE access_key_id_encrypted IS NOT NULL AND access_key_id_key_version IS NULL;
UPDATE storage_connections SET secret_access_key_key_version = 1 WHERE secret_access_key_encrypted IS NOT NULL AND secret_access_key_key_version IS NULL;
