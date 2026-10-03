export type ThemeMode = "system" | "light" | "dark" | "black";
export type ViewMode = "split" | "live" | "editor" | "reader";

export interface DocumentData {
  path: string;
  content: string;
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
}

export interface ChartSpec {
  mode?: "line" | "surface3d";
  title?: string;
  x?: { min: number; max: number; steps?: number; label?: string };
  y?: { min?: number; max?: number; label?: string };
  z?: { min?: number; max?: number; label?: string };
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
