/**
 * String similarity utilities for matching provider data.
 * Sport-agnostic — uses Dice coefficient + word-overlap for robust entity matching.
 */

import * as stringSimilarity from 'string-similarity';

export class StringSimilarity {
    /**
     * Calculate similarity between two strings using multiple algorithms
     */
    static calculateSimilarity(str1: string, str2: string): number {
        if (!str1 || !str2) return 0;

        // Normalize strings
        const normalized1 = this.normalizeString(str1);
        const normalized2 = this.normalizeString(str2);

        if (normalized1 === normalized2) return 1.0;

        // Use Dice coefficient for better performance on short strings
        const diceSimilarity = stringSimilarity.compareTwoStrings(normalized1, normalized2);

        // Additional word-level overlap check for multi-word names
        const wordOverlapSimilarity = this.calculateWordOverlapSimilarity(normalized1, normalized2);

        // Return the higher of the two similarities
        return Math.max(diceSimilarity, wordOverlapSimilarity);
    }

    /**
     * Normalize string for comparison
     */
    private static normalizeString(str: string): string {
        return str
            .toLowerCase()
            .trim()
            .replace(/[^\w\s]/g, '') // Remove punctuation
            .replace(/\s+/g, ' ') // Normalize whitespace
            .replace(/\b(the|a|an)\b/g, '') // Remove common articles
            .trim();
    }

    /**
     * Calculate similarity using word-level overlap and substring matching.
     * Useful when names share significant words but character-level algorithms score low.
     */
    private static calculateWordOverlapSimilarity(str1: string, str2: string): number {
        // Extract meaningful words (length > 2)
        const words1 = str1.split(' ').filter(word => word.length > 2);
        const words2 = str2.split(' ').filter(word => word.length > 2);

        if (words1.length === 0 || words2.length === 0) return 0;

        // Check for exact word matches
        const commonWords = words1.filter(word => words2.includes(word));
        const wordSimilarity = commonWords.length / Math.max(words1.length, words2.length);

        // Check for partial matches (substrings)
        let partialMatches = 0;
        for (const word1 of words1) {
            for (const word2 of words2) {
                if (word1.includes(word2) || word2.includes(word1)) {
                    partialMatches++;
                    break;
                }
            }
        }
        const partialSimilarity = partialMatches / Math.max(words1.length, words2.length);

        // Return the higher similarity
        return Math.max(wordSimilarity, partialSimilarity);
    }

    /**
     * Check if two strings are likely the same entity
     */
    static isLikelyMatch(str1: string, str2: string, threshold: number = 0.8): boolean {
        return this.calculateSimilarity(str1, str2) >= threshold;
    }

    /**
     * Find the best match from a list of candidates
     */
    static findBestMatch(
        target: string,
        candidates: string[],
        threshold: number = 0.8
    ): { match: string; similarity: number } | null {
        let bestMatch: string | null = null;
        let bestSimilarity = 0;

        for (const candidate of candidates) {
            const similarity = this.calculateSimilarity(target, candidate);
            if (similarity > bestSimilarity && similarity >= threshold) {
                bestMatch = candidate;
                bestSimilarity = similarity;
            }
        }

        return bestMatch ? { match: bestMatch, similarity: bestSimilarity } : null;
    }
}
