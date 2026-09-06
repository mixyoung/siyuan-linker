export type PersistedTransferMode = "exact-id-mirror" | "independent-copy";

export interface TransferModeMigration {
    transferMode: PersistedTransferMode;
    removePreserveIds: boolean;
}

export function migrateTransferModeSettings(
    loaded: Record<string, unknown> | null | undefined,
): TransferModeMigration {
    const configuredMode = loaded?.transferMode;
    const transferMode: PersistedTransferMode = configuredMode === "exact-id-mirror"
        || configuredMode === "independent-copy"
        ? configuredMode
        : loaded?.preserveIds === true
            ? "exact-id-mirror"
            : "independent-copy";

    return {
        transferMode,
        removePreserveIds: Boolean(loaded && Object.prototype.hasOwnProperty.call(loaded, "preserveIds")),
    };
}
