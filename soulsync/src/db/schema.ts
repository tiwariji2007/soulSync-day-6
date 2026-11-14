import {
  pgTable,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  check,
  uniqueIndex,
  jsonb,
  numeric,
  vector,
  index,
  unique,
} from "drizzle-orm/pg-core";

import { sql } from "drizzle-orm";
import { user } from "./auth-schema";






// Journal entries table
export const journals = pgTable("journals", {
  id: uuid("id").defaultRandom().primaryKey(),

  userId: text("user_id")
    .notNull()
    .references(() => user.id),

  title: varchar("title", { length: 200 }).notNull(),

  content: text("content").notNull(),

  createdAt: timestamp("created_at")
    .defaultNow()
    .notNull(),
});

// Mood entries table
export const moods = pgTable("moods", {
  id: uuid("id").defaultRandom().primaryKey(),

  userId: text("user_id")
    .notNull()
    .references(() => user.id),

  mood: varchar("mood", { length: 30 }).notNull(),

  note: text("note"),

  createdAt: timestamp("created_at")
    .defaultNow()
    .notNull(),
});



export const userRoles = pgTable("user_roles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, {
      onDelete: "cascade",
    }),

  role: varchar("role", {
    length: 20,
    enum: ["user", "admin"],
  })
    .notNull()
    .default("user"),
});





/* --------------------------------
   1. Payment Orders
-------------------------------- */

export const paymentOrders = pgTable(
  "payment_orders",
  {
    id: uuid("id")
      .defaultRandom()
      .primaryKey(),

    userId: text("user_id")
      .notNull()
      .references(() => user.id),

    razorpayOrderId: varchar("razorpay_order_id", {
      length: 100,
    }),

    razorpayPaymentId: varchar("razorpay_payment_id", {
      length: 100,
    }),

    amount: integer("amount")
      .notNull(),

    currency: varchar("currency", {
      length: 3,
    })
      .notNull()
      .default("INR"),

    status: varchar("status", {
      length: 20,
    })
      .notNull()
      .default("created"),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),

    paidAt: timestamp("paid_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    uniqueIndex("payment_orders_razorpay_order_uidx")
      .on(table.razorpayOrderId),

    uniqueIndex("payment_orders_razorpay_payment_uidx")
      .on(table.razorpayPaymentId),

    check(
      "payment_orders_amount_positive",
      sql`${table.amount} > 0`
    ),

    check(
      "payment_orders_currency_inr",
      sql`${table.currency} = 'INR'`
    ),

    check(
      "payment_orders_status_valid",
      sql`${table.status} IN ('created', 'paid', 'failed')`
    ),
  ]
);

/* --------------------------------
   2. Processed Webhook Events
-------------------------------- */

export const webhookEvents = pgTable(
  "webhook_events",
  {
    eventId: text("event_id")
      .primaryKey(),

    eventType: varchar("event_type", {
      length: 100,
    })
      .notNull(),

    processedAt: timestamp("processed_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  }
);

/* --------------------------------
   3. Pro Entitlements
-------------------------------- */

export const proEntitlements = pgTable(
  "pro_entitlements",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => user.id, {
        onDelete: "cascade",
      }),

    plan: varchar("plan", {
      length: 20,
    })
      .notNull()
      .default("pro"),

    paymentOrderId: uuid("payment_order_id")
      .notNull()
      .references(() => paymentOrders.id),

    activatedAt: timestamp("activated_at", {
      withTimezone: true,
    })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "pro_entitlements_plan_valid",
      sql`${table.plan} = 'pro'`
    ),
  ]
);

// --------------------------------
// 4. FAQ Documents for RAG
// --------------------------------

export const faqDocuments = pgTable("faq_documents", {
  id: uuid("id").defaultRandom().primaryKey(),

  question: text("question").notNull(),

  answer: text("answer").notNull(),

  embedding: jsonb("embedding")
    .$type<number[]>()
    .notNull(),

  createdAt: timestamp("created_at", {
    withTimezone: true,
  }).defaultNow().notNull(),

  updatedAt: timestamp("updated_at", {
    withTimezone: true,
  }).defaultNow().notNull(),
});

// --------------------------------
// 5. FAQ Request Usage Logs
// --------------------------------

export const faqUsageLogs = pgTable("faq_usage_logs", {
  id: uuid("id").defaultRandom().primaryKey(),

  userId: text("user_id").references(() => user.id, {
    onDelete: "set null",
  }),

  model: varchar("model", { length: 100 }).notNull(),

  embeddingModel: varchar("embedding_model", {
    length: 100,
  }).notNull(),

  promptTokens: integer("prompt_tokens").notNull().default(0),

  completionTokens: integer("completion_tokens")
    .notNull()
    .default(0),

  totalTokens: integer("total_tokens").notNull().default(0),

  costUsd: numeric("cost_usd", {
    precision: 12,
    scale: 8,
  }).notNull().default("0"),

  latencyMs: integer("latency_ms").notNull().default(0),

  status: varchar("status", { length: 30 }).notNull(),

  errorCode: varchar("error_code", { length: 100 }),

  createdAt: timestamp("created_at", {
    withTimezone: true,
  }).defaultNow().notNull(),
});

// --------------------------------
// 6. FAQ chunks with pgvector embeddings (RAG retrieval)
// --------------------------------

export const FAQ_EMBEDDING_DIMENSIONS = 768;

export const faqChunks = pgTable(
  "faq_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    source: varchar("source", { length: 200 }).notNull(),

    chunkIndex: integer("chunk_index").notNull(),

    heading: text("heading").notNull(),

    content: text("content").notNull(),

    embedding: vector("embedding", {
      dimensions: FAQ_EMBEDDING_DIMENSIONS,
    }).notNull(),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    unique("faq_chunks_source_chunk_uq").on(table.source, table.chunkIndex),
    index("faq_chunks_embedding_hnsw_idx").using(
      "hnsw",
      table.embedding.op("vector_cosine_ops")
    ),
  ]
);

// --------------------------------
// 7. AI usage logs for every AI endpoint
// --------------------------------

export const aiUsageLogs = pgTable(
  "ai_usage_logs",
  {
    id: uuid("id").defaultRandom().primaryKey(),

    userId: text("user_id").references(() => user.id, {
      onDelete: "set null",
    }),

    endpoint: varchar("endpoint", { length: 100 }).notNull(),

    model: varchar("model", { length: 100 }).notNull(),

    promptTokens: integer("prompt_tokens").notNull().default(0),

    completionTokens: integer("completion_tokens").notNull().default(0),

    totalTokens: integer("total_tokens").notNull().default(0),

    costUsd: numeric("cost_usd", {
      precision: 12,
      scale: 8,
    }).notNull().default("0"),

    latencyMs: integer("latency_ms").notNull().default(0),

    httpStatus: integer("http_status").notNull(),

    status: varchar("status", { length: 30 }).notNull(),

    errorCode: varchar("error_code", { length: 100 }),

    createdAt: timestamp("created_at", {
      withTimezone: true,
    }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_usage_logs_user_created_idx").on(table.userId, table.createdAt),
    index("ai_usage_logs_endpoint_created_idx").on(table.endpoint, table.createdAt),
  ]
);
