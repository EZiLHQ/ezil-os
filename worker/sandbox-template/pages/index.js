export default function Home() {
  return (
    <main
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        maxWidth: 640,
        margin: '10vh auto',
        padding: '0 1.5rem',
        lineHeight: 1.6,
      }}
    >
      <h1>This is your computer.</h1>
      <p>
        You&rsquo;re looking at a running Next.js dev server, edited live from
        the VS Code window next to this one. Open{' '}
        <code>pages/index.js</code> and save &mdash; this page updates
        immediately.
      </p>
      <p>Everything you write here persists. Start building.</p>
    </main>
  );
}
