/// <reference types="vite/client" />

/** Pre-JS boot overlay handle exposed by index.html's inline script. */
interface AwBoot {
  /** Fade out and remove the boot overlay; safe to call more than once. */
  reveal(): void;
}

interface Window {
  __awBoot?: AwBoot;
}
