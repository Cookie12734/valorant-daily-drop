import {sqliteTable,text,integer,uniqueIndex,index} from 'drizzle-orm/sqlite-core';
import {sql} from 'drizzle-orm';
// Purchase records contain no Riot credentials. Quotes are single-use forever.
export const webOrders=sqliteTable('web_orders',{
 id:text('id').primaryKey(),owner:text('owner').notNull(),account:text('account').notNull(),
 item:text('item').notNull(),offer:text('offer').notNull(),price:integer('price').notNull(),balance:integer('balance').notNull(),
 itemType:text('item_type').notNull().default('e7c63390-eda7-46e0-bb7a-a6abdacd2433'),
 expires:integer('expires').notNull(),created:integer('created').notNull(),state:text('state').notNull(),orderId:text('order_id'),
},table=>[
 uniqueIndex('web_orders_one_unresolved').on(table.account).where(sql`${table.state} in ('unknown','pending')`),
 index('web_orders_owner').on(table.owner,table.account,table.created),
]);
