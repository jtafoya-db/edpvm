// The YAML editor (#201): a thin, replaceable wrapper around CodeMirror 6.
// It knows nothing about EIR definitions: every check is the server's. It
// gives YAML syntax highlighting, line numbers, automatic indentation (Enter
// keeps and adds indentation; Ctrl/Cmd+] and Ctrl/Cmd+[ indent and outdent),
// undo history, the caret's line and column, and `goToLine`, which the
// workspace's problem list uses. Tab is left unbound, so it always moves to
// the next control: the editor never traps keyboard focus.
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import {
  defaultHighlightStyle,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";

export interface YamlEditorHandle {
  /** Put the caret at the start of a 1-based line and focus the editor. */
  goToLine(line: number): void;
}

interface Props {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** IDs of text that describes the editor (its hint). */
  describedBy?: string;
  /** Read-only while what it holds is being saved: still focusable and selectable. */
  readOnly?: boolean;
}

const lockedIf = (readOnly: boolean): Extension =>
  readOnly
    ? [EditorState.readOnly.of(true), EditorView.contentAttributes.of({ "aria-readonly": "true" })]
    : [];

const theme = EditorView.theme({
  "&": {
    border: "1px solid var(--color-gray-cool-50)",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--font-size-2xs)",
    background: "var(--surface-default, #fff)",
  },
  "&.cm-focused": { outline: "3px solid var(--theme-focus, #2491ff)", outlineOffset: "0" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono, ui-monospace, monospace)",
    lineHeight: 1.5,
    minHeight: "420px",
    maxHeight: "640px",
  },
  ".cm-gutters": { background: "var(--color-gray-cool-2, #f1f3f6)", border: "none" },
});

/** 1-based line and column of the main selection's head. */
function caretOf(state: EditorState) {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, column: head - line.from + 1 };
}

export const YamlEditor = forwardRef<YamlEditorHandle, Props>(function YamlEditor(
  { id, label, value, onChange, describedBy, readOnly = false },
  ref,
) {
  const parent = useRef<HTMLDivElement>(null);
  const lock = useRef(new Compartment());
  const view = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [caret, setCaret] = useState({ line: 1, column: 1 });
  const labelId = `${id}-label`;

  useEffect(() => {
    const editor = new EditorView({
      parent: parent.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          history(),
          indentOnInput(),
          indentUnit.of("  "),
          EditorState.tabSize.of(2),
          yaml(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          // No indentWithTab: Tab moves focus on, as everywhere else on the page.
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.contentAttributes.of({
            id,
            "aria-labelledby": labelId,
            ...(describedBy ? { "aria-describedby": describedBy } : {}),
            spellcheck: "false",
            autocapitalize: "off",
            autocorrect: "off",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
            if (update.docChanged || update.selectionSet) setCaret(caretOf(update.state));
          }),
          theme,
          lock.current.of(lockedIf(readOnly)),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Built once; `value` is kept in step below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    view.current?.dispatch({ effects: lock.current.reconfigure(lockedIf(readOnly)) });
  }, [readOnly]);

  // A value set from outside (a loaded definition) replaces the document.
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value) {
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    }
  }, [value]);

  useImperativeHandle(ref, () => ({
    goToLine(line) {
      const editor = view.current;
      if (!editor) return;
      const target = editor.state.doc.line(Math.min(Math.max(line, 1), editor.state.doc.lines));
      editor.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
      editor.focus();
    },
  }));

  return (
    <div>
      <span
        id={labelId}
        style={{
          display: "block",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--font-size-2xs)",
          fontWeight: 700,
          marginBottom: 6,
        }}
      >
        {label}
      </span>
      <div ref={parent} />
      <p
        style={{
          margin: "4px 0 0",
          fontFamily: "var(--font-sans)",
          fontSize: "var(--font-size-3xs, 12px)",
          color: "var(--text-muted)",
        }}
      >
        Line {caret.line}, column {caret.column}
      </p>
    </div>
  );
});
