ALTER TABLE "ezil_computer_runtimes" ADD COLUMN "data_filesystem_uuid" uuid;--> statement-breakpoint
ALTER TABLE "ezil_computer_runtimes" ADD CONSTRAINT "ezil_computer_runtimes_filesystem_uq" UNIQUE("data_filesystem_uuid");
--> statement-breakpoint
-- Do not backfill an existing disk with a newly invented filesystem identity.
-- New unallocated computers reserve their UUID before any volume is created.
-- A retained/imported disk remains NULL until its actual UUID is verified by
-- trusted provisioning. This identifier never grants permission to format.
CREATE FUNCTION public.ezil_computer_filesystem_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.data_volume_id IS NULL AND NEW.data_filesystem_uuid IS NULL THEN
            NEW.data_filesystem_uuid := gen_random_uuid();
        END IF;
    ELSE
        IF NEW.computer_id IS DISTINCT FROM OLD.computer_id
            OR (OLD.data_filesystem_uuid IS NOT NULL
                AND NEW.data_filesystem_uuid IS DISTINCT FROM OLD.data_filesystem_uuid) THEN
            RAISE EXCEPTION 'computer filesystem identity is immutable' USING ERRCODE='23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ezil_computer_filesystem_identity_guard
    BEFORE INSERT OR UPDATE ON public.ezil_computer_runtimes
    FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_filesystem_identity();
