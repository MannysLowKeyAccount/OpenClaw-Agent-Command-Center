import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        // Run test files sequentially to avoid shared-disk-state conflicts
        // (auth tests share ~/.openclaw/.credentials on disk)
        sequence: {
            concurrent: false,
        },
        pool: "forks",
        poolOptions: {
            forks: {
                singleFork: true,
            },
        },
    },
});
