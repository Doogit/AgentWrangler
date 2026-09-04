import { useId, useState } from "react";
import Chip, { KIND_TOOLTIP, type ChipProps } from "./Chip";

const CHIP_KINDS = Object.keys(KIND_TOOLTIP) as Array<ChipProps["kind"]>;

export default function ChipLegend() {
  const [isOpen, setIsOpen] = useState(false);
  const panelId = useId();

  return (
    <div className="chip-legend">
      <button
        className="chip-legend-toggle"
        type="button"
        aria-controls={panelId}
        aria-expanded={isOpen}
        onClick={() => setIsOpen((open) => !open)}
      >
        ℹ what do these chips mean?
      </button>
      {isOpen && (
        <section className="chip-legend-panel" id={panelId} aria-label="Chip meanings">
          <ul className="chip-legend-list">
            {CHIP_KINDS.map((kind) => (
              <li className="chip-legend-item" key={kind}>
                <Chip kind={kind} />
                <span>{KIND_TOOLTIP[kind]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
