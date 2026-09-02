ALTER TABLE `tunnel_config` ADD `access_mode` text CHECK("access_mode" in ('none', 'login', 'cloudflare'));
