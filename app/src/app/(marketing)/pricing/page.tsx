import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { readBillingConfig } from '@/server/billing/config';
import { getPricingContent, pricingMetadata } from './pricing-content';
import styles from '../marketing.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = pricingMetadata;

export default function PricingPage() {
    if (!readBillingConfig().pricingPageEnabled) notFound();
    const copy = getPricingContent(readBillingConfig().largeStorageEnabled);

    return (
        <main id="pricing-content" tabIndex={-1} className={styles.main}>
            <section className={styles.intro} aria-labelledby="pricing-title">
                <h1 id="pricing-title">{copy.hero.title}</h1>
                <p className={styles.description}>{copy.hero.description}</p>
            </section>

            <section className={styles.plans} aria-label={copy.plansLabel}>
                {copy.plans.map(plan => (
                    <article key={plan.id} className={styles.card} aria-labelledby={`plan-${plan.id}`}>
                        <h2 id={`plan-${plan.id}`}>{plan.name}</h2>
                        <p className={styles.price}>{plan.price}</p>
                        {plan.billingNote && <p className={styles.note}>{plan.billingNote}</p>}
                        <p>{plan.description}</p>
                        <dl className={styles.rows}>
                            {plan.rows.map(row => (
                                <div key={row.label}>
                                    <dt>{row.label}</dt>
                                    <dd>{row.value}{row.note && <span className={styles.rowNote}>{row.note}</span>}</dd>
                                </div>
                            ))}
                        </dl>
                        <p className={styles.note}>{plan.sharedNote}</p>
                        <div className={styles.cardAction}>
                            <a className={styles.cta} href={plan.cta.href}>{plan.cta.label}</a>
                            {plan.ctaNote && <p className={styles.note}>{plan.ctaNote}</p>}
                        </div>
                    </article>
                ))}
            </section>

            <section className={styles.section} aria-labelledby="top-ups-title">
                <h2 id="top-ups-title">{copy.topUps.title}</h2>
                <ul className={styles.packs}>
                    {copy.topUps.packs.map(pack => <li key={pack}>{pack}</li>)}
                </ul>
                <p className={styles.note}>{copy.topUps.note}</p>
            </section>

            <section className={styles.section} aria-labelledby="limits-title">
                <h2 id="limits-title">{copy.limits.title}</h2>
                <dl className={styles.rows}>
                    {copy.limits.rows.map(row => (
                        <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>
                    ))}
                </dl>
            </section>

            <section className={styles.section} aria-labelledby="faq-title">
                <h2 id="faq-title">{copy.faq.title}</h2>
                {copy.faq.items.map(item => (
                    <details key={item.question} className={styles.faq}>
                        <summary>{item.question}</summary>
                        <p>{item.answer}</p>
                    </details>
                ))}
            </section>
        </main>
    );
}
