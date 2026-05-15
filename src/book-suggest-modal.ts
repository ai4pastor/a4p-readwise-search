import { App, prepareFuzzySearch, SuggestModal } from "obsidian";
import { BookOption } from "./filters";

interface BookChoice {
  id: number | null;
  label: string;
}

export class BookSuggestModal extends SuggestModal<BookChoice> {
  private items: BookChoice[];
  private onPick: (id: number | null) => void;

  constructor(
    app: App,
    books: BookOption[],
    onPick: (id: number | null) => void,
  ) {
    super(app);
    this.onPick = onPick;
    this.items = [
      { id: null, label: "(전체 책)" },
      ...books.map((b) => ({ id: b.id, label: b.label })),
    ];
    this.setPlaceholder("책 제목/저자 검색...");
  }

  getSuggestions(query: string): BookChoice[] {
    const q = query.trim();
    if (!q) return this.items;
    const fuzzy = prepareFuzzySearch(q);
    const matches: { item: BookChoice; score: number }[] = [];
    for (const item of this.items) {
      const r = fuzzy(item.label);
      if (r) matches.push({ item, score: r.score });
    }
    matches.sort((a, b) => b.score - a.score);
    return matches.map((m) => m.item);
  }

  renderSuggestion(item: BookChoice, el: HTMLElement): void {
    el.setText(item.label);
  }

  onChooseSuggestion(item: BookChoice): void {
    this.onPick(item.id);
  }
}
