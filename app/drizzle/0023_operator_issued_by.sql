-- Product entitlements v1, producer ezil-os: the optional issuing-organization name of an operator assignment, shown
-- on the Billing plan card as "Assigned by <name>". Additive and backward compatible: existing rows stay NULL and
-- read as EZiL; the app reads the column through to_jsonb, so it works before and after this file is applied, and
-- only a command that names an organization writes it. The value is exactly the signed command's `issued_by`:
-- 1-80 code points, no control (U+0001-U+001F, U+007F-U+009F; NUL cannot occur in text), Arabic letter mark,
-- zero-width, separator, bidi or BOM character, and no leading or trailing whitespace (the JavaScript
-- String.prototype.trim set, less the characters already refused). Never part of `reason`.

ALTER TABLE public.ezil_operator_entitlements ADD COLUMN IF NOT EXISTS issued_by text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ezil_operator_entitlements_issued_by'
            AND conrelid = 'public.ezil_operator_entitlements'::regclass) THEN
        ALTER TABLE public.ezil_operator_entitlements ADD CONSTRAINT ezil_operator_entitlements_issued_by CHECK (issued_by IS NULL OR (
            char_length(issued_by) BETWEEN 1 AND 80
            AND issued_by !~ '[\u0001-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]'
            AND issued_by !~ '^[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]'
            AND issued_by !~ '[\u0020\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]$'));
    END IF;
END;
$$;
