import { simplifyNbt } from './minecraft.js';
import { parseTextComponent, renderTextComponent, textComponent } from './text.js';
const snapshot = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { bigint: String(item) } : item);

export function bookContent(slot) {
  const nbt = simplifyNbt(slot?.nbtData) || {};
  const component = slot?.components?.find((entry) => entry.type === 'written_book_content' || entry.type === 'writable_book_content');
  const data = component?.data;
  const rawPages = data ? data.pages : nbt.pages, title = data?.rawTitle ?? nbt.title, author = data?.author ?? nbt.author;
  return { pages: Array.isArray(rawPages) ? rawPages.slice(0, 100).map(page => data ? page?.content ?? '' : page) : [], title: typeof title === 'string' ? title : '', author: typeof author === 'string' ? author : '', generation: data?.generation ?? nbt.generation ?? 0 };
}

export class BookDraft {
  constructor(slot, { hand = 0, hotbarSlot = 0, editable = false } = {}) {
    const content = bookContent(slot);
    this.itemId = slot.itemId; this.inventorySlot = hand === 1 ? 40 : hotbarSlot; this.protocolHand = hand;
    this.editable = editable; this.pages = content.pages.slice(0, 100).map((page) => editable ? String(page) : page); if (!this.pages.length) this.pages.push('');
    this.title = content.title; this.author = content.author; this.page = 0; this.modified = false; this.signing = false;
    this.original = snapshot(content);
  }
  text() { return this.editable ? this.pages[this.page] : textComponent(this.pages[this.page]); }
  component() { return this.editable ? { text: this.pages[this.page] } : parseTextComponent(this.pages[this.page]); }
  render(element, options = {}) { return renderTextComponent(element, this.component(), options); }
  pageIndicator() { return { translate: 'book.pageIndicator', fallback: 'Page %1$s of %2$s', with: [this.page + 1, this.pages.length] }; }
  byAuthor() { return { translate: 'book.byAuthor', fallback: 'by %1$s', with: [String(this.author)] }; }
  setPage(text) { const value = String(text).slice(0, 1023); if (value !== this.pages[this.page]) { this.modified = true; this.pages[this.page] = value; } }
  next() { if (this.page + 1 >= this.pages.length && this.editable && this.pages.length < 100) this.pages.push(''); this.page = Math.min(this.pages.length - 1, this.page + 1); }
  previous() { this.page = Math.max(0, this.page - 1); }
  matches(slot) { return slot?.present && slot.itemId === this.itemId && snapshot(bookContent(slot)) === this.original; }
  packet(sign = false) {
    if (!this.editable || !this.modified && !sign) return null;
    const pages = this.pages.map(String); while (pages.length && pages.at(-1) === '') pages.pop();
    const title = sign ? this.title.trim().slice(0, 15) : undefined;
    if (sign && !title) return null;
    return { hand: this.inventorySlot, pages, title };
  }
}
