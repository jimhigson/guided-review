/* one file's monaco diff editor and everything hung off it: saving back to the
   working tree, and the note zones. Imperative by nature - monaco owns this dom
   - and reports back through the setters it is given */

import { render } from "preact";

import { focusNoteOnLine, NoteZone } from "./components/NoteZone.tsx";
import { type DiffView, diffViewStore, showsBothSides } from "./diffView.ts";
import { notifyDiskConflict } from "./diskConflict.ts";
import { fetchFileFromDisk } from "./fileSync.ts";
import { type FileFromDisk, liveEditors } from "./liveEditors.ts";
import {
  type MonacoApi,
  type MonacoCodeEditor,
  type MonacoTextModel,
  type MonacoViewZone,
} from "./monacoApi.ts";
import { languageFor } from "./monacoLoader.ts";
import { notesFor } from "./notes.ts";
import { activeReviewIsEditable, reviewId, server, sides } from "./payload.ts";

export type EditorStatus = { kind: string; text: string };

export type DiffEditorSetters = {
  setCounts: (counts: [number, number]) => void;
  setDirty: (dirty: boolean) => void;
  setStatus: (status: EditorStatus) => void;
};

export type DiffEditorControls = {
  dispose: () => void;
  revert: () => void;
  save: () => Promise<void>;
};

/** side by side has to be asked for twice: monaco drops back to the inline view
    on its own below a width these editors are usually under */
const sideBySideOptions = (view: DiffView) => ({
  renderSideBySide: showsBothSides(view),
  useInlineViewWhenSpaceIsLimited: false,
});

/** the editing surface itself, and what differs about wiring it up: a diff
    editor for a changed file, a plain one for a new file - nothing else in
    createDiffEditor below this point needs to know which it got */
type EditorHandle = {
  modifiedEditor: MonacoCodeEditor;
  original: MonacoTextModel | undefined;
  layout: () => void;
  dispose: () => void;
  /** wired once fitToContent exists; returns how to stop watching on dispose */
  startSizing: (fitToContent: () => void) => () => void;
};

const buildDiffEditorHandle = (
  monaco: MonacoApi,
  host: HTMLElement,
  original: MonacoTextModel,
  modified: MonacoTextModel,
  editable: boolean,
): EditorHandle => {
  const editor = monaco.editor.createDiffEditor(host, {
    readOnly: !editable,
    originalEditable: false,
    ...sideBySideOptions(diffViewStore.get()),
    automaticLayout: true,
    glyphMargin: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderOverviewRuler: false,
    fontSize: 12,
    lineHeight: 18,
    // unchanged stretches collapse to a foldable band, which is the whole
    // reason for using an editor over a static patch
    hideUnchangedRegions: {
      enabled: true,
      contextLineCount: 3,
      minimumLineCount: 4,
    },
    // let the page keep scrolling when the pointer crosses an editor
    scrollbar: { alwaysConsumeMouseWheel: false },
  });
  editor.setModel({ original, modified });

  return {
    modifiedEditor: editor.getModifiedEditor(),
    original,
    layout: () => editor.layout(),
    dispose: () => editor.dispose(),
    startSizing: (fitToContent) => {
      editor.onDidUpdateDiff(fitToContent);
      // one choice drives every editor on the page, including the ones already built
      return diffViewStore.subscribe(() => {
        editor.updateOptions(sideBySideOptions(diffViewStore.get()));
        fitToContent();
      });
    },
  };
};

/** a new file has no "before" worth diffing against - an all-green diff says
    nothing a plain editor on its content doesn't say more plainly */
const buildPlainEditorHandle = (
  monaco: MonacoApi,
  host: HTMLElement,
  modified: MonacoTextModel,
  editable: boolean,
): EditorHandle => {
  const modifiedEditor = monaco.editor.create(host, {
    readOnly: !editable,
    automaticLayout: true,
    glyphMargin: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    renderOverviewRuler: false,
    fontSize: 12,
    lineHeight: 18,
    scrollbar: { alwaysConsumeMouseWheel: false },
  });
  modifiedEditor.setModel(modified);

  return {
    modifiedEditor,
    original: undefined,
    layout: () => modifiedEditor.layout(),
    dispose: () => modifiedEditor.dispose(),
    startSizing: (fitToContent) =>
      modifiedEditor.onDidContentSizeChange(fitToContent).dispose,
  };
};

export const createDiffEditor = (
  monaco: MonacoApi,
  host: HTMLElement,
  path: string,
  fileStatus: string,
  { setCounts, setDirty, setStatus }: DiffEditorSetters,
): DiffEditorControls => {
  const side = sides[path];
  if (side === undefined) {
    throw new Error(`${path} has no before/after sides to diff`);
  }
  const language = languageFor(path);
  // only the review matching the served checkout can write back; in a stack
  // page the other reviews' editors read only, though their notes still work
  const editable = activeReviewIsEditable();

  // the model's uri decides the typescript worker's script kind, so it has to
  // carry the real extension - an extensionless uri parses .tsx as .ts
  const modelFor = (content: string, which: string): MonacoTextModel =>
    monaco.editor.createModel(
      content,
      language,
      monaco.Uri.parse(`inmemory://review/${which}/${path}`),
    );
  const modified = modelFor(side.after, "modified");

  const handle =
    fileStatus === "A" ?
      buildPlainEditorHandle(monaco, host, modified, editable)
    : buildDiffEditorHandle(
        monaco,
        host,
        modelFor(side.before, "original"),
        modified,
        editable,
      );
  const { modifiedEditor } = handle;

  // sized to its own content, always - so a long file or an open note thread
  // scrolls the page, never a scrollbar nested inside the editor itself
  const fitToContent = () => {
    host.style.height = `${Math.max(modifiedEditor.getContentHeight() + 24, 120)}px`;
    handle.layout();
  };
  const stopSizing = handle.startSizing(fitToContent);

  let { sha } = side;
  let dirty = false;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const applyFromDisk = (file: FileFromDisk): void => {
    modified.setValue(file.after);
    // setValue fires onDidChangeContent same as a real edit would, arming the
    // autosave timer and marking "unsaved" below - this content came from
    // disk already, so both need clearing rather than a pointless write-back
    // racing whatever edit lands in the next 500ms
    clearTimeout(saveTimer);
    ({ sha } = file);
    dirty = false;
    setDirty(false);
    setStatus({ kind: "", text: "" });
    setCounts([file.added, file.removed]);
  };

  const writeToDisk = async (): Promise<void> => {
    setStatus({ kind: "", text: "saving…" });
    const response = await fetch(
      `/save?review=${encodeURIComponent(reviewId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Review-Token": server?.token ?? "",
        },
        body: JSON.stringify({ path, content: modified.getValue(), sha }),
      },
    ).catch(() => undefined);

    if (response?.ok === true) {
      const result = (await response.json()) as {
        sha: string;
        added: number;
        removed: number;
      };
      ({ sha } = result);
      dirty = false;
      setDirty(false);
      setCounts([result.added, result.removed]);
      setStatus({
        kind: "state-saved",
        text: `saved  +${result.added} −${result.removed}`,
      });
      return;
    }
    if (response?.status === 409) {
      setStatus({ kind: "state-error", text: "changed on disk" });
      const fresh = await fetchFileFromDisk(path);
      if (fresh !== undefined) {
        notifyDiskConflict(path, fresh, { applyFromDisk, overwriteDiskWith });
      }
      return;
    }
    setStatus({ kind: "state-error", text: "save failed" });
  };

  const overwriteDiskWith = (file: FileFromDisk): void => {
    ({ sha } = file);
    writeToDisk();
  };

  // note authoring/collaboration (view zones, the gutter "+" glyph, the
  // alt-N/context-menu action, save/revert, and the live-file poll) only make
  // sense with a server behind the page to persist and relay them - without one
  // they'd be dead controls, so standalone opens stay read-only and none of
  // this wiring runs at all
  if (server !== undefined) {
    let zoneIds: string[] = [];
    let zoneObservers: ResizeObserver[] = [];
    const decorations = modifiedEditor.createDecorationsCollection([]);
    let editing: number | undefined;

    // a zone's real height can change after it's added - the dom isn't laid
    // out on the same frame (the same reason NoteZone's own caret/scroll
    // effects poll for it), and can keep settling for a frame or two after
    // that. A one-off measurement can lock in a too-small height taken before
    // it's finished growing, so watch it for as long as the zone exists
    // instead. Guessing the height from message count, before this, left the
    // input box and buttons - always present, never counted - overlapping
    // whatever came after the zone.
    //
    // watched is NoteZone's own rendered root, not the zone's domNode: monaco
    // pins domNode's height to whatever heightInPx last said, so its own
    // offsetHeight never reflects content that has since outgrown it - only
    // the (overflowing, unclipped) child that preact actually renders into
    // does
    const watchZoneHeight = (
      id: string,
      zone: MonacoViewZone,
      content: HTMLElement,
    ): ResizeObserver => {
      const observer = new ResizeObserver(() => {
        if (
          content.offsetHeight === 0 ||
          content.offsetHeight === zone.heightInPx
        ) {
          return;
        }
        zone.heightInPx = content.offsetHeight;
        modifiedEditor.changeViewZones((accessor) => accessor.layoutZone(id));
        // the zone's own height change alters getContentHeight() too - without
        // this the editor grows a scrollbar to reach it rather than the host
        // element growing to fit
        fitToContent();
      });
      observer.observe(content);
      return observer;
    };

    const drawNotes = () => {
      const lines = new Set([
        ...notesFor(path).map((note) => note.line),
        ...(editing === undefined ? [] : [editing]),
      ]);

      modifiedEditor.changeViewZones((accessor) => {
        for (const id of zoneIds) {
          accessor.removeZone(id);
        }
        for (const zoneObserver of zoneObservers) {
          zoneObserver.disconnect();
        }
        zoneObservers = [];
        zoneIds = [...lines].map((line) => {
          const domNode = document.createElement("div");
          render(
            <NoteZone
              path={path}
              line={line}
              done={() => {
                editing = undefined;
                drawNotes();
              }}
            />,
            domNode,
          );
          const zone: MonacoViewZone = {
            afterLineNumber: line,
            // a first guess only - resized to the real content just below
            heightInPx: 46,
            // without this the editor eats the mousedown before the note's own
            // controls ever see it
            suppressMouseDown: false,
            domNode,
          };
          const id = accessor.addZone(zone);
          const content = domNode.firstElementChild;
          if (content instanceof HTMLElement) {
            zoneObservers.push(watchZoneHeight(id, zone, content));
          } else if (import.meta.env.DEV) {
            throw new Error(
              "NoteZone was required here but rendered no root element",
            );
          }
          return id;
        });
      });

      decorations.set(
        notesFor(path).map((note) => ({
          range: new monaco.Range(note.line, 1, note.line, 1),
          options: {
            isWholeLine: true,
            className: "noted-line",
            glyphMarginClassName: "noted-glyph",
          },
        })),
      );
    };

    modifiedEditor.addAction({
      id: "add-review-note",
      label: "Add review note",
      contextMenuGroupId: "navigation",
      keybindings: [monaco.KeyMod.Alt | monaco.KeyCode.KeyN],
      run(instance) {
        editing = instance.getPosition().lineNumber;
        focusNoteOnLine(editing);
        drawNotes();
      },
    });

    /* a + in the gutter of whichever line the mouse is on, so adding a note is
       something you can see rather than something you have to know */
    const hoverGlyph = modifiedEditor.createDecorationsCollection([]);
    const markHoveredLine = (line: number | undefined) => {
      hoverGlyph.set(
        (
          line === undefined ||
            notesFor(path).some((note) => note.line === line)
        ) ?
          []
        : [
            {
              range: new monaco.Range(line, 1, line, 1),
              options: {
                glyphMarginClassName: "add-note-glyph",
                glyphMarginHoverMessage: {
                  value: "Add a review note (alt-N)",
                },
              },
            },
          ],
      );
    };

    modifiedEditor.onMouseMove((event) =>
      markHoveredLine(event.target.position?.lineNumber ?? undefined),
    );
    modifiedEditor.onMouseLeave(() => markHoveredLine(undefined));
    modifiedEditor.onMouseDown((event) => {
      if (
        event.target.type ===
          monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
        event.target.position !== null
      ) {
        editing = event.target.position.lineNumber;
        focusNoteOnLine(editing);
        drawNotes();
      }
    });

    if (editable) {
      // synced almost as soon as it's typed, rather than sitting unsaved until
      // a deliberate Save that's easy to forget
      modified.onDidChangeContent(() => {
        dirty = true;
        setDirty(true);
        setStatus({ kind: "state-dirty", text: "unsaved" });
        clearTimeout(saveTimer);
        saveTimer = setTimeout(writeToDisk, 500);
      });
    }

    liveEditors.set(path, {
      sha: () => sha,
      refreshNotes: drawNotes,
      isDirty: () => dirty,
      applyFromDisk,
      overwriteDiskWith,
    });

    drawNotes();
  }

  return {
    dispose() {
      stopSizing();
      clearTimeout(saveTimer);
      liveEditors.delete(path);
      handle.dispose();
      handle.original?.dispose();
      modified.dispose();
    },
    // puts the file back the way the review found it - like any other edit,
    // that then syncs to disk on its own shortly after
    revert() {
      modified.setValue(side.after);
      setStatus({ kind: "state-dirty", text: "reverted" });
    },
    save: writeToDisk,
  };
};
