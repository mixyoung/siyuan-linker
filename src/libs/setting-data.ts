export function collectPassthroughData(
    data: Record<string, unknown>,
    knownKeys: Iterable<string>,
): Record<string, unknown> {
    const known = new Set(knownKeys);
    return Object.fromEntries(Object.entries(data).filter(([key]) => !known.has(key)));
}

export function mergeSettingsData(
    passthroughData: Record<string, unknown>,
    settings: Iterable<[string, { type: string; value: unknown }]>,
): Record<string, unknown> {
    const data: Record<string, unknown> = { ...passthroughData };
    for (const [key, item] of settings) {
        if (item.type !== "button") data[key] = item.value;
    }
    return data;
}
