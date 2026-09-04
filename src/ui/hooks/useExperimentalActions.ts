import { useEffect, useState } from "react";

const STORAGE_KEY = "aw-experimental-actions";
const CHANGE_EVENT = "aw-experimental-actions-change";

function readExperimentalActions(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function useExperimentalActions(): boolean {
  const [experimental, setExperimental] = useState(readExperimentalActions);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const refresh = () => setExperimental(readExperimentalActions());
    window.addEventListener("storage", refresh);
    window.addEventListener(CHANGE_EVENT, refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(CHANGE_EVENT, refresh);
    };
  }, []);

  return experimental;
}

export function setExperimentalActions(on: boolean): void {
  if (typeof window === "undefined") return;

  try {
    if (on) {
      window.localStorage.setItem(STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }

  window.dispatchEvent(new Event(CHANGE_EVENT));
}
