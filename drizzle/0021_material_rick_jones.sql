ALTER TABLE "employers" ADD COLUMN "locked_until" timestamp;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "locked_until" timestamp;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "absence_count" integer DEFAULT 0 NOT NULL;