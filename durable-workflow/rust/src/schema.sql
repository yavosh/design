CREATE TABLE IF NOT EXISTS draft (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, base INTEGER NOT NULL, spec TEXT NOT NULL,
 author TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'EDITING'
 CHECK(status IN ('EDITING','SUBMITTED','APPROVED','REJECTED')),
 reviewer TEXT, published INTEGER, CHECK(reviewer IS NULL OR reviewer<>author)
) STRICT;
CREATE TABLE IF NOT EXISTS definition (
 name TEXT NOT NULL, version INTEGER NOT NULL, spec TEXT NOT NULL,
 valid_from INTEGER NOT NULL, valid_until INTEGER CHECK(valid_until>valid_from),
 PRIMARY KEY(name,version)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS current_version ON definition(name) WHERE valid_until IS NULL;
CREATE TRIGGER IF NOT EXISTS immutable_definition BEFORE UPDATE ON definition
WHEN OLD.valid_until IS NOT NULL OR NEW.valid_until IS NULL OR NEW.name<>OLD.name
 OR NEW.version<>OLD.version OR NEW.spec<>OLD.spec OR NEW.valid_from<>OLD.valid_from
BEGIN SELECT raise(ABORT,'published definition is immutable'); END;
CREATE TRIGGER IF NOT EXISTS keep_definition BEFORE DELETE ON definition
BEGIN SELECT raise(ABORT,'published definition is immutable'); END;
CREATE TABLE IF NOT EXISTS instance (
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL, entity TEXT NOT NULL,
 name TEXT NOT NULL, version INTEGER NOT NULL, selected_by TEXT NOT NULL, selection_inputs TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('ACTIVE','COMPLETED','FAILED')), current_step TEXT NOT NULL,
 started_at INTEGER NOT NULL, last_progress_at INTEGER NOT NULL, completed_at INTEGER, failure_reason TEXT,
 CHECK(status<>'FAILED' OR length(coalesce(failure_reason,''))>0),
 FOREIGN KEY(name,version) REFERENCES definition(name,version)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS start_request_key ON instance(json_extract(selection_inputs,'$.requestKey'))
 WHERE json_extract(selection_inputs,'$.requestKey') IS NOT NULL;
CREATE TABLE IF NOT EXISTS execution (
 instance INTEGER NOT NULL REFERENCES instance(id), step TEXT NOT NULL, stage TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('PENDING','RUNNING','PARKED','COMPLETED','FAILED')),
 attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK(max_attempts>0),
 max_duration INTEGER NOT NULL CHECK(max_duration>0), dispatch_count INTEGER NOT NULL DEFAULT 0,
 defer_count INTEGER NOT NULL DEFAULT 0, next_at INTEGER, input_data TEXT NOT NULL,
 last_outcome TEXT, last_error TEXT,
 CHECK((next_at IS NULL)=(status IN ('COMPLETED','FAILED'))), PRIMARY KEY(instance,step)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS one_live_step ON execution(instance) WHERE next_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS due_steps ON execution(stage,next_at) WHERE next_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS audit (
 seq INTEGER PRIMARY KEY, at INTEGER NOT NULL DEFAULT(unixepoch()), instance INTEGER NOT NULL REFERENCES instance(id),
 step TEXT NOT NULL, status TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL,
 attempts INTEGER NOT NULL, dispatch INTEGER NOT NULL, default_target TEXT, target TEXT,
 was_override INTEGER NOT NULL DEFAULT 0, reason TEXT,
 CHECK(was_override=0 OR length(trim(coalesce(reason,'')))>0)
) STRICT;
CREATE TRIGGER IF NOT EXISTS immutable_audit BEFORE UPDATE ON audit
BEGIN SELECT raise(ABORT,'audit is append only'); END;
CREATE TRIGGER IF NOT EXISTS keep_audit BEFORE DELETE ON audit
BEGIN SELECT raise(ABORT,'audit is append only'); END;
CREATE TABLE IF NOT EXISTS worker (
 id TEXT PRIMARY KEY, stages TEXT NOT NULL, delivers INTEGER NOT NULL, expires INTEGER NOT NULL
) STRICT;
