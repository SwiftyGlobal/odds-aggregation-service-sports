/**
 * Choose a single display_name for fs_pre_selections from linked provider rows.
 * Prefer the lowest provider_id among included (post–outlier removal) providers.
 */
export function pickDisplayNameForPreSelection(
    displayNameByProviderId: Record<number, string | null | undefined>,
    includedProviderIds: number[],
    optionKeyFallback: string
): string {
    for (const pid of [...includedProviderIds].sort((a, b) => a - b)) {
        const name = displayNameByProviderId[pid];
        if (typeof name === 'string' && name.trim().length > 0) {
            return name.trim();
        }
    }
    return optionKeyFallback;
}
