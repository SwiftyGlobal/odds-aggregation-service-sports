/**
 * Odds calculation utilities for aggregation
 */

export class OddsCalculation {
    /**
     * Parse fractional odds to decimal
     */
    static fractionalToDecimal(fractional: string): number | null {
        if (!fractional || fractional === 'SP' || fractional === 'N/A') return null;

        try {
            // Handle formats like "5/2", "10/3", "1/1"
            const parts = fractional.split('/');
            if (parts.length !== 2) return null;

            const numerator = parseFloat(parts[0] || '0');
            const denominator = parseFloat(parts[1] || '1');

            if (isNaN(numerator) || isNaN(denominator) || denominator === 0) return null;

            return (numerator / denominator) + 1;
        } catch (error) {
            return null;
        }
    }

    /**
     * Parse decimal odds to fractional
     */
    static decimalToFractional(decimal: number): string {
        if (decimal <= 1) return '1/1';

        const fractional = decimal - 1;
        const gcd = this.gcd(Math.round(fractional * 100), 100);

        const numerator = Math.round(fractional * 100) / gcd;
        const denominator = 100 / gcd;

        return `${numerator}/${denominator}`;
    }

    /**
     * Calculate greatest common divisor
     */
    private static gcd(a: number, b: number): number {
        return b === 0 ? a : this.gcd(b, a % b);
    }

    /**
     * Calculate average odds from multiple providers
     */
    static calculateAverage(
        odds: (number | null)[],
        method: 'arithmetic' | 'harmonic' | 'geometric' = 'arithmetic'
    ): number | null {
        const validOdds = odds.filter(odd => odd !== null && odd > 0) as number[];

        if (validOdds.length === 0) return null;

        switch (method) {
            case 'arithmetic':
                return validOdds.reduce((sum, odd) => sum + odd, 0) / validOdds.length;

            case 'harmonic':
                const harmonicSum = validOdds.reduce((sum, odd) => sum + (1 / odd), 0);
                return validOdds.length / harmonicSum;

            case 'geometric':
                const geometricProduct = validOdds.reduce((product, odd) => product * odd, 1);
                return Math.pow(geometricProduct, 1 / validOdds.length);

            default:
                return validOdds.reduce((sum, odd) => sum + odd, 0) / validOdds.length;
        }
    }

    /**
     * Find best odds (highest or lowest)
     */
    static findBest(
        odds: (number | null)[],
        method: 'highest' | 'lowest' = 'highest'
    ): number | null {
        const validOdds = odds.filter(odd => odd !== null && odd > 0) as number[];

        if (validOdds.length === 0) return null;

        if (method === 'highest') {
            return Math.max(...validOdds);
        } else {
            return Math.min(...validOdds);
        }
    }

    /**
     * Find worst odds (opposite of best)
     */
    static findWorst(
        odds: (number | null)[],
        method: 'highest' | 'lowest' = 'highest'
    ): number | null {
        const validOdds = odds.filter(odd => odd !== null && odd > 0) as number[];

        if (validOdds.length === 0) return null;

        if (method === 'highest') {
            return Math.min(...validOdds);
        } else {
            return Math.max(...validOdds);
        }
    }

    /**
     * Calculate implied probability from decimal odds
     */
    static decimalToProbability(decimal: number): number {
        if (decimal <= 1) return 1;
        return 1 / decimal;
    }

    /**
     * Calculate decimal odds from probability
     */
    static probabilityToDecimal(probability: number): number {
        if (probability <= 0 || probability >= 1) return 1;
        return 1 / probability;
    }

    /**
     * Calculate margin (overround) from odds
     */
    static calculateMargin(odds: number[]): number {
        const probabilities = odds.map(odd => this.decimalToProbability(odd));
        const totalProbability = probabilities.reduce((sum, prob) => sum + prob, 0);
        return totalProbability - 1;
    }

    /**
     * Calculate fair odds (remove margin)
     */
    static calculateFairOdds(odds: number[]): number[] {
        const probabilities = odds.map(odd => this.decimalToProbability(odd));
        const totalProbability = probabilities.reduce((sum, prob) => sum + prob, 0);

        if (totalProbability <= 0) return odds;

        const margin = totalProbability - 1;
        const fairTotal = totalProbability - margin;

        return probabilities.map(prob => this.probabilityToDecimal(prob / fairTotal));
    }

    /**
     * Validate odds value
     */
    static isValidOdds(odds: any): boolean {
        if (odds === null || odds === undefined) return false;
        if (typeof odds === 'string') {
            const decimal = this.fractionalToDecimal(odds);
            return decimal !== null && decimal > 1;
        }
        if (typeof odds === 'number') {
            return odds > 1 && !isNaN(odds);
        }
        return false;
    }

    /**
     * Normalize odds to decimal format
     */
    static normalizeToDecimal(odds: any): number | null {
        if (typeof odds === 'number') {
            return this.isValidOdds(odds) ? odds : null;
        }
        if (typeof odds === 'string') {
            return this.fractionalToDecimal(odds);
        }
        return null;
    }

    /**
     * Calculate odds change percentage
     */
    static calculateChangePercentage(oldOdds: number, newOdds: number): number {
        if (oldOdds <= 0 || newOdds <= 0) return 0;
        return ((newOdds - oldOdds) / oldOdds) * 100;
    }

    /**
     * Check if odds are within acceptable range
     */
    static isWithinRange(odds: number, minOdds: number = 1.01, maxOdds: number = 1000): boolean {
        return odds >= minOdds && odds <= maxOdds;
    }
}
