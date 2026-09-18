/* which local editor the "open in" links on every file row go to. Remembered
   per reader rather than per review - it's whatever is installed on this
   machine, not anything about the change being read. */

import { makeStore } from "./stores.ts";

export type Editor = {
  label: string;
  /** a link that opens this absolute path in the editor */
  href: (absolutePath: string) => string;
};

/** a path joined onto a `scheme://file` url, which wants exactly one slash
    between them whatever the platform's paths start with */
const underFileUrl = (scheme: string, absolutePath: string): string =>
  `${scheme}://file/${absolutePath.replace(/^\/+/, "")}`;

const fileUrl = (absolutePath: string): string =>
  encodeURIComponent(`file://${absolutePath.startsWith("/") ? "" : "/"}${absolutePath}`);

export const editors = {
  vscode: { label: "VS Code", href: (path) => underFileUrl("vscode", path) },
  "vscode-insiders": {
    label: "VS Code Insiders",
    href: (path) => underFileUrl("vscode-insiders", path),
  },
  cursor: { label: "Cursor", href: (path) => underFileUrl("cursor", path) },
  windsurf: { label: "Windsurf", href: (path) => underFileUrl("windsurf", path) },
  vscodium: { label: "VSCodium", href: (path) => underFileUrl("vscodium", path) },
  zed: { label: "Zed", href: (path) => underFileUrl("zed", path) },
  textmate: { label: "TextMate", href: (path) => `txmt://open?url=${fileUrl(path)}` },
  macvim: { label: "MacVim", href: (path) => `mvim://open?url=${fileUrl(path)}` },
} satisfies Record<string, Editor>;

export type EditorId = keyof typeof editors;

const storageKey = "guidedReviewEditor";

const isEditorId = (value: null | string): value is EditorId =>
  value !== null && Object.hasOwn(editors, value);

const remembered = (): EditorId => {
  try {
    const stored = localStorage.getItem(storageKey);
    return isEditorId(stored) ? stored : "vscode";
  } catch {
    return "vscode";
  }
};

export const editorStore = makeStore<EditorId>(remembered());

export const setEditor = (editor: EditorId): void => {
  try {
    localStorage.setItem(storageKey, editor);
  } catch {
    /* storage unavailable - the choice just won't outlive the page */
  }
  editorStore.set(editor);
};
