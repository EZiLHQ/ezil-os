import Image from 'next/image';
import type { Viewport } from 'next';
import type { ReactNode } from 'react';

import { marketingContent as copy } from './pricing/pricing-content';
import styles from './marketing.module.css';

/** Marketing is a scrolling document, independent of the desktop keyboard policy. */
export const viewport: Viewport = {
    width: 'device-width',
    initialScale: 1,
    interactiveWidget: 'resizes-content',
};

export default function MarketingLayout({ children }: { children: ReactNode }) {
    return (
        <div className={styles.shell}>
            <a className={styles.skipLink} href="#pricing-content">{copy.skipLink}</a>
            <header className={styles.header}>
                <a href={copy.backLink.href} className={styles.brand} aria-label={copy.brandLabel}>
                    <Image src="/favicon.ico" width={32} height={32} unoptimized alt="" className={styles.brandMark} />
                    {copy.brand} <span className={styles.brandSuffix}>{copy.brandSuffix}</span>
                </a>
                <a href={copy.backLink.href} className={styles.backLink}>
                    <span aria-hidden="true">←</span> {copy.backLink.label}
                </a>
            </header>
            {children}
            <footer className={styles.footer}>
                <p>{copy.seller}</p>
                <nav aria-label={copy.footerLabel}>
                    {copy.links.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}
                </nav>
            </footer>
        </div>
    );
}
