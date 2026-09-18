import { type ComponentChildren } from "preact";
import { useRef } from "preact/hooks";

export type SelectControlProps = {
  label: string;
  ariaLabel: string;
  value: string;
  onChange: (value: string) => void;
  class?: string;
  children: ComponentChildren;
};

/** a native select dressed as one of the header's controls, its label text
    inside the same clickable box */
export const SelectControl = ({
  label,
  ariaLabel,
  value,
  onChange,
  class: className = "",
  children,
}: SelectControlProps) => {
  const selectRef = useRef<HTMLSelectElement>(null);
  return (
    <label
      class={`control select ${className}`}
      onClick={(event) => {
        // a native select only opens its popup for a click landing on its
        // own (text-sized) box - clicking the rest of the label's
        // clickable-looking rectangle would otherwise just focus it.
        // showPicker() isn't in Safari yet, so there it only focuses too
        const select = selectRef.current;
        if (select !== null && event.target !== select) {
          if (typeof select.showPicker === "function") {
            select.showPicker();
          } else {
            select.focus();
          }
        }
      }}
    >
      <span>{label}</span>
      <select
        ref={selectRef}
        value={value}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        {children}
      </select>
    </label>
  );
};
