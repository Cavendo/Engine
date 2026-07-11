ALTER TABLE webhook_deliveries ADD COLUMN IF NOT EXISTS delivery_claim_until TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_claim ON webhook_deliveries(status, delivery_claim_until);
