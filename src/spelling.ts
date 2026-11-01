import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  showTooltip,
  type DecorationSet,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { nonProse } from "./core";

/** The desktop app's spell checker, bound to one language. */
export interface SpellService {
  check: (text: string) => Promise<[number, number][]>;
  suggest: (word: string) => Promise<string[]>;
  add: (word: string) => Promise<void>;
}

/** The text with LaTeX blanked out by spaces, so every offset still matches the source. */
export function proseOnly(text: string) {
  let prose = "";
  let last = 0;
  for (const [from, to] of nonProse(text)) {
    prose += text.slice(last, from) + " ".repeat(to - from);
    last = to;
  }
  return prose + text.slice(last);
}

const setMisspellings = StateEffect.define<[number, number][]>();
const recheck = StateEffect.define<null>();
const openMenu = StateEffect.define<{
  from: number;
  to: number;
  suggestions: string[];
} | null>();
const underline = Decoration.mark({ class: "cm-misspelled" });
// Whole documents are checked up to this size; longer ones around the visible lines.
const wholeLimit = 300_000;

const misspellings = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const effect of tr.effects)
      if (effect.is(setMisspellings))
        value = Decoration.set(
          effect.value.map(([from, to]) => underline.range(from, to)),
          true,
        );
    return value;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export function spellChecking(service: () => SpellService | null): Extension {
  const menu = StateField.define<Tooltip | null>({
    create: () => null,
    update(value, tr) {
      for (const effect of tr.effects)
        if (effect.is(openMenu)) return effect.value && menuAt(effect.value);
      return tr.docChanged || tr.selection ? null : value;
    },
    provide: (field) => showTooltip.from(field),
  });
  function menuAt(at: {
    from: number;
    to: number;
    suggestions: string[];
  }): Tooltip {
    return {
      pos: at.from,
      create(view) {
        const dom = document.createElement("div");
        dom.className = "cm-spelling-menu";
        dom.setAttribute("role", "menu");
        const word = view.state.sliceDoc(at.from, at.to);
        const item = (label: string, run: () => void, kind = "") => {
          const button = document.createElement("button");
          button.textContent = label;
          button.className = kind;
          button.setAttribute("role", "menuitem");
          button.onmousedown = (e) => e.preventDefault();
          button.onclick = run;
          dom.append(button);
        };
        for (const suggestion of at.suggestions)
          item(suggestion, () =>
            view.dispatch({
              changes: { from: at.from, to: at.to, insert: suggestion },
              effects: openMenu.of(null),
            }),
          );
        if (!at.suggestions.length) {
          const none = document.createElement("span");
          none.textContent = "No suggestions";
          dom.append(none);
        }
        item(
          `Add “${word}” to dictionary`,
          () => {
            view.dispatch({ effects: openMenu.of(null) });
            void service()
              ?.add(word)
              .then(() => view.dispatch({ effects: recheck.of(null) }));
          },
          "secondary",
        );
        return { dom };
      },
    };
  }
  const checker = ViewPlugin.fromClass(
    class {
      timer = 0;
      gone = false;
      constructor(readonly view: EditorView) {
        this.schedule(50);
      }
      update(update: ViewUpdate) {
        const asked = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(recheck)),
        );
        if (update.docChanged || asked) this.schedule(asked ? 0 : 600);
        else if (update.viewportChanged && update.state.doc.length > wholeLimit)
          this.schedule(300);
      }
      schedule(delay: number) {
        clearTimeout(this.timer);
        this.timer = window.setTimeout(() => void this.run(), delay);
      }
      async run() {
        const spell = service();
        if (!spell) return;
        const { doc } = this.view.state;
        let start = 0;
        let end = doc.length;
        if (doc.length > wholeLimit) {
          const { from, to } = this.view.viewport;
          start = doc.lineAt(Math.max(0, from - 5000)).from;
          end = doc.lineAt(Math.min(doc.length, to + 5000)).to;
        }
        try {
          const found = await spell.check(proseOnly(doc.sliceString(start, end)));
          // An edit while checking schedules another check; this result would be stale.
          if (this.gone || this.view.state.doc !== doc) return;
          this.view.dispatch({
            effects: setMisspellings.of(
              found.map(([from, to]): [number, number] => [start + from, start + to]),
            ),
          });
        } catch {
          // Spelling is a convenience; a missing dictionary must not disturb writing.
        }
      }
      destroy() {
        this.gone = true;
        clearTimeout(this.timer);
      }
    },
  );
  const rightClick = EditorView.domEventHandlers({
    contextmenu(event, view) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;
      let hit = null as { from: number; to: number } | null;
      view.state.field(misspellings).between(pos, pos, (from, to) => {
        hit = { from, to };
      });
      const spell = service();
      if (!hit || !spell) return false;
      const { from, to } = hit;
      event.preventDefault();
      void spell
        .suggest(view.state.sliceDoc(from, to))
        .catch(() => [])
        .then((suggestions) =>
          view.dispatch({ effects: openMenu.of({ from, to, suggestions }) }),
        );
      return true;
    },
    keydown(event, view) {
      if (event.key === "Escape" && view.state.field(menu))
        view.dispatch({ effects: openMenu.of(null) });
      return false;
    },
  });
  return [
    misspellings,
    menu,
    checker,
    rightClick,
    // This checker replaces the browser's, which only checks words as they are typed.
    EditorView.contentAttributes.of({ spellcheck: "false" }),
  ];
}
