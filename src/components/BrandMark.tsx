export default function BrandMark({ className = "" }: { className?: string }) {
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Super MD logo">
    <rect x="2" y="2" width="60" height="60" rx="19" fill="var(--primary)" />
    <path d="M15 44V20c0-2 2.3-3.1 3.9-1.6L32 31l13.1-12.6c1.6-1.5 3.9-.4 3.9 1.6v24" fill="none" stroke="var(--on-primary)" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="32" cy="45" r="3.2" fill="var(--on-primary)" />
  </svg>;
}
