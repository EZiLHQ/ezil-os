import Link from 'next/link';
import type { ReactNode } from 'react';

import styles from './legal.module.css';

export interface LegalSection {
    id: string;
    title: string;
    content: ReactNode;
}

export function OperatorContact() {
    return (
        <address>
            EZiL LLC<br />
            30 N Gould St STE R<br />
            Sheridan, WY 82801, USA<br />
            <a href="mailto:contact@ezil.work">contact@ezil.work</a>
        </address>
    );
}

export function LegalDocument({
    kind, title, introduction, summary, sections,
}: {
    kind: 'terms' | 'privacy' | 'refunds';
    title: string;
    introduction: string;
    summary: ReactNode;
    sections: readonly LegalSection[];
}) {
    return (
        <main id="legal-content" tabIndex={-1} className={styles.main}>
            <div className={styles.intro}>
                <nav className={styles.tabs} aria-label="Legal documents">
                    <Link href="/terms" prefetch={false} aria-current={kind === 'terms' ? 'page' : undefined}>Terms and Conditions</Link>
                    <Link href="/privacy" prefetch={false} aria-current={kind === 'privacy' ? 'page' : undefined}>Privacy Policy</Link>
                    <Link href="/refunds" prefetch={false} aria-current={kind === 'refunds' ? 'page' : undefined}>Refunds</Link>
                </nav>
                <p className={styles.eyebrow}>EZiL OS / Hosted service</p>
                <h1>{title}</h1>
                <p className={styles.description}>{introduction}</p>
                <p className={styles.date}>Effective <time dateTime="2026-10-11">11 October 2026</time> <span aria-hidden="true">·</span> os.ezil.org</p>
            </div>
            <div className={styles.documentGrid}>
                <nav className={styles.contents} aria-labelledby="contents-title">
                    <h2 id="contents-title">On this page</h2>
                    <ol>
                        {sections.map((section) => (
                            <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>
                        ))}
                    </ol>
                </nav>
                <article className={styles.article} aria-label={title}>
                    <div className={styles.summary}>{summary}</div>
                    {sections.map((section, index) => (
                        <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`}>
                            <h2 id={`${section.id}-title`}>
                                <span className={styles.sectionNumber} aria-hidden="true">{String(index + 1).padStart(2, '0')}</span>
                                {section.title}
                            </h2>
                            {section.content}
                        </section>
                    ))}
                    <a className={styles.topLink} href="#legal-content">Back to top <span aria-hidden="true">↑</span></a>
                </article>
            </div>
        </main>
    );
}
