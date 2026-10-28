import { SelectComputers } from './_components/select-computers';

/**
 * `/computers` — the "your computers" list. This is where every login
 * lands, full stop — there is no chat editor in this app to route to
 * instead.
 *
 * Carried/adapted from EBuilder's `apps/web/client/src/app/computers/page.tsx`
 * (authored post-Onlook-import, listed as safe to carry). The list layout
 * itself (`select-computers.tsx`) is written fresh: one computer per
 * person (round 3, D6), plus any older computer read-only.
 */
export default function Page() {
    return (
        <div className="flex h-screen w-screen flex-col overflow-y-auto bg-black text-offwhite">
            <SelectComputers />
        </div>
    );
}
