DELETE FROM `device_folder_placements` WHERE `kind` <> 'node' OR `device_id` IS NOT NULL;--> statement-breakpoint
WITH RECURSIVE `tree`(`id`, `path`, `depth`) AS (
	SELECT `id`, printf('%011d', `sort_order`) || char(1) || `created_at` || char(1) || `id` || char(1), 0
	FROM `device_folders`
	WHERE `parent_id` IS NULL OR `parent_id` NOT IN (SELECT `id` FROM `device_folders`)
	UNION ALL
	SELECT `f`.`id`, `t`.`path` || printf('%011d', `f`.`sort_order`) || char(1) || `f`.`created_at` || char(1) || `f`.`id` || char(1), `t`.`depth` + 1
	FROM `device_folders` `f` JOIN `tree` `t` ON `f`.`parent_id` = `t`.`id`
	WHERE `t`.`depth` < 64
),
`ordered`(`id`, `grp`, `path`) AS (
	SELECT `id`, 0, `path` FROM `tree`
	UNION ALL
	SELECT `id`, 1, printf('%011d', `sort_order`) || char(1) || `created_at` || char(1) || `id`
	FROM `device_folders` WHERE `id` NOT IN (SELECT `id` FROM `tree`)
),
`ranked`(`id`, `rn`) AS (
	SELECT `id`, row_number() OVER (ORDER BY `grp`, `path`) - 1 FROM `ordered`
)
UPDATE `device_folders` SET `parent_id` = NULL, `sort_order` = (SELECT `rn` FROM `ranked` WHERE `ranked`.`id` = `device_folders`.`id`);--> statement-breakpoint
WITH `ranked`(`item_key`, `rn`) AS (
	SELECT `item_key`, row_number() OVER (PARTITION BY `folder_id` ORDER BY `sort_order`, `created_at`, `item_key`) - 1
	FROM `device_folder_placements`
)
UPDATE `device_folder_placements` SET `sort_order` = (SELECT `rn` FROM `ranked` WHERE `ranked`.`item_key` = `device_folder_placements`.`item_key`);
