import { getPricingContent, marketingContent as chrome } from '../pricing/pricing-content';
import styles from '../marketing.module.css';

/** The desktop is decorative: it demonstrates the workspace without booting a second app. */
function ProductFrame() {
    return (
        <div className={styles.desktop} aria-hidden="true">
            <div className={`${styles.window} ${styles.browser}`}>
                <div className={styles.windowTitle}><span className={styles.windowDots} />{chrome.desktop.browser}</div>
                <div className={styles.addressBar} />
                <div className={styles.browserPreview}>
                    <span className={styles.previewBlock} />
                    <span className={styles.skeleton} /><span className={styles.skeleton} />
                    <span className={styles.previewButton} />
                </div>
            </div>
            <div className={`${styles.window} ${styles.editor}`}>
                <div className={styles.windowTitle}><span className={styles.windowDots} />{chrome.desktop.editor}</div>
                <div className={styles.editorBody}>
                    <div className={styles.editorSidebar}><span /><span /><span /><span /></div>
                    <div className={styles.codeLines}><span /><span /><span /><span /><span /><span /></div>
                </div>
            </div>
            <div className={styles.taskbar}>
                <span className={styles.taskbarBrand}>{chrome.brand}</span>
                <span className={styles.appIcon}>◎</span><span className={styles.appIcon}>⌘</span><span className={styles.appIcon}>▱</span>
            </div>
        </div>
    );
}

/**
 * Both routes render one document. Native autofocus brings /pricing to its
 * plans without shipping a scrolling script; ordinary home visits keep the hero.
 */
export default function MarketingHome({ largeStorageEnabled, focusPlans = false }: {
    largeStorageEnabled: boolean;
    focusPlans?: boolean;
}) {
    const copy = getPricingContent(largeStorageEnabled);

    return (
        <div className={styles.shell}>
            <a className={styles.skipLink} href="#home-content">{chrome.skipLink}</a>
            <header className={styles.header}>
                <div className={styles.headerInner}>
                    <a href="/" className={styles.brand}>{chrome.brand}</a>
                    <nav aria-label={chrome.navigationLabel}>
                        <a href={chrome.plansLink.href} className={styles.plansLink}>{chrome.plansLink.label}</a>
                        <a href={chrome.signInLink.href}>{chrome.signInLink.label}</a>
                        <a href={chrome.startLink.href} className={styles.primary}>{chrome.startLink.label}</a>
                    </nav>
                </div>
            </header>
            <main id="home-content" tabIndex={-1} className={styles.main}>
                {!focusPlans && (
                    <>
                <section className={styles.hero} data-testid="home-hero" aria-labelledby="home-title">
                        <p className={styles.pill}>{copy.hero.eyebrow}</p>
                        <h1 id="home-title">{copy.hero.title}</h1>
                        <p className={styles.description}>{copy.hero.description}</p>
                        <div className={styles.heroActions}>
                            <a data-testid="cta-start-free" className={styles.primary} href={chrome.startLink.href}>{chrome.startLink.label}</a>
                            <a data-testid="cta-sign-in" className={styles.outline} href={chrome.signInLink.href}>{chrome.signInLink.label}</a>
                        </div>
                        <p className={styles.caption}>{copy.hero.caption}</p>
                    </section>
                    <ProductFrame />
                    <section className={styles.features} aria-label={chrome.featuresLabel}>
                        {chrome.features.map((feature, index) => (
                            <div className={styles.feature} key={feature.title}>
                                <span className={styles.icon} aria-hidden="true">{['▣', '⌘', '✦'][index]}</span>
                                <h2>{feature.title}</h2>
                                {'description' in feature && <p>{feature.description}</p>}
                                {'badge' in feature && <p className={styles.pill}>{feature.badge}</p>}
                            </div>
                        ))}
                    </section>
                    </>
                )}
                {/* /pricing is plans-first: no hero above the cards, so the plans are
                    in view on load without any scrolling script. */}
                <section id="plans" className={styles.section} aria-labelledby="plans-title">
                    {focusPlans
                        ? <h1 id="plans-title">{copy.plansLabel}</h1>
                        : <h2 id="plans-title">{copy.plansLabel}</h2>}
                    <div className={styles.plans}>
                        {copy.plans.map(plan => (
                            <article key={plan.id} data-testid={`plan-${plan.id}`} className={`${styles.card} ${plan.id === 'pro' ? styles.pro : ''}`} aria-labelledby={`plan-${plan.id}-title`}>
                                <div className={styles.cardHeading}>
                                    <h3 id={`plan-${plan.id}-title`}>{plan.name}</h3>
                                    {plan.badge && <span className={styles.pill}>{plan.badge}</span>}
                                </div>
                                <p className={styles.price}>{plan.price}<span>{plan.interval}</span></p>
                                <p className={styles.caption}>{plan.billingNote}</p>
                                <a data-testid={plan.id === 'pro' ? 'cta-get-pro' : undefined} className={plan.id === 'pro' ? styles.primary : styles.outline} href={plan.cta.href}>{plan.cta.label}</a>
                                <dl className={styles.allowances}>
                                    {plan.allowances.map(allowance => (
                                        <div key={allowance.id} className={styles.allowance} data-testid={`allowance-${plan.id}-${allowance.id}`}>
                                            <dt>{allowance.label}</dt>
                                            <dd><strong>{allowance.value}</strong> <span>{allowance.unit}</span><small>{allowance.caption}</small></dd>
                                        </div>
                                    ))}
                                </dl>
                            </article>
                        ))}
                    </div>
                    <p className={styles.sharedNote}>{copy.sharedNote}</p>
                </section>
                <section className={styles.topUps} aria-labelledby="top-ups-title">
                    <h2 id="top-ups-title">{copy.topUps.title}</h2>
                    <p className={styles.pill}>{copy.topUps.note}</p>
                </section>
                <section className={styles.section} aria-labelledby="limits-title">
                    <h2 id="limits-title">{copy.limits.title}</h2>
                    <dl className={styles.limits}>
                        {copy.limits.rows.map((row, index) => (
                            <div key={row.label}>
                                <span className={styles.icon} aria-hidden="true">{['◷', '▱', '✦'][index]}</span>
                                <dt>{row.label}</dt><dd>{row.value}</dd>
                            </div>
                        ))}
                    </dl>
                </section>
                <section className={styles.section} aria-labelledby="faq-title">
                    <h2 id="faq-title">{copy.faq.title}</h2>
                    {copy.faq.items.map(item => (
                        // Open questions rather than <details>: six short answers read
                        // faster on one screen, and Chromium exposes <summary> only as
                        // text to assistive technology (found by e2e/billing-home.mjs).
                        <div key={item.question} className={styles.faq}>
                            <h3>{item.question}</h3><p>{item.answer}</p>
                        </div>
                    ))}
                </section>
                <section className={styles.closing} aria-labelledby="closing-title">
                    <h2 id="closing-title">{chrome.closing}</h2>
                    <a className={styles.primary} href={chrome.startLink.href}>{chrome.startLink.label}</a>
                </section>
            </main>
            <footer className={styles.footer}>
                <p>{chrome.seller}</p>
                <nav aria-label={chrome.footerLabel}>
                    {chrome.links.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}
                </nav>
            </footer>
        </div>
    );
}
