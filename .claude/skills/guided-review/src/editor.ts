/* which local editor the "open in" links on every file row go to. Remembered
   per reader rather than per review - it's whatever is installed on this
   machine, not anything about the change being read. */

import { makeStore } from "./stores.ts";

export type Editor = {
  label: string;
  /** a link that opens this absolute path in the editor, at `line` if given */
  href: (absolutePath: string, line?: number) => string;
};

/** a path joined onto a `scheme://file` url, which wants exactly one slash
    between them whatever the platform's paths start with */
const underFileUrl = (scheme: string, absolutePath: string, line?: number): string =>
  `${scheme}://file/${absolutePath.replace(/^\/+/, "")}${line === undefined ? "" : `:${line}`}`;

/** the `open?url=` form TextMate and MacVim share */
const openUrl = (scheme: string, absolutePath: string, line?: number): string =>
  `${scheme}://open?url=${encodeURIComponent(
    `file://${absolutePath.startsWith("/") ? "" : "/"}${absolutePath}`,
  )}${line === undefined ? "" : `&line=${line}`}`;

export const editors = {
  vscode: { label: "VS Code", href: (path, line) => underFileUrl("vscode", path, line) },
  "vscode-insiders": {
    label: "VS Code Insiders",
    href: (path, line) => underFileUrl("vscode-insiders", path, line),
  },
  cursor: { label: "Cursor", href: (path, line) => underFileUrl("cursor", path, line) },
  windsurf: { label: "Windsurf", href: (path, line) => underFileUrl("windsurf", path, line) },
  vscodium: { label: "VSCodium", href: (path, line) => underFileUrl("vscodium", path, line) },
  zed: { label: "Zed", href: (path, line) => underFileUrl("zed", path, line) },
  textmate: { label: "TextMate", href: (path, line) => openUrl("txmt", path, line) },
  macvim: { label: "MacVim", href: (path, line) => openUrl("mvim", path, line) },
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
