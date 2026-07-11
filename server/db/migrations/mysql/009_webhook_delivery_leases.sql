ALTER TABLE webhook_deliveries ADD COLUMN delivery_claim_until DATETIME(3) NULL;
CREATE INDEX idx_webhook_deliveries_claim ON webhook_deliveries(status, delivery_claim_until);
