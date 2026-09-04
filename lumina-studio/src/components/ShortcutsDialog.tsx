import { Modal } from "./ui";

const GROUPS = [
  {
    title: "Navigate",
    shortcuts: [
      ["G", "Photo Grid"],
      ["E", "Detail view"],
      ["D", "Develop"],
      ["← / →", "Previous / next photo"],
      ["Tab", "Hide side panels"],
    ],
  },
  {
    title: "Remove",
    shortcuts: [
      ["H", "Show / hide tool overlays"],
      ["A", "Visualize Spots"],
      ["[ / ]", "Decrease / increase brush size"],
      ["/", "Try another source"],
      ["Delete", "Delete selected repair"],
      ["Esc", "Deselect repair"],
    ],
  },
  {
    title: "Edit",
    shortcuts: [
      ["R", "Crop"],
      ["O", "Cycle crop overlay"],
      ["Q", "Remove"],
      ["K", "Brush mask"],
      ["M", "Linear mask"],
      ["Shift M", "Radial mask"],
      ["\\", "Hold original"],
      ["J", "Clipping warnings"],
    ],
  },
  {
    title: "Organize",
    shortcuts: [
      ["P", "Flag as pick"],
      ["X", "Flag as reject"],
      ["U", "Remove flag"],
      ["0–5", "Set rating"],
      ["⌘ ⇧ I", "Import"],
      ["⌘ ⇧ E", "Export"],
    ],
  },
  {
    title: "History",
    shortcuts: [
      ["⌘ Z", "Undo"],
      ["⌘ ⇧ Z", "Redo"],
      ["?", "This shortcut guide"],
    ],
  },
];

export default function ShortcutsDialog({
  enabled,
  onEnabledChange,
  onClose,
}: {
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onClose: () => void;
}) {
  return (
    <Modal
      title="Keyboard shortcuts"
      description="Context-aware controls for moving quickly through a photo session."
      onClose={onClose}
      size="large"
      footer={
        <button type="button" className="button button--primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <label className="shortcut-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
        />
        <span>
          <strong>Single-key editing shortcuts</strong>
          <small>
            Turn these off to prevent letter and number keys from triggering
            actions. Command/Ctrl shortcuts stay available.
          </small>
        </span>
      </label>
      <div className="shortcut-groups">
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.shortcuts.map(([shortcut, action]) => (
                <div key={shortcut}>
                  <dt>
                    {shortcut.split(" ").map((key) => (
                      <kbd key={key}>{key}</kbd>
                    ))}
                  </dt>
                  <dd>{action}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
