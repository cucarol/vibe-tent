import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

export function MarkdownEditor(props: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSave?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(props.onChange);
  onChangeRef.current = props.onChange;
  const onSaveRef = useRef(props.onSave);
  onSaveRef.current = props.onSave;

  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: props.value,
        extensions: [
          history(),
          keymap.of([
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                onSaveRef.current?.();
                return true;
              },
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown(),
          EditorView.lineWrapping,
          EditorState.readOnly.of(Boolean(props.disabled)),
          EditorView.contentAttributes.of({ "aria-label": "Markdown 正文编辑器" }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": { height: "100%" },
            ".cm-scroller": { overflow: "auto", fontFamily: "var(--tn-font-ui)" },
            ".cm-content": { padding: "14px 16px 56px", caretColor: "var(--tn-color-accent)" },
            ".cm-line": { padding: "0" },
            ".cm-gutters": { display: "none" },
            "&.cm-focused": { outline: "none" },
            ".cm-activeLine": { backgroundColor: "var(--tn-color-hover)" },
            ".cm-selectionBackground, ::selection": { backgroundColor: "var(--tn-color-selected) !important" },
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [props.disabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === props.value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: props.value } });
  }, [props.value]);

  return (
    <div
      ref={hostRef}
      className="tn-markdown-editor"
      data-testid="focus-markdown-editor"
    />
  );
}
