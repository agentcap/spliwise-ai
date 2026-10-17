package com.splitwiseai.app

import android.content.Context
import android.net.Uri
import androidx.sqlite.SQLiteStatement
import androidx.sqlite.driver.bundled.BundledSQLiteDriver
import com.google.gson.*
import com.splitwiseai.ledger.*
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

class AndroidDatabase(path: String) : LedgerDatabase {
    private val connection = BundledSQLiteDriver().open(path)
    private val lock = ReentrantLock(true)
    private var depth = 0

    init {
        execute("PRAGMA foreign_keys=ON")
        execute("PRAGMA busy_timeout=5000")
        execute("PRAGMA trusted_schema=OFF")
    }

    private fun bind(statement: SQLiteStatement, args: Array<out Any?>) =
        args.forEachIndexed { i, v ->
            when (v) {
                null -> statement.bindNull(i + 1)
                is Number -> statement.bindLong(i + 1, v.toLong())
                is ByteArray -> statement.bindBlob(i + 1, v)
                else -> statement.bindText(i + 1, v.toString())
            }
        }

    override fun rows(sql: String, vararg args: Any?): List<JsonObject> = lock.withLock {
        connection.prepare(sql).use { statement ->
            bind(statement, args)
            buildList {
                while (statement.step()) add(
                    JsonObject().apply {
                        repeat(statement.getColumnCount()) { i ->
                            val value =
                                when (statement.getColumnType(i)) {
                                    1 -> JsonPrimitive(statement.getLong(i))
                                    2 -> JsonPrimitive(statement.getDouble(i))
                                    5 -> JsonNull.INSTANCE
                                    else -> JsonPrimitive(statement.getText(i))
                                }
                            add(statement.getColumnName(i), value)
                        }
                    }
                )
            }
        }
    }

    override fun execute(sql: String, vararg args: Any?) = lock.withLock {
        connection.prepare(sql).use {
            bind(it, args)
            while (it.step()) {
                /* Consume PRAGMA/VACUUM results. */
            }
        }
    }

    override fun <T> transaction(work: () -> T): T = lock.withLock {
        val outer = depth == 0
        if (outer) execute("BEGIN IMMEDIATE")
        depth++
        try {
            val result = work()
            if (outer) execute("COMMIT")
            result
        } catch (e: Throwable) {
            if (outer) execute("ROLLBACK")
            throw e
        } finally {
            depth--
        }
    }

    override fun close() = lock.withLock { connection.close() }
}

class WorkspaceStorage(private val context: Context) {
    private val directory = File(context.noBackupFilesDir, "workspace").apply { mkdirs() }
    private val live = File(directory, "ledger.sqlite")
    private val stage = File(directory, "incoming.sqlite")
    private val recovery = File(directory, "recovery.sqlite")
    @Volatile
    lateinit var ledger: Ledger
        private set

    private fun open(file: File): Ledger {
        val result = Ledger(AndroidDatabase(file.path))
        try {
            migrate(result.db)
            result.seed()
            return result
        } catch (e: Throwable) {
            result.db.close()
            throw e
        }
    }

    init {
        ledger = open(live)
        ledger.db.execute("PRAGMA journal_mode=WAL")
        interruptJobs(ledger, "App closed during processing. Resume when ready.")
    }

    private fun migrate(db: LedgerDatabase) {
        val journal =
            json(context.assets.open("meta/_journal.json").bufferedReader().use { it.readText() })
                .asJsonObject
                .a("entries")
                .map { it.asJsonObject }
        db.execute(
            "CREATE TABLE IF NOT EXISTS __drizzle_migrations(id SERIAL PRIMARY KEY,hash text NOT NULL,created_at numeric)"
        )
        val applied = db.rows("SELECT * FROM __drizzle_migrations ORDER BY created_at")
        require(applied.size <= journal.size) { "This workspace needs a newer app." }
        applied.forEachIndexed { i, row ->
            require(row.n("created_at") == journal[i].n("when")) {
                "Unsupported workspace migration history."
            }
            val bytes = context.assets.open(journal[i].s("tag") + ".sql").use { it.readBytes() }
            require(row.s("hash") == sha256(bytes)) { "Workspace migration checksum mismatch." }
        }
        db.transaction {
            journal.drop(applied.size).forEach { item ->
                val sql =
                    context.assets.open(item.s("tag") + ".sql").bufferedReader().use {
                        it.readText()
                    }
                sql.split("--> statement-breakpoint")
                    .filter { it.isNotBlank() }
                    .forEach { db.execute(it) }
                db.execute(
                    "INSERT INTO __drizzle_migrations(hash,created_at) VALUES(?,?)",
                    sha256(sql.toByteArray()),
                    item.n("when"),
                )
            }
        }
    }

    private fun interruptJobs(store: Ledger, message: String) =
        store.db.execute(
            "UPDATE jobs SET status='failed',error=?,leaseUntil=0,leaseToken=NULL,updatedAt=? WHERE status IN ('queued','running')",
            message,
            now(),
        )

    fun preview(uri: Uri): JsonObject {
        stage.delete()
        try {
            context.contentResolver.openInputStream(uri)!!.use { source ->
                stage.outputStream().use { destination ->
                    val buffer = ByteArray(65536)
                    var total = 0L
                    while (true) {
                        val n = source.read(buffer)
                        if (n < 0) break
                        total += n
                        require(total <= 2_000_000_000L) { "Workspace exceeds 2 GB." }
                        require(directory.usableSpace > 128_000_000) {
                            "Free more device storage first."
                        }
                        destination.write(buffer, 0, n)
                    }
                }
            }
            val header = ByteArray(16)
            java.io.DataInputStream(stage.inputStream()).use { it.readFully(header) }
            require(header.contentEquals("SQLite format 3\u0000".toByteArray())) {
                "Select the full .sqlite workspace export from web Settings."
            }
            AndroidDatabase(stage.path).use { staged ->
                require(
                    staged
                        .rows("PRAGMA integrity_check")
                        .single()
                        .entrySet()
                        .first()
                        .value
                        .asString == "ok"
                ) {
                    "Workspace integrity check failed."
                }
                // Revision triggers are part of the shared web schema. Only accept the
                // exact definitions shipped with the app, before running migrations.
                AndroidDatabase(":memory:").use { trusted ->
                    migrate(trusted)
                    val definitions =
                        trusted.rows(
                            "SELECT name,type,sql FROM sqlite_master WHERE type IN ('trigger','view')"
                        )
                    require(
                        staged
                            .rows(
                                "SELECT name,type,sql FROM sqlite_master WHERE type IN ('trigger','view')"
                            )
                            .all { it in definitions }
                    ) {
                        "Unsupported workspace objects."
                    }
                }
                val known =
                    setOf(
                        "accounts",
                        "action_batches",
                        "categories",
                        "import_rows",
                        "imports",
                        "jobs",
                        "messages",
                        "people",
                        "repayments",
                        "rule_changes",
                        "rules",
                        "transactions",
                        "data_transfers",
                        "receipts",
                        "workspace_settings",
                        "ledger_revision",
                        "attachments",
                        "merchant_aliases",
                        "split_templates",
                        "trips",
                        "assistant_events",
                        "assistant_requests",
                        "user_context",
                        "__drizzle_migrations",
                        "sqlite_sequence",
                    )
                require(
                    staged.rows("SELECT name FROM sqlite_master WHERE type='table'").all {
                        it.s("name") in known
                    }
                ) {
                    "Select a single expense workspace export."
                }
                require(
                    staged
                        .rows("SELECT name FROM sqlite_master WHERE type='table' AND name='people'")
                        .isNotEmpty()
                ) {
                    "This is not an expense workspace."
                }
                migrate(staged)
                val source = Ledger(staged)
                val canonical = AndroidDatabase(":memory:")
                try {
                    migrate(canonical)
                    val actual =
                        staged
                            .rows(
                                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                            )
                            .map { it.s("name") }
                            .toSet()
                    val expected =
                        canonical
                            .rows(
                                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                            )
                            .map { it.s("name") }
                            .toSet()
                    require(actual == expected) { "Workspace schema mismatch." }
                    expected.forEach { table ->
                        require(
                            staged.rows("PRAGMA table_info(\"$table\")").map {
                                listOf(it.s("name"), it.s("type"), it.n("notnull"), it.n("pk"))
                            } ==
                                canonical.rows("PRAGMA table_info(\"$table\")").map {
                                    listOf(it.s("name"), it.s("type"), it.n("notnull"), it.n("pk"))
                                }
                        ) {
                            "Incompatible table: $table"
                        }
                    }
                    fun objects(db: LedgerDatabase) =
                        db.rows(
                            "SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name!='__drizzle_migrations' ORDER BY type,name"
                        )
                    require(objects(staged) == objects(canonical)) {
                        "Workspace schema definitions do not match this app."
                    }
                } finally {
                    canonical.close()
                }
                require(staged.rows("PRAGMA foreign_key_check").isEmpty()) {
                    "Workspace contains broken references."
                }
                require(source.people().count { it.n("isSelf") == 1L && it.s("id") == "self" } == 1)
                source
                    .transactions()
                    .filter { it.s("state") == "finalized" }
                    .forEach { source.validateProposal(it, it.doc("proposal")) }
                return obj(
                    "people" to source.people().size,
                    "transactions" to source.transactions().size,
                    "trips" to source.all("SELECT id FROM trips").size,
                    "receipts" to source.all("SELECT id FROM attachments").size,
                    "outstandingCents" to source.dashboard().sumOf { it.outstandingCents },
                    "bytes" to stage.length(),
                )
            }
        } catch (e: Throwable) {
            stage.delete()
            throw e
        }
    }

    @Synchronized
    fun restore() {
        require(stage.exists()) { "Preview a workspace first." }
        recovery.delete()
        ledger.db.execute("VACUUM INTO ?", recovery.path)
        ledger.db.close()
        try {
            Files.move(
                stage.toPath(),
                live.toPath(),
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE,
            )
            File(live.path + "-wal").delete()
            File(live.path + "-shm").delete()
            ledger = open(live)
            ledger.db.execute("PRAGMA journal_mode=WAL")
            interruptJobs(ledger, "Imported unfinished job. Resume explicitly on this device.")
        } catch (e: Throwable) {
            runCatching { ledger.db.close() }
            File(live.path + "-wal").delete()
            File(live.path + "-shm").delete()
            Files.copy(recovery.toPath(), live.toPath(), StandardCopyOption.REPLACE_EXISTING)
            ledger = open(live)
            ledger.db.execute("PRAGMA journal_mode=WAL")
            throw e
        }
    }

    fun export(): File {
        val target =
            File(context.cacheDir, "exports/splitwise-ai-workspace.sqlite").apply {
                parentFile!!.mkdirs()
                delete()
            }
        ledger.db.execute("VACUUM INTO ?", target.path)
        return target
    }

    fun exportRecovery(): File {
        require(recovery.exists()) { "No previous workspace recovery copy." }
        return File(context.cacheDir, "exports/splitwise-ai-recovery.sqlite").apply {
            parentFile!!.mkdirs()
            recovery.copyTo(this, overwrite = true)
        }
    }

    fun discardPreview() {
        stage.delete()
    }
}
