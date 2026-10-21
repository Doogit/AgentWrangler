import assert from "node:assert/strict";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { mockSession, mockSessionStory } from "../../../src/ui/api/fixtures";
import {
  FilesEditedCard,
  SessionFactsCard,
  splitPath,
} from "../../../src/ui/sessions/SessionOverview";

afterEach(() => cleanup());

const fixture = mockSession("session-demo").data;
assert(fixture !== null);
const session = { ...fixture, hygiene_flags: [], turns_to_first_commit: 7, deep_abandoned: false };

describe("splitPath", () => {
  it("keeps a repo path's full dir and trims an outside path to its last two dirs", () => {
    expect(splitPath("src/ui/a.ts")).toEqual({ dir: "src/ui/", name: "a.ts", outside: false });
    expect(splitPath("D:\\work\\tmp\\scratch\\n.md")).toEqual({
      dir: "…/tmp/scratch/",
      name: "n.md",
      outside: true,
    });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md", outside: false });
  });
});

describe("SessionFactsCard", () => {
  it("lists commits, turns to first commit and no flags", () => {
    render(<SessionFactsCard session={session} story={mockSessionStory("session-demo")} />);
    expect(screen.getByTestId("story-commits").textContent).toBe("a1b2c3d0f9e8d7");
    expect(screen.getByTestId("turns-to-first-commit").textContent).toBe("7");
    expect(screen.getByTestId("deep-abandoned").textContent).toBe("No");
    expect(screen.getByTestId("session-facts").textContent).toContain("Hygiene flags");
    expect(screen.getByText("None")).toBeTruthy();
  });

  it("says no commit, shows flags, and a dash when the story is missing", () => {
    render(
      <SessionFactsCard
        session={{
          ...session,
          turns_to_first_commit: null,
          hygiene_flags: ["LONG_FULL_CONTEXT"],
          deep_abandoned: true,
        }}
        story={null}
      />,
    );
    expect(screen.getByTestId("story-commits").textContent).toBe("—");
    expect(screen.getByTestId("turns-to-first-commit").textContent).toBe("—/no commit");
    expect(screen.getByText("Long session near context limit")).toBeTruthy();
    expect(screen.getByTestId("deep-abandoned").textContent).toContain("NO OBSERVED COMMIT");
  });

  it("says None observed when the story has no commits", () => {
    const story = mockSessionStory("session-demo");
    story.commits = [];
    render(<SessionFactsCard session={session} story={story} />);
    expect(screen.getByTestId("story-commits").textContent).toBe("None observed");
  });
});

describe("FilesEditedCard", () => {
  function storyWith(files: Array<{ path: string; edits: number }>) {
    const story = mockSessionStory("session-demo");
    story.files_touched = files;
    return story;
  }

  it("splits repo and outside files with a bar relative to the most-edited file", () => {
    render(
      <FilesEditedCard
        story={storyWith([
          { path: "src/a/b.ts", edits: 4 },
          { path: "test/c.ts", edits: 1 },
          { path: "D:/work/tmp/scratch/n.md", edits: 2 },
        ])}
      />,
    );
    const card = screen.getByTestId("files-edited");
    expect(card.textContent).toContain("3 files · 7 edits");
    const inside = within(screen.getByTestId("story-files")).getAllByRole("listitem");
    expect(inside.map((li) => li.title)).toEqual(["src/a/b.ts", "test/c.ts"]);
    const outside = within(screen.getByTestId("story-files-outside")).getAllByRole("listitem");
    expect(outside.map((li) => li.title)).toEqual(["D:/work/tmp/scratch/n.md"]);
    expect(outside[0]?.textContent).toContain("…/tmp/scratch/");
    // 4/4 → 5 cells, 1/4 → 1, 2/4 → 3 (2.5 rounds up).
    const lit = [...inside, ...outside].map((li) => li.querySelectorAll("i.on").length);
    expect(lit).toEqual([5, 1, 3]);
    expect(inside[0]?.textContent).toContain("4 edits");
  });

  it.each([
    ["no edits", storyWith([]), "No file edits observed."],
    [
      "a gone transcript",
      { ...storyWith([]), transcript_available: false },
      "Transcript no longer on disk, so edits can't be read.",
    ],
    ["a missing story", null, "Unavailable — the session story did not load."],
  ])("explains %s instead of listing files", (_name, story, message) => {
    render(<FilesEditedCard story={story} />);
    expect(screen.getByTestId("files-edited").textContent).toContain(message);
    expect(screen.queryByTestId("story-files")).toBeNull();
  });
});
