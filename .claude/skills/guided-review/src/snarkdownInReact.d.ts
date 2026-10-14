/* snarkdown-in-react ships its TypeScript source, not declarations, and that
   source doesn't pass this project's stricter checks (noUncheckedIndexedAccess)
   - which skipLibCheck can't skip, as it isn't a .d.ts. tsconfig's `paths`
   points the typechecker here instead; vite still bundles the package itself.
   Only what the page uses is declared */

import { type ComponentChildren, type FunctionComponent, type VNode } from "preact";

type Rendered<Props = Record<string, never>> = string | FunctionComponent<Props & { children?: ComponentChildren }>;

export type CustomComponentsOption = Partial<{
  pre: Rendered;
  code: Rendered<{ language: string }>;
  ol: Rendered;
  ul: Rendered;
  hr: Rendered;
  blockquote: Rendered;
  li: Rendered;
  a: Rendered<{ href: string }>;
  img: Rendered<{ src: string; alt: string }>;
  h1: Rendered;
  h2: Rendered;
  h3: Rendered;
  h4: Rendered;
  h5: Rendered;
  h6: Rendered;
  p: Rendered;
  em: Rendered;
  strong: Rendered;
}>;

export declare const SnarkdownInReact: (props: { markdown: string; customComponents?: CustomComponentsOption }) => VNode;
