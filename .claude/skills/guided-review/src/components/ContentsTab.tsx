import { type ReadingState } from "../readingState.ts";

export type ContentsTabProps = { state: ReadingState };

/**
 * The way back to the contents, on the edge it lives on rather than up in the
 * header: closed, the sidebar leaves nothing behind to say it exists, and a
 * button at the far end of the toolbar is a long way from the thing it opens.
 * It shows only while the contents is closed - open, the sidebar is its own
 * evidence, and closing is a control inside it.
 */
export const ContentsTab = ({ state }: ContentsTabProps) => {
  if (state.showContents) {
    return null;
  }
  return (
    <button
      type="button"
      class="contents-tab"
      aria-expanded={false}
      aria-controls="contents"
      title="Show the contents"
      onClick={() => state.setShowContents(true)}
    >
      Contents
    </button>
  );
};
