export default function BrandMark({ className = "" }: { className?: string }) {
  return <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Super MD logo">
    <rect x="2" y="2" width="60" height="60" rx="18" fill="var(--surface-high)" />
    <path d="M18 13h23l8 8v31H18z" fill="var(--primary)" />
    <path d="M41 13v8h8M25 26h13M25 34h17M25 42h11" fill="none" stroke="var(--on-primary)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    <path d="m47 8 2 5 5 2-5 2-2 5-2-5-5-2 5-2z" fill="var(--primary)" />
  </svg>;
}
