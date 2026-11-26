-- Product entitlements v1, producer ezil-os: explicit EZiL OS access overrides. An override is a signed operator assign
-- with access_override: true (change and end restate it). It has its own live slot beside the ordinary grant, may set Free as well as Standard or Premium, and while unexpired it
-- decides EZiL OS access ahead of Stripe (explicit override > valid Stripe > ordinary grant > Free). Administrative
-- access only: no Stripe, invoice, AI-credit or runtime write. Additive and backward compatible: every existing row is
-- an ordinary grant (false); the app reads the column through to_jsonb, so it works before and after this file, and
-- the catalog advertises overrides only once the last object below exists. Keep this schema on image rollback.

ALTER TABLE public.ezil_operator_entitlements ADD COLUMN IF NOT EXISTS access_override boolean NOT NULL DEFAULT false;

-- Free only on an override; an ordinary grant stays Standard or Premium. This replaces 0019's inline sku CHECK, whose
-- name Postgres chose: it is found as the CHECK on the sku column alone, and dropped once the named one is in place.
DO $$
DECLARE
    legacy text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ezil_operator_entitlements_sku_kind'
            AND conrelid = 'public.ezil_operator_entitlements'::regclass) THEN
        ALTER TABLE public.ezil_operator_entitlements ADD CONSTRAINT ezil_operator_entitlements_sku_kind CHECK (
            sku IN ('standard_monthly_v3', 'premium_monthly_v3') OR (access_override AND sku = 'free_v3'));
    END IF;
    FOR legacy IN SELECT k.conname FROM pg_constraint k JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attname = 'sku'
            WHERE k.conrelid = 'public.ezil_operator_entitlements'::regclass AND k.contype = 'c'
            AND k.conname <> 'ezil_operator_entitlements_sku_kind' AND k.conkey = ARRAY[a.attnum]::smallint[] LOOP
        EXECUTE format('ALTER TABLE public.ezil_operator_entitlements DROP CONSTRAINT %I', legacy);
    END LOOP;
END;
$$;

-- One live (not ended) row per account per kind: an ordinary grant and an override are independent slots.
CREATE UNIQUE INDEX IF NOT EXISTS ezil_operator_entitlements_one_live_grant
    ON public.ezil_operator_entitlements (user_id) WHERE ended_at IS NULL AND access_override = false;
DROP INDEX IF EXISTS public.ezil_operator_entitlements_one_live;
-- Last on purpose: its presence is the app's "overrides installed" probe (entitlements/operator/installed.ts).
CREATE UNIQUE INDEX IF NOT EXISTS ezil_operator_entitlements_one_live_override
    ON public.ezil_operator_entitlements (user_id) WHERE ended_at IS NULL AND access_override = true;
