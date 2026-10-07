import { render } from "preact";

import { App } from "./components/App.tsx";
import { followBase, type ServerBase } from "./baseSync.ts";
import { reconcileFiles, trackedPaths } from "./fileSync.ts";
import { followScope, type ScopeFile } from "./scopeSync.ts";
import { imageStatsStore, startImageStatsSweep } from "./imageDiff/imageStats.ts";
import { liveEditors } from "./liveEditors.ts";
import { followPageTheme } from "./monacoLoader.ts";
import { loadNotes, messagesOf, type Note, noteAt, type Notes, notesStore } from "./notes.ts";
import { githubStore, loadGithub } from "./github.ts";
import { type GithubReview } from "./githubTypes.ts";
import {
  activeReviewIsEditable,
  meta,
  reviewId,
  selectCommit,
  selectReview,
  server,
} from "./payload.ts";
import { setCommitSwitcher, setReviewSwitcher } from "./reviewSwitch.ts";
import { toast } from "./stores.ts";
// applies the remembered theme as a side effect of import, ahead of the
// first render
import "./theme.ts";
import {
  adoptTicks,
  currentTicks,
  getLastFromServer,
  loadTicks,
  setCurrentTicks,
  setLastFromServer,
  ticksAreInFlight,
  ticksSignature,
} from "./ticks.ts";
import "./page.css";

/* ---- the page follows the working tree ------------------------------------
   an agent acting on a note shows up here within a couple of seconds, in the
   diff and in the note's own thread */

type ServerState = {
  notes: Notes;
  ticked: string[];
  /** the PR's comments, when this review has a PR and prComments.ts has read it */
  github?: GithubReview | null;
  /** path -> the sha its content currently hashes to on disk */
  files: Record<string, string>;
  /** where the before side should be read from now */
  base?: ServerBase;
  /** the files the review's scope covers now - null where it isn't followed */
  scope?: ScopeFile[] | null;
};

const agentSaid = (state: ServerState) =>
  Object.entries(state.notes).flatMap(([path, forPath]) =>
    forPath.flatMap((note: Note) => {
      const was = messagesOf(noteAt(path, note.line)).length;
      return messagesOf(note)
        .slice(was)
        .filter((message) => message.from === "agent")
        .map((message) => ({ path, line: note.line, message }));
    }),
  );

let missedPolls = 0;

const reviewQuery = (): string => `?review=${encodeURIComponent(reviewId)}`;

const pollState = async (): Promise<void> => {
  if (server === undefined) {
    return;
  }
  // file-content sync only applies to the review the served checkout can edit
  const paths = activeReviewIsEditable() ? trackedPaths() : [];
  const response = await fetch(`/state${reviewQuery()}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Review-Token": server.token },
    body: JSON.stringify({ paths }),
  }).catch(() => undefined);

  if (response?.ok !== true) {
    missedPolls += 1;
    // the server can be restarted under an open tab; say so rather than going
    // quietly inert, which looks exactly like "nothing is happening"
    if (missedPolls === 3) {
      toast("lost the review server — saves and notes won't land. Reload this page", "warn");
    }
    return;
  }
  if (missedPolls >= 3) {
    toast("back in touch with the review server", "done");
  }
  missedPolls = 0;

  const state = (await response.json()) as ServerState;

  // a tick made in another tab on this review; while this one has a write in
  // flight the file is the stale side, so leave it alone
  const incoming = ticksSignature(state.ticked ?? []);
  if (incoming !== getLastFromServer() && !ticksAreInFlight()) {
    setLastFromServer(incoming);
    adoptTicks.set(new Set(state.ticked));
  }

  if (JSON.stringify(state.notes) !== JSON.stringify(notesStore.get())) {
    for (const { path, line, message } of agentSaid(state)) {
      toast(`${message.asking === true ? "asked" : "agent"} on ${path}:${line} — ${message.text}`);
    }
    notesStore.set(state.notes);
    for (const editor of liveEditors.values()) {
      editor.refreshNotes();
    }
  }

  if (JSON.stringify(state.github ?? null) !== JSON.stringify(githubStore.get() ?? null)) {
    githubStore.set(state.github ?? undefined);
  }

  await reconcileFiles(state.files);
  await followBase(state.base);
  await followScope(state.scope);
};

const mountApp = (root: HTMLElement, initialTicks: Set<string>): void => {
  document.title = meta.title;
  // keyed by review: switching remounts the whole tree, so every component
  // re-reads payload.ts's live bindings
  render(<App key={reviewId} initialTicks={initialTicks} />, root);
};

const main = async (): Promise<void> => {
  followPageTheme();

  const root = document.getElementById("app");
  if (root === null) {
    throw new Error("the page has no #app to render into");
  }

  const switchTo = async (key: string): Promise<void> => {
    const dirty = [...liveEditors.values()].some((editor) => editor.isDirty());
    if (
      dirty &&
      !window.confirm("This review has unsaved edits, lost on switching. Switch anyway?")
    ) {
      return;
    }
    selectReview(key);
    imageStatsStore.set({});
    await loadNotes();
    await loadGithub();
    const ticks = await loadTicks();
    setCurrentTicks(ticks);
    setLastFromServer(ticksSignature(ticks));
    mountApp(root, ticks);
    startImageStatsSweep();
  };
  setReviewSwitcher((key) => {
    switchTo(key);
  });

  // a commit switch changes which files are in view, not which review they
  // belong to: the notes and ticks are the same store, so only the app remounts
  setCommitSwitcher((sha) => {
    selectCommit(sha);
    mountApp(root, currentTicks());
  });

  await loadNotes();
  await loadGithub();
  const initialTicks = await loadTicks();
  setCurrentTicks(initialTicks);
  setLastFromServer(ticksSignature(initialTicks));
  mountApp(root, initialTicks);

  // the %-of-pixels summaries fill in behind the first paint
  startImageStatsSweep();

  if (server !== undefined) {
    setInterval(pollState, 2_000);
  }
};

main().catch((error: unknown) => {
  console.error("failed to start guided review", error);
});
