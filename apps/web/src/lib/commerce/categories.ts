/** Category helpers shared by every admin screen that offers a category select. */

export interface CategoryNode {
  id: string;
  name: string;
  parent: string | null;
}

/** Categories as a parent-then-child list, so the select reads like the tree. */
export function orderCategories(categories: CategoryNode[]): { id: string; label: string }[] {
  const byParent = new Map<string | null, CategoryNode[]>();
  for (const category of categories) {
    const siblings = byParent.get(category.parent ?? null) ?? [];
    siblings.push(category);
    byParent.set(category.parent ?? null, siblings);
  }

  const out: { id: string; label: string }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const category of byParent.get(parent) ?? []) {
      out.push({ id: category.id, label: `${"— ".repeat(depth)}${category.name}` });
      walk(category.id, depth + 1);
    }
  };
  walk(null, 0);

  // Anything whose parent is outside the list (inactive, filtered) would be
  // invisible otherwise.
  for (const category of categories) {
    if (!out.some((entry) => entry.id === category.id)) {
      out.push({ id: category.id, label: category.name });
    }
  }
  return out;
}
