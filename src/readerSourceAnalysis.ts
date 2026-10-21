import { analyzeDocument, type SourceDocumentAnalysis } from "./documentAnalysis";

export type ReaderDisplayMode = "live" | "editor" | "reader" | "split";

/** Only Read/Split own a preview analysis here; Live remains on its editor path. */
export function readerSourceAnalysis(mode: ReaderDisplayMode, source: string): SourceDocumentAnalysis | null {
  if (mode !== "reader" && mode !== "split") return null;
  return { source, analysis: analyzeDocument(source) };
}
