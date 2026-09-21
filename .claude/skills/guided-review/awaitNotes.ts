#!/usr/bin/env node
/* Print each new reviewer note as it's written, for as long as this runs.
 *
 * Which mode to use depends on how the agent's host can wake it - SKILL.md's
 * "Keeping the notes channel open" sorts hosts into categories. Streaming,
 * it never exits on its own, for a host that wakes the agent on each line
 * of a running command (eg Claude Code's Monitor):
 *
 *   node awaitNotes.ts --notes <review>/notes.json
 *
 * Stop it once the review is done.
 *
 * For a host that wakes the agent only when a background command exits, or
 * not at all (so it waits in the foreground), --once waits for new notes,
 * prints them and exits, to be re-run after each:
 *
 *   node awaitNotes.ts --notes <review>/notes.json --once [--timeout <seconds>]
 *
 * What has been reported is kept in awaited.json beside notes.json, so a note
 * written while the agent was busy between two waits is still news to the
 * next one - which then returns straight away - rather than being taken as
 * already seen. --timeout gives up after that long with "no new notes", for a
 * terminal tool that kills long commands; the answer to that is to re-run.
 */

import chokidar from "chokidar";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

type NoteMessage = { from?: string; text?: string };
type Note = { line?: number; text?: string; messages?: NoteMessage[] };
type Notes = Record<string, Note[]>;

const { values } = parseArgs({
  options: {
    notes: { type: "string" },
    once: { type: "boolean", default: false },
    timeout: { type: "string" },
  },
});

if (values.notes === undefined) {
  console.log("awaitNotes.ts --notes <review>/notes.json [--once [--timeout <seconds>]]");
  process.exit(1);
}

const notesFile = values.notes;
const once = values.once === true;
/** what has already been reported, shared by every run on this review */
const awaitedFile = join(dirname(notesFile), "awaited.json");

/** undefined when the file was caught mid-write - read as empty, it would
    make every note in it look new the next time it reads whole */
const read = (): Notes | undefined => {
  if (!existsSync(notesFile)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(notesFile, "utf8")) as Notes;
  } catch {
    return undefined;
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

/** what an earlier run already reported, if one has run on this review */
const readAwaited = (): Map<string, string> | undefined => {
  if (!existsSync(awaitedFile)) {
    return undefined;
  }
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(awaitedFile, "utf8")) as Record<string, string>));
  } catch {
    return undefined;
  }
};

const recordAwaited = (reported: Map<string, string>): void => {
  writeFileSync(awaitedFile, `${JSON.stringify(Object.fromEntries(reported), null, 2)}\n`, "utf8");
};

// a changed note counts as new: the reviewer edited it to say more. A thread
// the agent started on its own has nothing of theirs in it and is not news.
// A run picks up where the last one left off, so nothing written between
// two runs is missed - the first ever run starts from what's there now
let known = readAwaited() ?? flatten(read() ?? {});

const printFresh = (): void => {
  const notes = read();
  if (notes === undefined) {
    // the write that caught it half-done fires another event when it lands
    return;
  }
  const current = flatten(notes);
  const fresh = [...current].filter(([key, text]) => text !== "" && known.get(key) !== text);
  known = current;
  recordAwaited(current);
  if (fresh.length === 0) {
    return;
  }
  console.log(`${fresh.length} new review note(s):`);
  for (const [where, text] of fresh.sort(([left], [right]) => (left < right ? -1 : 1))) {
    console.log(`- ${where} — ${text}`);
  }
  if (once) {
    console.log("re-run awaitNotes.ts --once after handling these, or no further notes will reach you");
    process.exit(0);
  }
};

// anything written since the last run is news straight away
printFresh();
// a write is often a truncate and then the content: waiting for the file to
// settle means one event for the finished write, not one for the empty file
chokidar
  .watch(notesFile, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 } })
  .on("all", printFresh);

if (once && values.timeout !== undefined) {
  setTimeout(() => {
    console.log("no new notes - re-run awaitNotes.ts --once to keep listening");
    process.exit(0);
  }, Number(values.timeout) * 1_000);
}
