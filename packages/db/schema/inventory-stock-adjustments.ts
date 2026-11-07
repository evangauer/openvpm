import {
  foreignKey,
  index,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { practices } from "./practices";
import { products } from "./billing";
import { users } from "./users";

/**
 * Append-only record of manual stock adjustments. Each row is keyed by the
 * client-generated operation id of one form submission, so a repeated submit
 * (double click, network retry) replays the original adjustment instead of
 * moving stock twice. products.stock_quantity remains the current balance.
 */
export const inventoryStockAdjustments = pgTable(
  "inventory_stock_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    practiceId: uuid("practice_id")
      .notNull()
      .references(() => practices.id),
    productId: uuid("product_id").notNull(),
    operationId: uuid("operation_id").notNull(),
    adjustment: numeric("adjustment", {
      precision: 13,
      scale: 3,
      mode: "number",
    }).notNull(),
    quantityAfter: numeric("quantity_after", {
      precision: 13,
      scale: 3,
      mode: "number",
    }).notNull(),
    reason: text("reason").notNull(),
    adjustedBy: uuid("adjusted_by")
      .notNull()
      .references(() => users.id),
  },
  (table) => ({
    practiceOperationUq: uniqueIndex(
      "inventory_stock_adjustments_practice_operation_uq",
    ).on(table.practiceId, table.operationId),
    productHistoryIdx: index("inventory_stock_adjustments_product_idx").on(
      table.practiceId,
      table.productId,
      table.createdAt,
    ),
    productPracticeFk: foreignKey({
      columns: [table.practiceId, table.productId],
      foreignColumns: [products.practiceId, products.id],
      name: "inventory_stock_adjustments_practice_product_fk",
    }),
  }),
);
