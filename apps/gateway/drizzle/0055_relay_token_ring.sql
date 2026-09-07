ALTER TABLE `relay_tenants` ADD `previous_tokens_json` text;--> statement-breakpoint
UPDATE `relay_tenants`
SET `previous_tokens_json` = CASE
  WHEN `prev_token_hash` IS NOT NULL AND `prev_token_issued_at` IS NOT NULL
  THEN json_array(json_object('hash', `prev_token_hash`, 'issued_at', `prev_token_issued_at`))
  ELSE '[]'
END;
