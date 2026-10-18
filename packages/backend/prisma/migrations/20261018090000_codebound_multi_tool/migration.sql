-- CODEBOUND persistence tracking issue #1. Additive; no data reset or secret rotation.
BEGIN;
ALTER TABLE "codebound_scripts" ADD COLUMN "additional_bindings" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "codebound_scripts" ADD CONSTRAINT "codebound_additional_bindings_check" CHECK (
  jsonb_typeof(additional_bindings) = 'array'
  AND jsonb_array_length(additional_bindings) <= 7
  AND octet_length(additional_bindings::text) <= 4096
);
ALTER TABLE "codebound_script_runs" DROP CONSTRAINT "codebound_run_bounds_check";
ALTER TABLE "codebound_script_runs" ADD CONSTRAINT "codebound_run_bounds_check" CHECK (
  revision >= 1 AND source_sha256 ~ '^[a-f0-9]{64}$'
  AND wall_time_ms BETWEEN 0 AND 86400000 AND connector_calls BETWEEN 0 AND 128
  AND connector_response_bytes BETWEEN 0 AND 8388608 AND output_bytes BETWEEN 0 AND 16384
  AND owner_user_id = caller_user_id
  AND (finished_at IS NULL OR finished_at >= started_at)
  AND (error_message IS NULL OR octet_length(error_message) BETWEEN 1 AND 512)
);
COMMIT;
