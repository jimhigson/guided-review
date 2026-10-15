#!/usr/bin/env node
/* Answer a review note, in the note itself.
 *
 * The reviewer wrote a note against a line; this puts your reply in the same
 * thread, where the page picks it up within a couple of seconds and pops a
 * toast. Use it to say what you did, or to ask the one question you need
 * answered before you can do it.
 *
 *   node reply.ts --notes <review>/notes.json --path src/foo.ts --line 12 \
 *                 --text "moved it to src/util — the import sites came with it"
 *
 *   node reply.ts --notes <review>/notes.json --path src/foo.ts --line 12 \
 *                 --text "do you want the old path re-exported?" --asking
 *
 * `--asking` only marks the message as a question, for the reviewer's eye;
 * either way the reply lands in their note box and they can type straight back.
 *
 * The text is markdown - `code`, **bold**, lists, links, fenced blocks - and
 * the page renders it as such.
 *
 * Having edited files for the note, name each with `--edited` (once per
 * file), with the page and the checkout:
 *
 *   node reply.ts --notes <review>/notes.json --path src/foo.ts --line 12 \
 *                 --html <review.html> --repo <checkout> \
 *                 --edited src/foo.ts --edited src/util/foo.ts --text "moved it"
 *
 * The reply then ends in a list of them, each a link that reads that file in
 * the page, where the edit landed: on disk, or in the PR's held edits - the
 * same place held.ts put it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { editLink, editPlaceOf, readingOf, readShell, reviewOfNotes } from "./editPlace.ts";

type NoteMessage = { from: string; text: string; asking?: boolean };
type Note = { line: number; text?: string; messages?: NoteMessage[] };
type Notes = Record<string, Note[]>;

const { values } = parseArgs({
  options: {
    notes: { type: "string" },
    path: { type: "string" },
    line: { type: "string" },
    text: { type: "string" },
    asking: { type: "boolean", default: false },
    edited: { type: "string", multiple: true },
    html: { type: "string" },
    repo: { type: "string", default: "." },
  },
});

const { notes: notesFile, path, line: lineText, text: said, asking, edited = [], html, repo } = values;
if (notesFile === undefined || path === undefined || lineText === undefined || said === undefined || edited.length > 0 && html === undefined) {
  console.log(
    "reply.ts --notes <review>/notes.json --path <file> --line <n> --text <what to say, in markdown> [--asking]\n" +
      "         [--html <review.html> [--repo <checkout>] --edited <file> [--edited <file> ...]]",
  );
  process.exit(1);
}
const line = Number(lineText);

/** the files edited for the note, as links to each where its edit landed */
const editedList = (): string => {
  if (edited.length === 0 || html === undefined) {
    return "";
  }
  const shell = readShell(html);
  const review = reviewOfNotes(shell, notesFile, html);
  const place = editPlaceOf(resolve(repo), shell, review, readingOf(notesFile, path, line));
  const where = place.kind === "disk" ? "" : ` (held on \`${place.branch}\`, not committed)`;
  return `\n\n**Edited**${where}\n${edited.map((file) => `- [\`${file}\`](${editLink(shell, review, place, file)})`).join("\n")}`;
};
const text = `${said}${editedList()}`;

const notes: Notes =
  existsSync(notesFile) ? (JSON.parse(readFileSync(notesFile, "utf8")) as Notes) : {};

const forPath = (notes[path] ??= []);
let note = forPath.find((candidate) => candidate.line === line);
if (note === undefined) {
  note = { line, messages: [] };
  forPath.push(note);
}
if (note.messages === undefined) {
  note.messages = note.text === undefined ? [] : [{ from: "reviewer", text: note.text }];
  delete note.text;
}

note.messages.push({ from: "agent", text, ...(asking === true ? { asking: true } : {}) });
forPath.sort((left, right) => left.line - right.line);

writeFileSync(notesFile, JSON.stringify(notes, null, 2), "utf8");
console.log(`replied on ${path}:${line}`);
