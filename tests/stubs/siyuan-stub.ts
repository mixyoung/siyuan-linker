// Minimal stand-in for the "siyuan" package used only by unit tests.
// The real package ships type-only exports and cannot be resolved at runtime.
export class Setting {
    static lastOptions: any = null;
    items: unknown[] = [];

    constructor(public options: any) {
        Setting.lastOptions = options;
    }

    addItem(itemOptions: unknown): void {
        this.items.push(itemOptions);
    }

    open(_name: string): void {}
}

export class Plugin {}
