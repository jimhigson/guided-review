#!/usr/bin/env node
/* Print each new reviewer note as it's written, for as long as this runs.
 *
 * Meant to run under a persistent Monitor rather than a one-shot background
 * command: it never exits on its own, so returning notes brings the agent
 * back for as long as the review lasts, without anyone needing to remember
 * to re-arm it after each note or after a quiet stretch.
 *
 *   node awaitNotes.ts --notes <review>/notes.json
 *
 * Stop it (TaskStop) once the review is done.
 */

import chokidar from "chokidar";
import { existsSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

type NoteMessage = { from?: string; text?: string };
type Note = { line?: number; text?: string; messages?: NoteMessage[] };
type Notes = Record<string, Note[]>;

const { values } = parseArgs({
  options: {
    notes: { type: "string" },
  },
});

if (values.notes === undefined) {
  console.log("awaitNotes.ts --notes <review>/notes.json");
  process.exit(1);
}

const notesFile = values.notes;

const read = (): Notes => {
  if (!existsSync(notesFile)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(notesFile, "utf8")) as Notes;
  } catch {
    // caught mid-write; the next change event will see it whole
    return {};
  }
};

/** the reviewer's side of each thread - your own replies must not wake you */
const flatten = (notes: Notes): Map<string, string> => {
  const said = (note: Note): string => {
    // a note is a thread; the single-text shape it started as is its first
    // message. Anything else is read as empty rather than crashing the wait
    const messages =
      Array.isArray(note.messages) ? note.messages
      : note.text === undefined ? []
      : [{ from: "reviewer", text: note.text }];
    return messages
      .filter((message) => message.from !== "agent")
      .map((message) => message.text ?? "")
      .join(" | ");
  };

  return new Map(
    Object.entries(notes).flatMap(([path, forPath]) =>
      forPath
        .filter((note) => note.line !== undefined)
        .map((note) => [`${path}:${note.line}`, said(note)] as const),
    ),
  );
};

// a changed note counts as new: the reviewer edited it to say more. A thread
// the agent started on its own has nothing of theirs in it and is not news
let known = flatten(read());

const printFresh = (): void => {
  const current = flatten(read());
  const fresh = [...current].filter(([key, text]) => text !== "" && known.get(key) !== text);
  known = current;
  if (fresh.length === 0) {
    return;
  }
  console.log(`${fresh.length} new review note(s):`);
  for (const [where, text] of fresh.sort(([left], [right]) => (left < right ? -1 : 1))) {
    console.log(`- ${where} — ${text}`);
  }
};

chokidar.watch(notesFile).on("all", printFresh);
