export type ThemeMode = "system" | "light" | "dark" | "black";
export type ViewMode = "split" | "live" | "editor" | "reader";

export interface DocumentData {
  path: string;
  content: string;
}

/** User-selected opt-in for keeping large reader documents fully mounted. */
export interface ReaderAccessibilityPreference {
  fullDocumentAccessibility?: boolean;
}

export interface ExportOptions {
  pageSize: "a3" | "a4" | "a5" | "a6" | "iso-b4" | "iso-b5" | "iso-b6" | "letter" | "legal" | "tabloid" | "executive";
  margin: number;
  fontSize: number;
  lineHeight: number;
  paragraphSpacing?: number;
  fontFamily: string;
  pageNumbers: boolean;
  themed?: boolean;
  themeAccent?: string;
  output?: string;
}

export interface PythonResult {
  stdout: string;
  stderr: string;
  images: string[];
  ok: boolean;
  provenance?: PythonProvenance;
}

export interface PythonProvenance {
  verified: boolean;
  unsaved?: boolean;
  document?: string;
  cell?: string;
  interpreter?: string;
  savedAt?: string;
  reason?: string;
}

export interface PythonContext {
  document: string;
  cell: string;
  interpreter: string;
}

export interface ChartSpec {
  mode?: "line";
  title?: string;
  x?: { min: number; max: number; steps?: number; label?: string };
  y?: { min?: number; max?: number; label?: string };
  series: Array<{
    name?: string;
    expression?: string;
    points?: Array<[number, number]>;
    color?: string;
  }>;
  sliders?: Array<{
    name: string;
    label?: string;
    min: number;
    max: number;
    step?: number;
    value: number;
  }>;
}
