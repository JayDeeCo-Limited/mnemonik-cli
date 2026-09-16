import type { Readable } from 'node:stream';
import type { Output } from '../output.js';
export interface JourneyValues {
    hosts?: string[];
    project?: string;
    node?: string;
    os?: string;
    files?: string[];
    total?: number | null;
    completed?: number | null;
    skipped?: string;
    remaining?: number;
    reason?: string;
    connected?: boolean;
}
/** Browser-owned account, CLI and scanner choices are announced, never duplicated here. */
export declare function renderJourney(screen: string, output: Output, v?: JourneyValues): void;
export declare function journeyAnswers(input: Readable): {
    choose(choices: string[], fallback?: number): Promise<string>;
    text(): Promise<string | undefined>;
    close(): void;
};
//# sourceMappingURL=journey.d.ts.map