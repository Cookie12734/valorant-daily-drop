CREATE TABLE `web_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`account` text NOT NULL,
	`item` text NOT NULL,
	`offer` text NOT NULL,
	`price` integer NOT NULL,
	`balance` integer NOT NULL,
	`expires` integer NOT NULL,
	`created` integer NOT NULL,
	`state` text NOT NULL,
	`order_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `web_orders_one_unresolved` ON `web_orders` (`account`) WHERE "web_orders"."state" in ('unknown','pending');--> statement-breakpoint
CREATE INDEX `web_orders_owner` ON `web_orders` (`owner`,`account`,`created`);