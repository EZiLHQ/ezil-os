import type { Viewport } from 'next';
import type { ReactNode } from 'react';

/** Marketing is a scrolling document, independent of the desktop keyboard policy. */
export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    interactiveWidget: 'resizes-content',
};

/** The shared home component owns its chrome on both public entry routes. */
export default function MarketingLayout({ children }: { children: ReactNode }) {
    return children;
}
