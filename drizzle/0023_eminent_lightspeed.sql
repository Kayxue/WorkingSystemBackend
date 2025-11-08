ALTER TABLE "messages" ADD COLUMN "gig_id" varchar(21);--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "reply_to_id" varchar;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_gig_id_gigs_gig_id_fk" FOREIGN KEY ("gig_id") REFERENCES "public"."gigs"("gig_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_reply_to_id_messages_messages_id_fk" FOREIGN KEY ("reply_to_id") REFERENCES "public"."messages"("messages_id") ON DELETE set null ON UPDATE no action;