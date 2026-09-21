/* one file's monaco diff editor and everything hung off it: saving back to the
   working tree, and the note zones. Imperative by nature - monaco owns this dom
   - and reports back through the setters it is given.

   The models (and so unsaved edits, and the sha a save is checked against)
   outlive the editing surface: switching between a 2-way and a 3-way view
   swaps the surface over the same models, rather than rebuilding the file from
   the content the review was built with. */

import { render } from "preact";

import { focusNoteOnLine, NoteZone } from "./components/NoteZone.tsx";
import { type DiffView, diffViewStore, showsBothSides } from "./diffView.ts";
import { notifyDiskConflict } from "./diskConflict.ts";
import { fetchFileFromDisk } from "./fileSync.ts";
import { type FileFromDisk, liveEditors } from "./liveEditors.ts";
import {
  type MonacoApi,
  type MonacoCodeEditor,
  type MonacoDisposable,
  type MonacoTextModel,
  type MonacoViewZone,
} from "./monacoApi.ts";
import { languageFor } from "./monacoLoader.ts";
import { notesFor } from "./notes.ts";
import { activeReviewIsEditable, reviewId, server, sides } from "./payload.ts";
import { type LineMark, threeWayLayouter, type Zone } from "./threeWayLayout.ts";

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
    editor for a changed file, a plain one for a new file, three panes for a
    conflict - nothing else in createDiffEditor below this point needs to know
    which it got */
type EditorHandle = {
  /** the editor showing the file as it will be saved - the one notes live in */
  modifiedEditor: MonacoCodeEditor;
  layout: () => void;
  dispose: () => void;
  /** how tall the surface's content is, for sizing the host to fit it */
  contentHeight: () => number;
  /** wired once fitToContent exists; returns how to stop watching on dispose */
  startSizing: (fitToContent: () => void) => () => void;
  /** the note zones now in the modified editor - a 3-way view pads its other
      panes to keep them level with them */
  noteZonesChanged?: (zones: Zone[]) => void;
};

type EditorKind = "plain" | "diff" | "threeWay";

const lineHeight = 18;

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
    lineHeight,
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
    layout: () => editor.layout(),
    dispose: () => editor.dispose(),
    contentHeight: () => editor.getModifiedEditor().getContentHeight(),
    startSizing: (fitToContent) => {
      const diffUpdates = editor.onDidUpdateDiff(fitToContent);
      // one choice drives every editor on the page, including the ones already built
      const stopFollowing = diffViewStore.subscribe(() => {
        editor.updateOptions(sideBySideOptions(diffViewStore.get()));
        fitToContent();
      });
      return () => {
        diffUpdates.dispose();
        stopFollowing();
      };
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
    lineHeight,
    scrollbar: { alwaysConsumeMouseWheel: false },
  });
  modifiedEditor.setModel(modified);

  return {
    modifiedEditor,
    layout: () => modifiedEditor.layout(),
    dispose: () => modifiedEditor.dispose(),
    contentHeight: () => modifiedEditor.getContentHeight(),
    startSizing: (fitToContent) => {
      const sizing = modifiedEditor.onDidContentSizeChange(fitToContent);
      return () => sizing.dispose();
    },
  };
};

const linesOf = (text: string): string[] => text.split(/\r\n|\r|\n/);

/** how often, at most, the 3-way view re-lines-up while the resolution is typed into */
const realignDelayMs = 150;

/**
 * current | resolution | incoming, as three plain editors side by side.
 * Every pane is as tall as its content - the page scrolls, never a pane - so
 * lining them up is the whole of keeping them in step: once each stretch
 * between shared lines is padded to the same height, they scroll as one
 * because they are one piece of the page. Folding and wrapping are off in all
 * three, as either would move one pane's lines out from under the others.
 */
const buildThreeWayHandle = (
  monaco: MonacoApi,
  host: HTMLElement,
  models: { current: MonacoTextModel; resolution: MonacoTextModel; incoming: MonacoTextModel },
  ancestor: string,
  editable: boolean,
): EditorHandle => {
  host.classList.add("three-way");
  const paneEditor = (name: string, model: MonacoTextModel, readOnly: boolean): MonacoCodeEditor => {
    const pane = document.createElement("div");
    pane.className = `three-way-pane three-way-${name}`;
    host.append(pane);
    const editor = monaco.editor.create(pane, {
      readOnly,
      automaticLayout: true,
      // the resolution's margin carries the note "+"; the sides take no notes
      glyphMargin: model === models.resolution,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      fontSize: 12,
      lineHeight,
      scrollbar: { alwaysConsumeMouseWheel: false },
      folding: false,
      wordWrap: "off",
    });
    editor.setModel(model);
    return editor;
  };
  const panes = [
    paneEditor("current", models.current, true),
    paneEditor("resolution", models.resolution, !editable),
    paneEditor("incoming", models.incoming, true),
  ] as const;
  const [, resolutionEditor] = panes;

  const layOut = threeWayLayouter(
    models.current.getLinesContent(),
    models.incoming.getLinesContent(),
    linesOf(ancestor),
    lineHeight,
  );
  const padIds: string[][] = [[], [], []];
  const markings = panes.map((editor) => editor.createDecorationsCollection([]));
  let noteZones: Zone[] = [];

  const realign = (): void => {
    const layout = layOut(models.resolution.getLinesContent(), noteZones);
    [layout.current, layout.resolution, layout.incoming].forEach((pane, index) => {
      panes[index]?.changeViewZones((accessor) => {
        for (const id of padIds[index] ?? []) {
          accessor.removeZone(id);
        }
        padIds[index] = pane.pads.map((pad) => {
          const domNode = document.createElement("div");
          domNode.className = "three-way-pad";
          return accessor.addZone({ ...pad, suppressMouseDown: true, domNode });
        });
      });
      markings[index]?.set(
        (Object.entries(pane.marks) as [LineMark, number[]][]).flatMap(([mark, lines]) =>
          lines.map((line) => ({
            range: new monaco.Range(line, 1, line, 1),
            options: {
              isWholeLine: true,
              className: `tw-line tw-${mark}`,
              linesDecorationsClassName: `tw-edge tw-edge-${mark}`,
            },
          })),
        ),
      );
    });
  };

  let realignTimer: ReturnType<typeof setTimeout> | undefined;
  const edits = models.resolution.onDidChangeContent(() => {
    clearTimeout(realignTimer);
    realignTimer = setTimeout(realign, realignDelayMs);
  });
  realign();

  return {
    modifiedEditor: resolutionEditor,
    layout: () => {
      for (const editor of panes) {
        editor.layout();
      }
    },
    dispose: () => {
      clearTimeout(realignTimer);
      edits.dispose();
      for (const editor of panes) {
        editor.dispose();
      }
      host.classList.remove("three-way");
    },
    contentHeight: () => Math.max(...panes.map((editor) => editor.getContentHeight())),
    startSizing: (fitToContent) => {
      const sizing = panes.map((editor) => editor.onDidContentSizeChange(fitToContent));
      return () => {
        for (const watch of sizing) {
          watch.dispose();
        }
      };
    },
    noteZonesChanged: (zones) => {
      noteZones = zones;
      realign();
    },
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
  // made when a surface first needs them, then kept for the next one
  const otherModels = new Map<string, MonacoTextModel>();
  const otherModel = (content: string, which: string): MonacoTextModel => {
    const existing = otherModels.get(which);
    if (existing !== undefined) {
      return existing;
    }
    const model = modelFor(content, which);
    otherModels.set(which, model);
    return model;
  };

  const kindFor = (view: DiffView): EditorKind =>
    view === "threeWay" && side.incoming !== undefined ? "threeWay"
    : fileStatus === "A" ? "plain"
    : "diff";

  const buildHandle = (kind: EditorKind): EditorHandle => {
    if (kind === "threeWay") {
      return buildThreeWayHandle(
        monaco,
        host,
        {
          current: otherModel(side.before, "current"),
          resolution: modified,
          incoming: otherModel(side.incoming ?? "", "incoming"),
        },
        side.ancestor ?? "",
        editable,
      );
    }
    return kind === "plain" ?
        buildPlainEditorHandle(monaco, host, modified, editable)
      : buildDiffEditorHandle(
          monaco,
          host,
          otherModel(side.before, "original"),
          modified,
          editable,
        );
  };

  let kind = kindFor(diffViewStore.get());
  let handle = buildHandle(kind);

  // sized to its own content, always - so a long file or an open note thread
  // scrolls the page, never a scrollbar nested inside the editor itself
  const fitToContent = () => {
    host.style.height = `${Math.max(handle.contentHeight() + 24, 120)}px`;
    handle.layout();
  };
  let stopSizing = handle.startSizing(fitToContent);

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
  let drawNotes = (): void => {};

  /** hangs the notes off whichever surface is showing, returning how to take
      them down again when it is swapped for another */
  const wireNotes = (surface: EditorHandle): (() => void) => {
    const { modifiedEditor } = surface;
    let zoneIds: string[] = [];
    let zones: MonacoViewZone[] = [];
    let zoneObservers: ResizeObserver[] = [];
    const listeners: MonacoDisposable[] = [];
    const decorations = modifiedEditor.createDecorationsCollection([]);
    let editing: number | undefined;

    const reportZones = () =>
      surface.noteZonesChanged?.(
        zones.map(({ afterLineNumber, heightInPx }) => ({ afterLineNumber, heightInPx })),
      );

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
        reportZones();
        // the zone's own height change alters getContentHeight() too - without
        // this the editor grows a scrollbar to reach it rather than the host
        // element growing to fit
        fitToContent();
      });
      observer.observe(content);
      return observer;
    };

    drawNotes = () => {
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
        zones = [];
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
          zones.push(zone);
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
      reportZones();

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

    listeners.push(
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
      }),
    );

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

    listeners.push(
      modifiedEditor.onMouseMove((event) =>
        markHoveredLine(event.target.position?.lineNumber ?? undefined),
      ),
      modifiedEditor.onMouseLeave(() => markHoveredLine(undefined)),
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
      }),
    );

    drawNotes();

    return () => {
      drawNotes = () => {};
      for (const zoneObserver of zoneObservers) {
        zoneObserver.disconnect();
      }
      for (const listener of listeners) {
        listener.dispose();
      }
    };
  };

  let unwireNotes = server === undefined ? () => {} : wireNotes(handle);

  if (server !== undefined) {
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
      refreshNotes: () => drawNotes(),
      isDirty: () => dirty,
      applyFromDisk,
      overwriteDiskWith,
    });
  }

  // 2-way and 3-way are different surfaces, not options on one: a switch
  // between them builds the other over the same models
  const stopFollowingView = diffViewStore.subscribe(() => {
    const next = kindFor(diffViewStore.get());
    if (next === kind) {
      return;
    }
    kind = next;
    unwireNotes();
    stopSizing();
    handle.dispose();
    host.replaceChildren();
    handle = buildHandle(kind);
    stopSizing = handle.startSizing(fitToContent);
    unwireNotes = server === undefined ? () => {} : wireNotes(handle);
    fitToContent();
  });

  return {
    dispose() {
      stopFollowingView();
      unwireNotes();
      stopSizing();
      clearTimeout(saveTimer);
      liveEditors.delete(path);
      handle.dispose();
      for (const model of otherModels.values()) {
        model.dispose();
      }
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
