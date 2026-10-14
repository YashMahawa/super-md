import {createContext} from 'react';
import type {MediaAppearance} from './mediaAppearance';
/** Theme consumers are diagrams only; changing a palette must not rebuild the
 * entire cached Markdown/KaTeX React tree for a long note. */
export const DocumentAppearance=createContext<{dark:boolean;svgAppearance?:MediaAppearance;ink?:string;text?:string}|null>(null);
