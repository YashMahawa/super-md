import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, FilePdf, FolderOpen, Sparkle } from "@phosphor-icons/react";
import type { ThemeMode } from "../types";

interface Props {
  theme: ThemeMode;
  onTheme: (theme: ThemeMode) => void;
  readerFont: string;
  onReaderFont: (font: string) => void;
  motionEnabled: boolean;
  onMotion: (enabled: boolean) => void;
  onFinish: (openFile: boolean) => void;
}

const pages = [
  { eyebrow: "A better place to think", title: "Welcome to Super MD", description: "Beautiful notes, living diagrams, and PDFs that are actually typeset. Your files stay ordinary and portable—no vault required.", icon: BookOpen },
  { eyebrow: "Make it yours", title: "Set your reading mood", description: "Choose a look that feels right. Your fullscreen theme can be set separately in Settings whenever you like.", icon: Sparkle },
  { eyebrow: "Ready when you are", title: "Start with a clear page", description: "Open an existing Markdown or Obsidian note, or begin with the guided sample. Export later with Pandoc and Typst, not a screenshot of the screen.", icon: FilePdf },
];

export default function WelcomeSetup({ theme, onTheme, readerFont, onReaderFont, motionEnabled, onMotion, onFinish }: Props) {
  const [page, setPage] = useState(0);
  const item = pages[page];
  const Icon = item.icon;
  return <div className="welcome-scrim" role="dialog" aria-modal="true" aria-label="Welcome to Super MD">
    <div className="welcome-card">
      <div className="welcome-art"><img src="/brand-mark.svg" alt="Super MD" /><div className="welcome-orbit orbit-one" /><div className="welcome-orbit orbit-two" /></div>
      <div className="welcome-body">
        <div className="welcome-progress" aria-label={`Setup step ${page + 1} of 3`}>{pages.map((_, index) => <span key={index} className={index === page ? "active" : ""} />)}</div>
        <AnimatePresence mode="wait"><motion.div key={page} initial={{ opacity: 0, y: 12, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -9, scale: .98 }} transition={{ type: "spring", stiffness: 360, damping: 31 }}>
          <div className="welcome-kicker"><Icon size={17} weight="fill" /> {item.eyebrow}</div>
          <h1>{item.title}</h1><p>{item.description}</p>
          {page === 0 && <div className="welcome-feature-grid"><span>Math & code</span><span>Interactive charts</span><span>Callout boxes</span><span>Real PDF layout</span></div>}
          {page === 1 && <div className="welcome-customize"><label>App theme<select value={theme} onChange={(event) => onTheme(event.target.value as ThemeMode)}><option value="caelestia">Caelestia dynamic</option><option value="light">Material light</option><option value="dark">Material dark</option><option value="black">Pure black</option></select></label><label>Reading font<select value={readerFont} onChange={(event) => onReaderFont(event.target.value)}><option value="sans">Noto Sans · clean</option><option value="humanist">Manrope · expressive</option><option value="serif">System serif · book</option></select></label><label className="welcome-switch"><span>Smooth expressive motion</span><input type="checkbox" checked={motionEnabled} onChange={(event) => onMotion(event.target.checked)} /></label></div>}
          {page === 2 && <div className="welcome-choices"><button onClick={() => onFinish(true)}><FolderOpen size={20} /> Open a note</button><button onClick={() => onFinish(false)}><BookOpen size={20} /> Explore the sample</button></div>}
        </motion.div></AnimatePresence>
        <div className="welcome-footer"><button className="welcome-back" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0}><ArrowLeft size={18} /> Back</button>{page < pages.length - 1 && <button className="welcome-next" onClick={() => setPage((value) => value + 1)}>Continue <ArrowRight size={18} /></button>}</div>
      </div>
    </div>
  </div>;
}
