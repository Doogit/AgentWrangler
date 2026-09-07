import { type ReactNode, useEffect, useRef } from "react";

/** Native modal semantics keep background controls inert and keyboard focus inside. */
export default function Modal({
  children,
  labelledBy,
  onCancel,
}: {
  children: ReactNode;
  labelledBy: string;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const dialog = ref.current;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      className="settings-modal"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      {children}
    </dialog>
  );
}
