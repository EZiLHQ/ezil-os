import { SelectComputers } from './_components/select-computers';

/**
 * `/computers` — the "your computers" list. This is where every login
 * lands, full stop — there is no chat editor in this app to route to
 * instead.
 *
 * Carried/adapted from EBuilder's `apps/web/client/src/app/computers/page.tsx`
 * (authored post-Onlook-import, listed as safe to carry). The list layout
 * itself (`select-computers.tsx`) is written fresh per this repo's own
 * design decision: a fixed-length list of rows instead of a variable-N
 * grid of cards, since the cap here is a firm 2.
 */
export default function Page() {
    return (
        <div className="flex h-screen w-screen flex-col overflow-y-auto bg-black text-offwhite">
            <SelectComputers />
        </div>
    );
}
