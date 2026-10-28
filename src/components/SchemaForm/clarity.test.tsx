import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { loadSchema } from "../../schema";
import { edpWidgets, SchemaForm } from "./index";

afterEach(cleanup);

describe("SchemaForm provider clarity", () => {
  it("starts meaningful answers blank and exposes anchored keyboard help without shifting fields", () => {
    render(
      <SchemaForm
        schema={loadSchema()}
        widgets={edpWidgets}
        dynamicOptions={{ domains: [{ value: "filing", label: "Filing" }] }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: /tell us about the initiative/i })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /^source system/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /target domain/i })).toBeNull();
    expect(screen.getByRole("combobox", { name: /data sensitivity/i })).toBeTruthy();

    const help = screen.getByRole("button", { name: "Help for Initiative name" });
    expect(help.querySelector("svg.usa-icon use")?.getAttribute("href")).toBe(
      "/assets/img/sprite.svg#help_outline",
    );
    expect(help.textContent).toBe("");
    expect(help.getAttribute("aria-controls")).toBe("intake-dataName-help");
    fireEvent.click(help);
    expect(help.getAttribute("aria-expanded")).toBe("true");
    const popover = screen.getByRole("dialog", { name: "About Initiative name" });
    expect(popover.textContent).toMatch(/initiative is the project/i);
    expect(popover.style.position).toBe("fixed");
    expect(help.parentElement?.previousElementSibling?.tagName).toBe("LABEL");
    expect(help.parentElement?.parentElement?.style.display).toBe("flex");
    expect(document.activeElement).toBe(popover);
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(help.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(help);
  });

  it("keeps access initiative-level and asks for context on a consultation path", () => {
    render(
      <SchemaForm
        schema={loadSchema()}
        widgets={edpWidgets}
        dynamicOptions={{ domains: [{ value: "filing", label: "Filing" }] }}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole("textbox", { name: /initiative name/i }), {
      target: { value: "Case signals" },
    });
    fireEvent.click(screen.getByRole("radio", { name: /myself/i }));
    fireEvent.change(screen.getByRole("combobox", { name: /data sensitivity/i }), {
      target: { value: "SBU" },
    });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: /another tool/i }));
    expect(screen.getByRole("textbox", { name: /proposed data access approach/i })).toBeTruthy();
  });
});
