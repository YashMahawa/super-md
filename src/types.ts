export type ThemeMode = "caelestia" | "light" | "dark" | "black";
export type ViewMode = "split" | "editor" | "reader";

export interface DocumentData {
  path: string;
  content: string;
}

export interface ExportOptions {
  pageSize: "a4" | "a5" | "letter" | "legal";
  margin: number;
  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  output?: string;
}

export interface PythonResult {
  stdout: string;
  stderr: string;
  images: string[];
  ok: boolean;
}

export interface ChartSpec {
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
    step: number;
    value: number;
  }>;
}
