CREATE TABLE `ledger_revision` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);

--> statement-breakpoint
INSERT INTO ledger_revision(id,revision) VALUES('main',0);
--> statement-breakpoint
CREATE TRIGGER transactions_revision_insert AFTER INSERT ON transactions BEGIN UPDATE ledger_revision SET revision=revision+1 WHERE id='main'; END;
--> statement-breakpoint
CREATE TRIGGER transactions_revision_update AFTER UPDATE ON transactions BEGIN UPDATE ledger_revision SET revision=revision+1 WHERE id='main'; END;
--> statement-breakpoint
CREATE TRIGGER transactions_revision_delete AFTER DELETE ON transactions BEGIN UPDATE ledger_revision SET revision=revision+1 WHERE id='main'; END;
--> statement-breakpoint
CREATE TRIGGER repayments_revision_insert AFTER INSERT ON repayments BEGIN UPDATE ledger_revision SET revision=revision+1 WHERE id='main'; END;
--> statement-breakpoint
CREATE TRIGGER repayments_revision_update AFTER UPDATE ON repayments BEGIN UPDATE ledger_revision SET revision=revision+1 WHERE id='main'; END;
--> statement-breakpoint
CREATE TRIGGER repayments_revision_delete AFTER DELETE ON repayments BEGIN UPDATE ledger_revision SET revision=revision+1 WHERE id='main'; END;
--> statement-breakpoint
CREATE TRIGGER people_revision_insert AFTER INSERT ON people BEGIN UPDATE ledger_revision SET revision=revision+1 WHERE id='main'; END;
--> statement-breakpoint
CREATE TRIGGER people_revision_update AFTER UPDATE ON people BEGIN UPDATE ledger_revision SET revision=revision+1 WHERE id='main'; END;
--> statement-breakpoint
CREATE TRIGGER people_revision_delete AFTER DELETE ON people BEGIN UPDATE ledger_revision SET revision=revision+1 WHERE id='main'; END;
