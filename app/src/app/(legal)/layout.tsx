import Link from 'next/link';
import Image from 'next/image';
import type { ReactNode } from 'react';

import styles from './legal.module.css';

export default function LegalLayout({ children }: { children: ReactNode }) {
    return (
        <div className={styles.shell}>
            <a className={styles.skipLink} href="#legal-content">Skip to content</a>
            <header className={styles.header}>
                <Link href="/login" prefetch={false} className={styles.brand} aria-label="EZiL OS — back to login">
                    <Image src="/favicon.ico" width={32} height={32} unoptimized alt="" className={styles.brandMark} />
                    EZiL <span className={styles.brandSuffix}>OS</span>
                </Link>
                <Link href="/login" prefetch={false} className={styles.backLink}>
                    <span aria-hidden="true">←</span> Back to login
                </Link>
            </header>
            {children}
            <footer className={styles.footer}>
                <p>EZiL OS <span aria-hidden="true">·</span> Hosted at os.ezil.org</p>
                <nav aria-label="Legal footer">
                    <Link href="/terms" prefetch={false}>Terms</Link>
                    <Link href="/privacy" prefetch={false}>Privacy</Link>
                    <a href="mailto:contact@ezil.work">Contact</a>
                </nav>
            </footer>
        </div>
    );
}
