/**
 * SPDX-FileCopyrightText: 2025 Jens A. Koch
 * SPDX-License-Identifier: MIT
 */

/**
 * Timer
 *
 * Timer is a class for measuring execution time with checkpoints.
 * It uses the performance API for high-resolution timing.
 *
 * @see https://developer.mozilla.org/de/docs/Web/API/Window/performance
 *
 * Example usage:
 *
 * // Basic usage
 * const timer = new Timer("PHP Script");
 * runPhp(script);
 * console.log(timer.stop()); // { totalTime: ..., checkpoints: [...] }
 *
 * // Using checkpoints
 * const timer = new Timer("Task Processing");
 * step1();
 * timer.checkpoint("Step 1 completed");
 * step2();
 * timer.checkpoint("Step 2 completed");
 * console.log(timer.stop());
 *
 * // Static method for measuring synchronous function execution
 * const result = Timer.measure(() => runPhp(script), "PHP Execution");
 * console.log(result); // { totalTime: ..., checkpoints: [] }
 *
 * // Static method for measuring async function execution
 * const result = await Timer.measureAsync(() => fetchData(), "Fetching Data");
 * console.log(result); // { totalTime: ..., checkpoints: [] }
 */

class Timer {
    constructor(label = "Timer") {
        this.label = label;
        this.startMark = `${label}-start`;
        this.checkpoints = [];
        performance.mark(this.startMark);
    }

    /**
     * Formats time in milliseconds to a human-readable string
     * @param {number} ms - Time in milliseconds
     * @param {string} [unit='ms'] - Unit to use ('ms' or 's')
     * @returns {string} Formatted time string
     */
    static formatTime(ms, unit = 'ms') {
        if (!Number.isFinite(ms)) {
            throw new Error('Invalid time value provided');
        }

        const time = unit === 's' ? ms / 1000 : ms;

        /*if (time >= 3600000) {
            const hours = Math.floor(time / 3600000);
            const minutes = Math.floor((time % 3600000) / 60000);
            const seconds = Math.floor((time % 60000) / 1000);
            return `${hours}h ${minutes}m ${seconds}s`;
        } else*/

        if (time >= 60000) {
            const minutes = Math.floor(time / 60000);
            const seconds = Math.floor((time % 60000) / 1000);
            return `${minutes}m ${seconds}s`;
        }

        if (time >= 1000) {
            const seconds = Math.floor(time / 1000);
            const milliseconds = Math.floor(time % 1000);
            return `${seconds}s ${milliseconds}ms`;
        }

        return `${Math.round(time)}ms`;
    }

    checkpoint(name = `Checkpoint ${this.checkpoints.length + 1}`) {
        const checkpointMark = `${this.label}-${name}`;
        performance.mark(checkpointMark);
        performance.measure(name, this.startMark, checkpointMark);

        const time = Math.round(performance.getEntriesByName(name).pop().duration * 1000) / 1000;
        const checkpoint = { name, time };
        this.checkpoints.push(checkpoint);

        return checkpoint;
    }

    stop() {
        const stopMark = `${this.label}-stop`;
        performance.mark(stopMark);
        performance.measure(this.label, this.startMark, stopMark);

        const elapsedTime = Math.round(performance.getEntriesByName(this.label).pop().duration * 1000) / 1000;
        const result = { totalTime: elapsedTime, checkpoints: [...this.checkpoints] };

        performance.clearMarks();
        performance.clearMeasures();

        return result;
    }

    static measure(fn, label = "Execution Time") {
        const timer = new Timer(label);
        fn();
        return timer.stop();
    }

    static async measureAsync(asyncFn, label = "Async Execution Time") {
        const timer = new Timer(label);
        await asyncFn();
        return timer.stop();
    }
}

export { Timer };
