import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { YamlEditor, type YamlEditorHandle } from "./YamlEditor";

afterEach(cleanup);
// jsdom has no layout: the editor measures text ranges, so give it empty ones.
Range.prototype.getClientRects ??= () =>
  Object.assign([], { item: () => null }) as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

/** The editor in a page: its value shown back, its hint, and a control after it. */
function Page({ initial, handle }: { initial: string; handle?: React.Ref<YamlEditorHandle> }) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <p id="hint">Tab moves to the next control.</p>
      <YamlEditor
        ref={handle}
        id="yaml"
        label="Definition YAML"
        value={value}
        onChange={setValue}
        describedBy="hint"
      />
      <button type="button" onClick={() => setValue("loaded: true\n")}>
        Load
      </button>
      <pre aria-label="Value">{value}</pre>
    </>
  );
}

const box = () => screen.getByRole("textbox", { name: "Definition YAML" });
const value = () => screen.getByLabelText("Value").textContent;

describe("YamlEditor", () => {
  it("is a labelled, described, multi-line text box showing its value with line numbers", () => {
    render(<Page initial={"a: 1\nb: 2\nc: 3\n"} />);
    expect(box()).toHaveAttribute("aria-multiline", "true");
    expect(box()).toHaveAccessibleDescription("Tab moves to the next control.");
    expect(box()).toHaveTextContent("a: 1b: 2c: 3");
    for (const n of ["1", "2", "3"]) expect(screen.getByText(n)).toBeVisible();
    expect(screen.getByText("Line 1, column 1")).toBeVisible();
  });

  it("reports what the author pastes, and shows a value set from outside", async () => {
    const user = userEvent.setup();
    render(<Page initial={"a: 1\n"} />);
    await user.click(box());
    await user.keyboard("{Control>}a{/Control}");
    await user.paste("form:\n  title: x\n");
    expect(value()).toBe("form:\n  title: x\n");
    expect(box()).toHaveTextContent("form: title: x");
    await user.click(screen.getByRole("button", { name: "Load" }));
    await waitFor(() => expect(box()).toHaveTextContent("loaded: true"));
  });

  it("undoes with Ctrl+Z and indents with Ctrl+]", async () => {
    const user = userEvent.setup();
    render(<Page initial={"a: 1\n"} />);
    await user.click(box());
    await user.keyboard("{Control>}a{/Control}");
    await user.paste("key: v");
    expect(value()).toBe("key: v");
    await user.keyboard("{Control>}]{/Control}");
    expect(value()).toBe("  key: v");
    await user.keyboard("{Control>}z{/Control}");
    expect(value()).toBe("key: v");
  });

  it("never traps the keyboard: Tab moves on to the next control", async () => {
    const user = userEvent.setup();
    render(<Page initial={"a: 1\n"} />);
    box().focus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Load" })).toHaveFocus();
    expect(value()).toBe("a: 1\n");
  });

  it("goes to a line: focused there, and its position shown", () => {
    const handle = createRef<YamlEditorHandle>();
    render(<Page initial={"a: 1\nb: 2\nc: 3\n"} handle={handle} />);
    act(() => handle.current!.goToLine(3));
    expect(box()).toHaveFocus();
    expect(screen.getByText("Line 3, column 1")).toBeVisible();
  });
});
