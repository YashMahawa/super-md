export default function BrandMark({ className = "" }: { className?: string }) {
  // Monochrome "S" with the Markdown down-arrow, inked in the current theme.
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Super MD logo">
    <rect x="2" y="2" width="60" height="60" rx="18" fill="var(--text)" />
    <path d="M34.5 18.6A9.8 9.3 0 1 0 25.3 32.4A9.8 9.3 0 1 1 16 47" fill="none" stroke="var(--surface)" strokeWidth="7" strokeLinecap="round" />
    <path d="M46.5 16V48.5M39.5 41.5L46.5 48.5L53.5 41.5" fill="none" stroke="var(--surface)" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>;
}
