ALTER TABLE `tls_config` ADD `acme_dns_provider` text CHECK("acme_dns_provider" is null or "acme_dns_provider" in ('cloudflare', 'dnspod'));--> statement-breakpoint
ALTER TABLE `tls_config` ADD `acme_dns_secret_enc` text;
