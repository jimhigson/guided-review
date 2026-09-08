#!/usr/bin/env node
/* Confirm you've seen a note, before you have an answer for it.
 *
 * Call this the moment you pick a note up - it turns the page's honest "sent,
 * waiting for an agent to notice" into "the agent is on it", without
 * pretending to be the answer itself. A real reply from reply.ts already
 * implies this, so don't bother acking a note you're about to answer outright.
 *
 *   node ackNote.ts --notes <review>/notes.json --path src/foo.ts --line 12
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

type NoteMessage = { from?: string; text?: string };
type Note = { line?: number; text?: string; messages?: NoteMessage[]; ackedThrough?: number };
type Notes = Record<string, Note[]>;

const { values } = parseArgs({
  options: {
    notes: { type: "string" },
    path: { type: "string" },
    line: { type: "string" },
  },
});

const { notes: notesFile, path, line: lineText } = values;
if (notesFile === undefined || path === undefined || lineText === undefined) {
  console.log("ackNote.ts --notes <review>/notes.json --path <file> --line <n>");
  process.exit(1);
}
const line = Number(lineText);

if (!existsSync(notesFile)) {
  console.log(`no note at ${path}:${line}`);
  process.exit(1);
}
const notes = JSON.parse(readFileSync(notesFile, "utf8")) as Notes;

const note = notes[path]?.find((candidate) => candidate.line === line);
if (note === undefined) {
  console.log(`no note at ${path}:${line}`);
  process.exit(1);
}

// the single-text shape a note started as reads as its one message
note.ackedThrough = note.messages?.length ?? (note.text === undefined ? 0 : 1);

writeFileSync(notesFile, JSON.stringify(notes, null, 2), "utf8");
console.log(`acknowledged ${path}:${line}`);
