import { useLayoutEffect, useRef, useState } from "preact/hooks";

import { awaitingReply, messagesOf, noteAt, notesStore, sayOnNote } from "../notes.ts";
import { offlineStore } from "../offline.ts";
import { useStore } from "../stores.ts";

/** what has been typed but not sent, so a redraw mid-sentence loses nothing */
const drafts = new Map<string, string>();

/** threads collapsed down after being closed - a poll's redraw remounts every
    zone, and must not reopen one the reviewer put away */
const closedThreads = new Set<string>();

/** the one line whose box should take the caret on this draw */
let focusLine: number | undefined;

export const focusNoteOnLine = (line: number): void => {
  focusLine = line;
};

export type NoteZoneProps = {
  path: string;
  line: number;
  /** the zone is finished with: rebuild them */
  done: () => void;
};

/**
 * the note ui that sits in a monaco view zone under its line: the thread so
 * far, and a box that is always open, because replying is the point rather
 * than a mode you have to enter
 */
export const NoteZone = ({ path, line, done }: NoteZoneProps) => {
  useStore(notesStore);
  const offline = useStore(offlineStore);
  const messages = messagesOf(noteAt(path, line));
  const draftKey = `${path}:${line}`;
  const [draft, setDraft] = useState(drafts.get(draftKey) ?? "");
  const [isClosed, setIsClosed] = useState(() => closedThreads.has(draftKey));
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // only the box just opened takes the caret - a poll redrawing every zone must
  // not steal it from wherever you are typing
  useLayoutEffect(() => {
    if (focusLine !== line) {
      return;
    }
    focusLine = undefined;
    // monaco puts a zone's dom into the document on its own render frame, not
    // when the zone is added, and focusing an element that is not in the
    // document yet does nothing at all - so ask until it takes
    let attempts = 0;
    const takeCaret = () => {
      const textarea = textareaRef.current;
      if (textarea === null) {
        return;
      }
      textarea.focus();
      if (document.activeElement !== textarea && (attempts += 1) < 10) {
        requestAnimationFrame(takeCaret);
      }
    };
    takeCaret();
  }, [line]);

  const send = () => {
    sayOnNote(path, line, draft);
    drafts.delete(draftKey);
    focusLine = line;
    done();
  };

  const type = (value: string) => {
    drafts.set(draftKey, value);
    setDraft(value);
  };

  const closeConversation = () => {
    closedThreads.add(draftKey);
    setIsClosed(true);
  };

  const reopen = () => {
    closedThreads.delete(draftKey);
    setIsClosed(false);
  };

  // the zone's own dom node belongs to monaco, which writes an inline display
  // onto it - so the layout lives on a wrapper of ours inside it
  if (isClosed) {
    return (
      <div class="note-zone note-zone-closed">
        <button type="button" class="note-reopen" onClick={reopen}>
          {messages.length} note{messages.length === 1 ? "" : "s"} · reopen
        </button>
      </div>
    );
  }

  return (
    <div class="note-zone">
      {messages.length > 0 && (
        <div class="note-thread">
          {messages.map((message, index) => (
            <p class={`note-message note-from-${message.from}`} key={index}>
              <span class="note-who">{message.from === "agent" ? "agent" : "you"}</span>
              {message.text}
            </p>
          ))}
          {awaitingReply(messages) &&
            (offline ?
              <div class="note-pending">
                <span>saved locally — an agent will pick this up later</span>
              </div>
            : <div class="note-pending">
                <span class="dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span>the agent is on it — the reply lands here</span>
              </div>)}
        </div>
      )}

      <textarea
        ref={textareaRef}
        rows={2}
        value={draft}
        placeholder={
          messages.length > 0 ? "reply…"
            // line 0 is a whole-file note: images have no lines to note on
          : line === 0 ? "note on this file — ask for a change, or say what you think"
          : `note on line ${line} — ask for a change, or say what you think`
        }
        onInput={(event) => type(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            send();
          }
        }}
      />

      <div class="note-actions">
        <button type="button" onClick={send}>
          Send
        </button>
        {messages.length === 0 ?
          <button
            type="button"
            onClick={() => {
              drafts.delete(draftKey);
              done();
            }}
          >
            Cancel
          </button>
        : <button type="button" onClick={closeConversation}>
            Close conversation
          </button>
        }
        <span class="note-stamp">
          {line === 0 ? "whole file" : `line ${line}`} · ⌘↵ sends
        </span>
      </div>
    </div>
  );
};
