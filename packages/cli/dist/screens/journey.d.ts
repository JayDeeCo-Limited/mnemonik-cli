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
}
export interface CustomizeItem {
    value: string;
    label: string;
    checked: boolean;
}
export declare const completedStep: (step: number, text: string) => string;
export declare const completedLine: (text: string) => string;
export declare const INSTALLATION_STOPPED = "Installation stopped.";
export declare const ADD_ANOTHER_FOLDER = "To connect a folder somewhere else, run mnemonik add <folder>.";
export declare const stepProgress: (output: Output, interactive: boolean, text: string) => {
    complete(result: string): void;
    stop(): void;
};
export declare function renderCustomize(items: CustomizeItem[], output: Output, cursor?: number): number;
/** Browser-owned account, CLI and scanner choices are announced, never duplicated here. */
export declare function renderJourney(screen: string, output: Output, v?: JourneyValues): number;
export declare function renderInterrupted(output: Output): void;
export declare function renderRollbackResult(removed: boolean, output: Output): void;
interface SignalSource {
    on(event: 'SIGINT' | 'SIGHUP', listener: () => void): unknown;
    off(event: 'SIGINT' | 'SIGHUP', listener: () => void): unknown;
    emit?(event: 'SIGINT' | 'SIGHUP'): boolean;
}
export declare function journeyAnswers(input: Readable, output?: Pick<Output, 'line' | 'write'>, options?: {
    interrupt?: (signal: 'SIGINT' | 'SIGHUP') => void;
    signals?: SignalSource;
}): {
    choose(choices: string[], fallback?: number): Promise<string>;
    customize(items: CustomizeItem[]): Promise<"Back" | "Cancel" | {
        selected: string[];
    }>;
    text(): Promise<string | undefined>;
    close(): void;
};
export {};
//# sourceMappingURL=journey.d.ts.map