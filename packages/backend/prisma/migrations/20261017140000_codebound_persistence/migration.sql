-- Keep partial DDL from surviving a failed Prisma deployment.
BEGIN;

-- CreateEnum
-- CODEBOUND Phase A, tracking issue #1. Additive migration; existing rows untouched.
CREATE TYPE "CodeboundRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "codebound_scripts" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "description" VARCHAR(1024) NOT NULL,
    "source" TEXT NOT NULL,
    "source_sha256" VARCHAR(64) NOT NULL,
    "input_schema" JSONB NOT NULL,
    "output_schema" JSONB NOT NULL,
    "connector_id" TEXT NOT NULL,
    "tool_id" TEXT NOT NULL,
    "definition_sha256" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "codebound_scripts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "codebound_script_runs" (
    "execution_id" VARCHAR(128) NOT NULL,
    "organization_id" TEXT NOT NULL,
    "owner_user_id" TEXT NOT NULL,
    "caller_user_id" TEXT NOT NULL,
    "original_script_id" VARCHAR(128) NOT NULL,
    "script_id" TEXT,
    "script_organization_id" TEXT,
    "script_owner_user_id" TEXT,
    "revision" INTEGER NOT NULL,
    "source_sha256" VARCHAR(64) NOT NULL,
    "status" "CodeboundRunStatus" NOT NULL DEFAULT 'RUNNING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "wall_time_ms" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "connector_calls" INTEGER NOT NULL DEFAULT 0,
    "connector_response_bytes" INTEGER NOT NULL DEFAULT 0,
    "output_bytes" INTEGER NOT NULL DEFAULT 0,
    "error_code" VARCHAR(32),
    "error_message" VARCHAR(512),
    "error_limit" VARCHAR(32),

    CONSTRAINT "codebound_script_runs_pkey" PRIMARY KEY ("execution_id")
);

-- CreateIndex
CREATE INDEX "codebound_scripts_organization_id_owner_user_id_id_idx" ON "codebound_scripts"("organization_id", "owner_user_id", "id");

-- CreateIndex
CREATE INDEX "codebound_scripts_connector_id_idx" ON "codebound_scripts"("connector_id");

-- CreateIndex
CREATE INDEX "codebound_scripts_tool_id_connector_id_idx" ON "codebound_scripts"("tool_id", "connector_id");

-- CreateIndex
CREATE UNIQUE INDEX "codebound_scripts_id_organization_id_owner_user_id_key" ON "codebound_scripts"("id", "organization_id", "owner_user_id");

-- CreateIndex
CREATE INDEX "codebound_script_runs_organization_id_owner_user_id_created_idx" ON "codebound_script_runs"("organization_id", "owner_user_id", "created_at");

-- CreateIndex
CREATE INDEX "codebound_script_runs_script_id_script_organization_id_scri_idx" ON "codebound_script_runs"("script_id", "script_organization_id", "script_owner_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "connectors_id_organization_id_user_id_key" ON "connectors"("id", "organization_id", "user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tools_id_connector_id_key" ON "mcp_tools"("id", "connector_id");

-- AddForeignKey
ALTER TABLE "codebound_scripts" ADD CONSTRAINT "codebound_scripts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codebound_scripts" ADD CONSTRAINT "codebound_scripts_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codebound_scripts" ADD CONSTRAINT "codebound_scripts_connector_id_organization_id_owner_user__fkey" FOREIGN KEY ("connector_id", "organization_id", "owner_user_id") REFERENCES "connectors"("id", "organization_id", "user_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "codebound_scripts" ADD CONSTRAINT "codebound_scripts_tool_id_connector_id_fkey" FOREIGN KEY ("tool_id", "connector_id") REFERENCES "mcp_tools"("id", "connector_id") ON DELETE CASCADE ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "codebound_script_runs" ADD CONSTRAINT "codebound_script_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codebound_script_runs" ADD CONSTRAINT "codebound_script_runs_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codebound_script_runs" ADD CONSTRAINT "codebound_script_runs_caller_user_id_fkey" FOREIGN KEY ("caller_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "codebound_script_runs" ADD CONSTRAINT "codebound_script_runs_script_id_script_organization_id_scr_fkey" FOREIGN KEY ("script_id", "script_organization_id", "script_owner_user_id") REFERENCES "codebound_scripts"("id", "organization_id", "owner_user_id") ON DELETE SET NULL ON UPDATE RESTRICT;

-- Prisma does not express CHECK constraints or immutable-receipt triggers.
ALTER TABLE "codebound_scripts" ADD CONSTRAINT "codebound_script_content_check" CHECK (
    revision >= 1 AND octet_length(source) BETWEEN 1 AND 32768
    AND source_sha256 = encode(sha256(convert_to(source, 'UTF8')), 'hex')
    AND definition_sha256 ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof(input_schema) = 'object' AND jsonb_typeof(output_schema) = 'object'
    -- jsonb::text includes whitespace; service validators enforce compact 16 KiB.
    AND octet_length(input_schema::text) <= 32768 AND octet_length(output_schema::text) <= 32768
);

ALTER TABLE "codebound_script_runs" ADD CONSTRAINT "codebound_run_bounds_check" CHECK (
    revision >= 1 AND source_sha256 ~ '^[a-f0-9]{64}$'
    AND wall_time_ms BETWEEN 0 AND 86400000 AND connector_calls BETWEEN 0 AND 1
    AND connector_response_bytes BETWEEN 0 AND 524288 AND output_bytes BETWEEN 0 AND 16384
    AND owner_user_id = caller_user_id
    AND (finished_at IS NULL OR finished_at >= started_at)
    AND (error_message IS NULL OR octet_length(error_message) BETWEEN 1 AND 512)
);
ALTER TABLE "codebound_script_runs" ADD CONSTRAINT "codebound_run_link_check" CHECK (
    (script_id IS NULL AND script_organization_id IS NULL AND script_owner_user_id IS NULL)
    OR (script_id IS NOT NULL AND script_organization_id IS NOT NULL AND script_owner_user_id IS NOT NULL
        AND script_id = original_script_id AND script_organization_id = organization_id AND script_owner_user_id = owner_user_id)
);
ALTER TABLE "codebound_script_runs" ADD CONSTRAINT "codebound_run_state_check" CHECK (
    (status = 'RUNNING' AND finished_at IS NULL AND error_code IS NULL AND error_message IS NULL
        AND error_limit IS NULL AND wall_time_ms = 0 AND connector_calls = 0 AND connector_response_bytes = 0 AND output_bytes = 0)
    OR (status = 'SUCCEEDED' AND finished_at IS NOT NULL AND error_code IS NULL AND error_message IS NULL AND error_limit IS NULL)
    OR (status IN ('FAILED', 'CANCELLED') AND finished_at IS NOT NULL AND error_code IS NOT NULL AND error_message IS NOT NULL
        AND (status <> 'CANCELLED' OR error_code = 'CANCELLED')
        AND error_message = CASE error_code
            WHEN 'INVALID_INPUT' THEN 'Invalid persistence request'
            WHEN 'NOT_FOUND' THEN 'Script or receipt not found'
            WHEN 'FORBIDDEN' THEN 'Script access denied'
            WHEN 'VERSION_CONFLICT' THEN 'Revision or execution state changed'
            WHEN 'SCRIPT_ERROR' THEN 'Script execution failed'
            WHEN 'CONNECTOR_ERROR' THEN 'Connector operation failed'
            WHEN 'INVALID_OUTPUT' THEN 'Invalid script output'
            WHEN 'RESOURCE_LIMIT' THEN 'Execution limit exceeded'
            WHEN 'CANCELLED' THEN 'Execution cancelled'
            WHEN 'SANDBOX_UNAVAILABLE' THEN 'Isolated execution unavailable'
            WHEN 'INTERNAL_ERROR' THEN 'Persistence operation failed'
            ELSE '' END
        AND ((error_code = 'RESOURCE_LIMIT' AND error_limit IS NOT NULL AND error_limit IN (
            'wallTime','memory','processes','sourceBytes','inputBytes','outputBytes','ipcFrameBytes',
            'connectorCalls','connectorResponseBytes','logBytes')) OR (error_code <> 'RESOURCE_LIMIT' AND error_limit IS NULL)))
);

CREATE FUNCTION codebound_guard_run_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.script_id IS NULL OR NEW.status <> 'RUNNING' OR NOT EXISTS (
            SELECT 1 FROM codebound_scripts s WHERE s.id = NEW.script_id
            AND s.organization_id = NEW.organization_id AND s.owner_user_id = NEW.owner_user_id
            AND s.revision = NEW.revision AND s.source_sha256 = NEW.source_sha256
        ) THEN
            RAISE EXCEPTION 'Invalid initial CODEBOUND receipt' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;
    IF ROW(NEW.execution_id, NEW.organization_id, NEW.owner_user_id, NEW.caller_user_id,
           NEW.original_script_id, NEW.revision, NEW.source_sha256, NEW.created_at, NEW.started_at)
       IS DISTINCT FROM ROW(OLD.execution_id, OLD.organization_id, OLD.owner_user_id, OLD.caller_user_id,
           OLD.original_script_id, OLD.revision, OLD.source_sha256, OLD.created_at, OLD.started_at) THEN
        RAISE EXCEPTION 'Immutable CODEBOUND receipt' USING ERRCODE = '23514';
    END IF;
    IF NEW.script_id IS DISTINCT FROM OLD.script_id AND NOT (OLD.script_id IS NOT NULL AND NEW.script_id IS NULL) THEN
        RAISE EXCEPTION 'Cannot rebind CODEBOUND receipt' USING ERRCODE = '23514';
    END IF;
    -- A nullable FK is for deletion retention, not an editable history link.
    -- The parent row is already gone when ON DELETE SET NULL fires.
    IF OLD.script_id IS NOT NULL AND NEW.script_id IS NULL AND EXISTS (
        SELECT 1 FROM codebound_scripts s WHERE s.id = OLD.script_id
        AND s.organization_id = OLD.organization_id AND s.owner_user_id = OLD.owner_user_id
    ) THEN
        RAISE EXCEPTION 'Cannot unlink a live CODEBOUND script' USING ERRCODE = '23514';
    END IF;
    IF OLD.status <> 'RUNNING' AND ROW(NEW.status, NEW.finished_at, NEW.wall_time_ms, NEW.connector_calls,
        NEW.connector_response_bytes, NEW.output_bytes, NEW.error_code, NEW.error_message, NEW.error_limit)
       IS DISTINCT FROM ROW(OLD.status, OLD.finished_at, OLD.wall_time_ms, OLD.connector_calls,
        OLD.connector_response_bytes, OLD.output_bytes, OLD.error_code, OLD.error_message, OLD.error_limit) THEN
        RAISE EXCEPTION 'Terminal CODEBOUND receipt' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER codebound_run_receipt_guard BEFORE INSERT OR UPDATE ON "codebound_script_runs"
FOR EACH ROW EXECUTE FUNCTION codebound_guard_run_receipt();

COMMIT;
