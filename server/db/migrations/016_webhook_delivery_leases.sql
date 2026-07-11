ALTER TABLE webhook_deliveries ADD COLUMN delivery_claim_until TEXT;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_claim ON webhook_deliveries(status, delivery_claim_until);
