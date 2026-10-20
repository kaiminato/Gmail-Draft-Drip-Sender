CREATE TABLE "sent_mail" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" uuid,
	"sender" text,
	"manager_id" uuid,
	"manager_name" text,
	"recipient" text,
	"recipient_count" integer DEFAULT 1 NOT NULL,
	"subject" text,
	"tier" text,
	"late" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sent_mail" ADD CONSTRAINT "sent_mail_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sent_mail" ADD CONSTRAINT "sent_mail_manager_id_managers_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."managers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sent_mail_time_idx" ON "sent_mail" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "sent_mail_account_time_idx" ON "sent_mail" USING btree ("account_id","sent_at");--> statement-breakpoint
CREATE INDEX "sent_mail_manager_idx" ON "sent_mail" USING btree ("manager_id");
--> statement-breakpoint
-- Backfill from the events already recorded: one log row per sent event, with the
-- sender, manager and tier the account has now (the best available for the past).
INSERT INTO "sent_mail" ("id","account_id","sender","manager_id","manager_name","recipient","recipient_count","subject","tier","late","sent_at","received_at")
SELECT e."id", e."account_id", a."email", a."manager_id", m."name", e."recipient",
       GREATEST(1, coalesce(array_length(string_to_array(coalesce(e."recipient", ''), ', '), 1), 1)),
       e."subject", a."tier", coalesce(e."message", '') LIKE '%(confirmed late)%', e."occurred_at", e."received_at"
FROM "events" e
JOIN "accounts" a ON a."id" = e."account_id"
LEFT JOIN "managers" m ON m."id" = a."manager_id"
WHERE e."type" = 'sent'
ON CONFLICT ("id") DO NOTHING;
