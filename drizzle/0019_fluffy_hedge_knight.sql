CREATE TABLE "conversations" (
	"conversation_id" varchar(21) PRIMARY KEY NOT NULL,
	"worker_id" varchar(21) NOT NULL,
	"employer_id" varchar(21) NOT NULL,
	"last_message_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_by_worker_at" timestamp with time zone,
	"deleted_by_employer_at" timestamp with time zone,
	CONSTRAINT "unique_conversation" UNIQUE("worker_id","employer_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"messages_id" varchar(21) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(21) NOT NULL,
	"sender_worker_id" varchar(21),
	"sender_employer_id" varchar(21),
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_by_worker" boolean DEFAULT false NOT NULL,
	"deleted_by_employer" boolean DEFAULT false NOT NULL,
	"retracted_at" timestamp with time zone,
	CONSTRAINT "check_sender" CHECK (num_nonnulls("messages"."sender_worker_id", "messages"."sender_employer_id") = 1)
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_worker_id_workers_worker_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("worker_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_employer_id_employers_employer_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."employers"("employer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_worker_id_workers_worker_id_fk" FOREIGN KEY ("sender_worker_id") REFERENCES "public"."workers"("worker_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_employer_id_employers_employer_id_fk" FOREIGN KEY ("sender_employer_id") REFERENCES "public"."employers"("employer_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversations_worker_idx" ON "conversations" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "conversations_employer_idx" ON "conversations" USING btree ("employer_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_ts_idx" ON "messages" USING btree ("conversation_id","created_at");