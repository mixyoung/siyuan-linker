export function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[character] ?? character);
}

export function buildConfirmationList(items: string[], question: string): string {
    const listItems = items
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => `<li>${escapeHtml(item)}</li>`)
        .join("");
    return `<ul class="siyuan-linker-confirm-list">${listItems}</ul>`
        + `<p class="siyuan-linker-confirm-question">${escapeHtml(question.trim())}</p>`;
}

export function awaitConfirmation(
    open: (confirm: () => void, cancel: () => void) => void,
): Promise<boolean> {
    return new Promise((resolve) => open(
        () => resolve(true),
        () => resolve(false),
    ));
}
